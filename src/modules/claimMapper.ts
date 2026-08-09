import { ClaimCategory, ClaimStatus, DatePrecision, ExtractionOrigin, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { redact } from '@/lib/redaction';
import { parseDateToken } from '@/lib/dates';
import { runStructured } from '@/providers/llm/client';
import { ClaimExtractionResponseSchema, CLAIM_EXTRACTION_HINT, type ExtractedClaimPayload } from '@/providers/llm/schemas';
import { scanForInjectionAttempts } from '@/providers/llm/prompt';

/**
 * MODULE 1 — CLAIM MAPPER
 *
 * Turns document pages into structured, independently verifiable claims, each
 * citing the document and page it came from so a reviewer can check the
 * system's reading against the original.
 *
 * The model's role stops at reading and structuring. Every claim lands in
 * PENDING_VERIFICATION; the mapper cannot set any other status. Dates are
 * re-parsed here by deterministic code rather than trusted from the model,
 * because everything downstream — overlaps, timelines, duration arithmetic —
 * depends on them being right.
 */

export interface MapClaimsInput {
  caseId: string;
  documentId: string;
  organizationId: string;
  actorUserId: string | null;
}

export interface MapClaimsResult {
  claimsCreated: number;
  observations: Array<{ observation: string; whyItMayMatter: string }>;
  injectionAttemptsDetected: number;
}

const MAX_PASSAGE = 2000;

export async function mapClaimsForDocument(input: MapClaimsInput): Promise<MapClaimsResult> {
  const document = await prisma.applicationDocument.findFirstOrThrow({
    where: { id: input.documentId, organizationId: input.organizationId },
    include: { pages: { orderBy: { pageNumber: 'asc' } } },
  });

  const observations: MapClaimsResult['observations'] = [];
  let created = 0;
  let injectionAttempts = 0;

  for (const page of document.pages) {
    if (!page.text.trim()) continue;

    // Detect before extraction so the observation is recorded even if the model
    // call fails. This is a signal for a human, never a filter or a verdict.
    const injectionHits = scanForInjectionAttempts(page.text);
    injectionAttempts += injectionHits.length;

    const response = await runStructured({
      task: 'EXTRACT_CLAIMS',
      instruction:
        'Extract every independently verifiable factual claim about the applicant from the supplied document page. ' +
        'Include education, degrees, employment, awards, research positions, publications, athletics, certifications, ' +
        'volunteering, projects and ventures, and quantitative claims such as revenue, users, funds raised, hours, ' +
        'rankings, or team size. Quote the exact source passage for each claim. Do not infer anything not stated.',
      untrusted: [{ label: `${document.filename} page ${page.pageNumber}`, content: page.text }],
      schema: ClaimExtractionResponseSchema,
      schemaName: 'ClaimExtractionResponse',
      schemaHint: CLAIM_EXTRACTION_HINT,
    });

    observations.push(...response.data.documentObservations);

    for (const claim of response.data.claims) {
      await persistClaim(claim, {
        caseId: input.caseId,
        organizationId: input.organizationId,
        documentId: document.id,
        pageNumber: page.pageNumber,
      });
      created++;
    }
  }

  await prisma.applicationDocument.update({
    where: { id: document.id },
    data: {
      // Observations are stored on the document, visible to reviewers, and are
      // explicitly not treated as findings by any downstream rule.
      integritySignals: [
        ...(Array.isArray(document.integritySignals) ? (document.integritySignals as Prisma.JsonArray) : []),
        ...observations.map((o) => ({
          kind: 'EXTRACTION_OBSERVATION',
          observation: o.observation,
          whyItMayMatter: o.whyItMayMatter,
          detectedAt: new Date().toISOString(),
        })),
      ] as Prisma.InputJsonValue,
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: 'SYSTEM',
    actorUserId: input.actorUserId,
    action: 'CLAIMS_EXTRACTED',
    entityType: 'ApplicationDocument',
    entityId: document.id,
    metadata: {
      claimsCreated: created,
      pages: document.pages.length,
      observations: observations.length,
      injectionAttemptsDetected: injectionAttempts,
    },
  });

  return { claimsCreated: created, observations, injectionAttemptsDetected: injectionAttempts };
}

interface PersistContext {
  caseId: string;
  organizationId: string;
  documentId: string;
  pageNumber: number;
}

async function persistClaim(payload: ExtractedClaimPayload, context: PersistContext): Promise<void> {
  // Belt and braces: the page text was redacted on ingest, but a model could
  // echo an identifier from a region we did not catch. Redact again on write.
  const sourcePassage = redact(payload.sourcePassage).text.slice(0, MAX_PASSAGE);
  const normalizedText = redact(payload.normalizedText).text.slice(0, 500);

  // Dates are re-derived deterministically. The model proposes; date.ts decides.
  const start = payload.startDate ? parseDateToken(payload.startDate) : null;
  const end = payload.endDate ? parseDateToken(payload.endDate) : null;

  await prisma.extractedClaim.create({
    data: {
      organizationId: context.organizationId,
      caseId: context.caseId,
      documentId: context.documentId,
      pageNumber: context.pageNumber,
      sourcePassage,
      normalizedText,
      category: payload.category as ClaimCategory,
      personName: payload.personName,
      organizationName: payload.organizationName,
      title: payload.title,
      location: payload.location,
      startDate: start?.date ?? null,
      // Store the end of the stated period so range arithmetic is inclusive.
      endDate: end?.upperBound ?? null,
      datePrecision: mapPrecision(payload.datePrecision, start?.precision),
      amountValue: payload.amountValue !== null ? new Prisma.Decimal(payload.amountValue) : null,
      amountUnit: payload.amountUnit,
      isObjectivelyVerifiable: payload.isObjectivelyVerifiable,
      isFullTimeCommitment: payload.impliesFullTimeCommitment,
      // Extraction confidence describes reading accuracy. It is stored for
      // triage of low-quality parses and is never used as evidence.
      extractionConfidence: payload.extractionConfidence,
      origin: ExtractionOrigin.MODEL,
      // The mapper cannot assign anything else. Verification has not happened.
      status: ClaimStatus.PENDING_VERIFICATION,
    },
  });
}

function mapPrecision(declared: string, derived: string | undefined): DatePrecision {
  const value = derived ?? declared;
  switch (value) {
    case 'DAY':
      return DatePrecision.DAY;
    case 'MONTH':
      return DatePrecision.MONTH;
    case 'YEAR':
      return DatePrecision.YEAR;
    case 'RANGE_APPROXIMATE':
      return DatePrecision.RANGE_APPROXIMATE;
    default:
      return DatePrecision.UNKNOWN;
  }
}

/**
 * Records a reviewer's edit to a claim without erasing the original extraction.
 * The prior values are kept in ClaimRevision, so the report can always show
 * what the system read versus what a human corrected.
 */
export async function reviseClaim(input: {
  claimId: string;
  organizationId: string;
  userId: string;
  changes: Prisma.ExtractedClaimUpdateInput;
  reason: string;
}): Promise<void> {
  const before = await prisma.extractedClaim.findFirstOrThrow({
    where: { id: input.claimId, organizationId: input.organizationId },
  });

  await prisma.$transaction(async (tx) => {
    const after = await tx.extractedClaim.update({
      where: { id: input.claimId },
      data: {
        ...input.changes,
        origin: before.origin === ExtractionOrigin.MODEL ? ExtractionOrigin.MODEL_EDITED_BY_HUMAN : before.origin,
      },
    });

    await tx.claimRevision.create({
      data: {
        claimId: input.claimId,
        userId: input.userId,
        before: toJson(before),
        after: toJson(after),
        reason: input.reason,
      },
    });

    await recordAudit(
      {
        organizationId: input.organizationId,
        caseId: before.caseId,
        actorType: 'USER',
        actorUserId: input.userId,
        action: 'CLAIM_EDITED',
        entityType: 'ExtractedClaim',
        entityId: input.claimId,
        metadata: { reason: input.reason },
      },
      tx,
    );
  });
}

function toJson(claim: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(claim, (_k, v) => {
      if (v instanceof Date) return v.toISOString();
      if (v && typeof v === 'object' && 'toFixed' in (v as object)) return String(v);
      return v;
    }),
  ) as Prisma.InputJsonValue;
}
