import { DiscrepancyStatus, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { analyzeConsistency, type AnalyzableClaim, type AnalyzableDocument, type Finding } from '@/domain/consistency';
import type { Precision } from '@/lib/dates';

/**
 * MODULE 3 (orchestration) — CONSISTENCY AND DOCUMENT INTEGRITY ANALYST
 *
 * Loads a case, runs the pure rules in `domain/consistency.ts`, and reconciles
 * the findings with what is already stored.
 *
 * Reconciliation matters: re-running analysis must not resurrect a discrepancy
 * a reviewer already explained or dismissed, and must not create duplicates.
 * The stable `ruleKey` is what makes a finding identical across runs, and it is
 * unique per case in the database.
 */

export interface AnalyzeCaseResult {
  created: number;
  reopened: number;
  autoClosed: number;
  total: number;
}

export async function analyzeCase(input: {
  caseId: string;
  organizationId: string;
  actorUserId: string | null;
  asOf?: Date;
}): Promise<AnalyzeCaseResult> {
  const [claims, documents, sourceChecks, existing] = await Promise.all([
    prisma.extractedClaim.findMany({
      where: { caseId: input.caseId, organizationId: input.organizationId },
      include: { document: { select: { id: true, filename: true, kind: true } } },
    }),
    prisma.applicationDocument.findMany({
      where: { caseId: input.caseId, organizationId: input.organizationId },
      include: { pages: { orderBy: { pageNumber: 'asc' } } },
    }),
    prisma.sourceCheck.findMany({ where: { caseId: input.caseId, organizationId: input.organizationId } }),
    prisma.discrepancy.findMany({ where: { caseId: input.caseId, organizationId: input.organizationId } }),
  ]);

  const analyzableClaims: AnalyzableClaim[] = claims.map((c) => ({
    id: c.id,
    documentId: c.documentId,
    documentName: c.document.filename,
    documentKind: c.document.kind,
    pageNumber: c.pageNumber,
    category: c.category,
    normalizedText: c.normalizedText,
    sourcePassage: c.sourcePassage,
    organizationName: c.organizationName,
    title: c.title,
    startDate: c.startDate,
    endDate: c.endDate,
    datePrecision: c.datePrecision as Precision,
    isFullTimeCommitment: c.isFullTimeCommitment,
    amountValue: c.amountValue ? Number(c.amountValue) : null,
    amountUnit: c.amountUnit,
  }));

  const analyzableDocs: AnalyzableDocument[] = documents.map((d) => ({
    id: d.id,
    filename: d.filename,
    kind: d.kind,
    sha256: d.sha256,
    text: d.pages.map((p) => p.text).join('\n'),
    metadata: readMetadata(d.integritySignals),
  }));

  const findings = analyzeConsistency({
    claims: analyzableClaims,
    documents: analyzableDocs,
    sourceChecks: sourceChecks.map((s) => ({
      claimId: s.claimId,
      adapterKey: s.adapterKey,
      result: s.result,
      excerpt: s.excerpt,
      detail: s.detail ?? '',
    })),
    asOf: input.asOf,
  });

  const byRuleKey = new Map(existing.map((d) => [d.ruleKey, d]));
  const foundKeys = new Set(findings.map((f) => f.ruleKey));

  let created = 0;
  let reopened = 0;
  let autoClosed = 0;

  for (const finding of findings) {
    const prior = byRuleKey.get(finding.ruleKey);

    if (!prior) {
      await createDiscrepancy(finding, input.caseId, input.organizationId);
      created++;
      continue;
    }

    // A reviewer's resolution stands. Re-detecting the same observation does
    // not undo their judgement — that would let the machine overrule a human.
    if (
      prior.status === DiscrepancyStatus.RESOLVED ||
      prior.status === DiscrepancyStatus.DISMISSED_NOT_AN_ISSUE ||
      prior.status === DiscrepancyStatus.EXPLAINED
    ) {
      continue;
    }

    await prisma.discrepancy.update({
      where: { id: prior.id },
      data: { title: finding.title, description: finding.description, severity: finding.severity },
    });
    reopened++;
  }

  // A finding that no longer reproduces — because a claim was corrected or a
  // document removed — is closed with an explanation rather than deleted, so
  // the history of what was observed survives.
  for (const prior of existing) {
    if (foundKeys.has(prior.ruleKey)) continue;
    if (prior.status !== DiscrepancyStatus.OPEN && prior.status !== DiscrepancyStatus.UNDER_REVIEW) continue;

    await prisma.discrepancy.update({
      where: { id: prior.id },
      data: {
        status: DiscrepancyStatus.RESOLVED,
        resolutionNote:
          'This observation no longer reproduces after the case was re-analysed. The underlying claim or document ' +
          'has changed since it was first recorded.',
        resolvedAt: new Date(),
      },
    });
    autoClosed++;
  }

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: 'SYSTEM',
    actorUserId: input.actorUserId,
    action: 'CONSISTENCY_ANALYSIS_RUN',
    entityType: 'Case',
    entityId: input.caseId,
    metadata: { created, reopened, autoClosed, findings: findings.length },
  });

  return { created, reopened, autoClosed, total: findings.length };
}

async function createDiscrepancy(finding: Finding, caseId: string, organizationId: string): Promise<void> {
  await prisma.discrepancy.create({
    data: {
      organizationId,
      caseId,
      kind: finding.kind,
      severity: finding.severity,
      status: DiscrepancyStatus.OPEN,
      title: finding.title,
      description: finding.description,
      claimIds: finding.claimIds,
      documentIds: finding.documentIds,
      ruleKey: finding.ruleKey,
      detectedBy: 'SYSTEM',
    },
  });
}

/** Flattens stored integrity signals into the flat map the rules expect. */
function readMetadata(signals: Prisma.JsonValue): Record<string, unknown> {
  if (!Array.isArray(signals)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of signals) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (record['kind'] === 'FILE_METADATA' && record['values'] && typeof record['values'] === 'object') {
        Object.assign(out, record['values']);
      }
    }
  }
  return out;
}
