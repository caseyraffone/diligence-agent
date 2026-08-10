import {
  ActorType,
  AuthorityLevel,
  ClaimStatus,
  ConsentScope,
  EvidenceRelation,
  EvidenceScope,
  SourceCheckResult,
  StatementType,
  type ExtractedClaim,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { ConsentRequiredError } from '@/lib/errors';
import { adaptersForClaim, getAdapter } from '@/adapters/registry';
import type { AdapterClaimInput } from '@/adapters/types';
import { assertActorMayAssign } from '@/domain/claimStatus';
import { isAbsenceResult, proposeStatus, relationForResult, statementTypeForResult } from '@/domain/authority';
import { getObjectStore } from '@/providers/storage';

/**
 * MODULE 2 — EVIDENCE VERIFIER
 *
 * Builds a verification plan per claim from the source hierarchy, runs the
 * approved adapters, and records what each source said.
 *
 * Two hard gates live here:
 *
 *  1. CONSENT. No external source is contacted until a ConsentRecord for
 *     EXTERNAL_PUBLIC_SOURCES exists and is unrevoked. This is enforced in
 *     code, not documented as a policy, because "we forgot to check consent" is
 *     the kind of failure that ends a deployment.
 *
 *  2. NO CONCLUSIONS. The verifier writes evidence and may move a claim only to
 *     PARTIALLY_CORROBORATED, UNABLE_TO_VERIFY, or HUMAN_REVIEW_REQUIRED.
 *     VERIFIED, CORROBORATED, and CONFLICTING_INFORMATION are refused by
 *     `assertActorMayAssign` — those are human decisions.
 */

export interface VerificationPlanStep {
  adapterKey: string;
  adapterName: string;
  authorityLevel: AuthorityLevel;
  integrationStatus: string;
  rationale: string;
}

export interface VerificationPlan {
  claimId: string;
  steps: VerificationPlanStep[];
  /** Present when no automated channel applies. */
  manualChannelNote: string | null;
}

/**
 * Produces the ordered plan for a claim: most authoritative source first,
 * limited to what the case's policy template approves.
 */
export function buildVerificationPlan(claim: ExtractedClaim, approvedSourceKeys: string[]): VerificationPlan {
  const input = toAdapterInput(claim);
  const adapters = adaptersForClaim(input, approvedSourceKeys);

  const steps: VerificationPlanStep[] = adapters.map((adapter) => ({
    adapterKey: adapter.key,
    adapterName: adapter.name,
    authorityLevel: adapter.authorityLevel,
    integrationStatus: adapter.integrationStatus,
    rationale:
      adapter.integrationStatus === 'LIVE_CAPABLE'
        ? `${adapter.name} can be queried directly for this claim type.`
        : `${adapter.name} is the right channel for this claim type, but production access requires setup — ` +
          'this check runs against recorded fixtures until then.',
  }));

  const manualChannelNote =
    steps.length === 0
      ? 'No approved automated source covers this claim type. Verification for this claim proceeds by reviewer ' +
        'outreach to the issuing organisation, or by a structured interview where the claim describes a personal ' +
        'contribution that no record could confirm.'
      : null;

  return { claimId: claim.id, steps, manualChannelNote };
}

export interface RunSourceCheckInput {
  claimId: string;
  organizationId: string;
  adapterKey: string;
  actorUserId: string | null;
  actorType: ActorType;
}

export interface RunSourceCheckResult {
  sourceCheckId: string;
  result: SourceCheckResult;
  evidenceCreated: boolean;
  proposedStatus: ClaimStatus;
  requiresHumanDecision: boolean;
}

export async function runSourceCheck(input: RunSourceCheckInput): Promise<RunSourceCheckResult> {
  const claim = await prisma.extractedClaim.findFirstOrThrow({
    where: { id: input.claimId, organizationId: input.organizationId },
    include: { case: { include: { applicant: true } } },
  });

  await assertExternalConsent(claim.caseId);

  const adapter = getAdapter(input.adapterKey);
  if (!adapter) throw new Error(`Unknown source adapter: ${input.adapterKey}`);

  const started = Date.now();
  const outcome = await adapter.check({
    claim: toAdapterInput(claim),
    applicantName: claim.case.applicant.displayName,
  });

  // Raw payloads go to object storage, not into the row: they can be large and
  // they are subject to the same retention rules as the documents.
  let rawResponseKey: string | null = null;
  if (outcome.raw !== undefined) {
    rawResponseKey = `cases/${claim.caseId}/source-checks/${claim.id}-${adapter.key}-${Date.now()}.json`;
    await getObjectStore().put({
      key: rawResponseKey,
      body: Buffer.from(JSON.stringify(outcome.raw, null, 2), 'utf8'),
      contentType: 'application/json',
    });
  }

  const sourceCheck = await prisma.sourceCheck.create({
    data: {
      organizationId: input.organizationId,
      caseId: claim.caseId,
      claimId: claim.id,
      adapterKey: adapter.key,
      query: {
        category: claim.category,
        organizationName: claim.organizationName,
        title: claim.title,
        normalizedText: claim.normalizedText,
      },
      url: outcome.url,
      retrievedAt: outcome.retrievedAt,
      excerpt: outcome.excerpt,
      authorityLevel: outcome.authorityLevel,
      result: outcome.result,
      detail: outcome.detail,
      rawResponseKey,
      latencyMs: Date.now() - started,
      isLive: outcome.isLive,
    },
  });

  // Absence results become NEUTRAL system observations — a record that we
  // looked — never conflicting evidence. This is the single line that keeps
  // "we found nothing" from turning into "this is false".
  const relation = relationForResult(outcome.result);
  const statementType = statementTypeForResult(outcome.result, outcome.authorityLevel);

  // An organisation-existence adapter speaks only to the organisation, so its
  // evidence is scoped out of the status proposal. See EvidenceScope.
  const scope =
    adapter.verifies === 'ORGANIZATION_EXISTENCE' ? EvidenceScope.ORGANIZATION_CONTEXT : EvidenceScope.CLAIM;

  await prisma.evidenceItem.create({
    data: {
      organizationId: input.organizationId,
      caseId: claim.caseId,
      claimId: claim.id,
      relation,
      scope,
      statementType,
      authorityLevel: outcome.authorityLevel,
      summary: summarize(adapter.name, outcome.result, scope),
      detail: outcome.detail,
      sourceCheckId: sourceCheck.id,
      createdByUserId: input.actorUserId,
    },
  });

  const proposal = await recomputeClaimProposal(claim.id, input.organizationId);

  await recordAudit({
    organizationId: input.organizationId,
    caseId: claim.caseId,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    action: 'SOURCE_CHECK_RUN',
    entityType: 'ExtractedClaim',
    entityId: claim.id,
    metadata: {
      adapterKey: adapter.key,
      result: outcome.result,
      isLive: outcome.isLive,
      authorityLevel: outcome.authorityLevel,
      sourceCheckId: sourceCheck.id,
    },
  });

  return {
    sourceCheckId: sourceCheck.id,
    result: outcome.result,
    evidenceCreated: true,
    proposedStatus: proposal.proposedStatus,
    requiresHumanDecision: proposal.requiresHumanDecision,
  };
}

/**
 * Recomputes the system's *proposal* for a claim from all attached evidence and
 * applies it only when it is a status the system is permitted to assign.
 */
export async function recomputeClaimProposal(
  claimId: string,
  organizationId: string,
): Promise<{ proposedStatus: ClaimStatus; requiresHumanDecision: boolean; rationale: string }> {
  const claim = await prisma.extractedClaim.findFirstOrThrow({
    where: { id: claimId, organizationId },
    include: { evidenceItems: true },
  });

  const proposal = proposeStatus(
    claim.evidenceItems.map((e) => ({
      relation: e.relation,
      statementType: e.statementType,
      authorityLevel: e.authorityLevel,
      scope: e.scope,
    })),
  );

  // A reviewer's recorded decision is never overwritten by a later automated
  // recomputation. New evidence surfaces as a proposal for them to act on.
  const hasHumanDecision = await prisma.reviewerDecision.count({ where: { claimId } });

  if (hasHumanDecision === 0) {
    const target = proposal.requiresHumanDecision ? ClaimStatus.HUMAN_REVIEW_REQUIRED : proposal.proposedStatus;
    try {
      assertActorMayAssign('SYSTEM', target);
      if (claim.status !== target && claim.status !== ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED) {
        await prisma.extractedClaim.update({ where: { id: claimId }, data: { status: target } });
      }
    } catch {
      // Defensive: if the proposal is not system-assignable, route to a human
      // rather than failing the pipeline.
      await prisma.extractedClaim.update({
        where: { id: claimId },
        data: { status: ClaimStatus.HUMAN_REVIEW_REQUIRED },
      });
    }
  }

  return proposal;
}

/** Consent gate for any outbound verification activity. */
export async function assertExternalConsent(caseId: string): Promise<void> {
  const consent = await prisma.consentRecord.findFirst({
    where: { caseId, scope: ConsentScope.EXTERNAL_PUBLIC_SOURCES, revokedAt: null },
  });
  if (!consent) throw new ConsentRequiredError('external source verification');
}

export async function hasConsent(caseId: string, scope: ConsentScope): Promise<boolean> {
  const consent = await prisma.consentRecord.findFirst({ where: { caseId, scope, revokedAt: null } });
  return Boolean(consent);
}

/**
 * Attaches applicant-supplied material as evidence. It enters at authority
 * level 6 and is typed as an applicant statement, so it can support a claim but
 * can never on its own carry it to "verified".
 */
export async function attachApplicantEvidence(input: {
  organizationId: string;
  caseId: string;
  claimId: string;
  documentId?: string;
  clarificationResponseId?: string;
  summary: string;
  detail: string;
  actorUserId: string | null;
}): Promise<string> {
  const evidence = await prisma.evidenceItem.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId,
      claimId: input.claimId,
      relation: EvidenceRelation.SUPPORTING,
      statementType: StatementType.APPLICANT_STATEMENT,
      authorityLevel: AuthorityLevel.L6_APPLICANT_PROVIDED,
      summary: input.summary,
      detail: input.detail,
      documentId: input.documentId ?? null,
      clarificationResponseId: input.clarificationResponseId ?? null,
      createdByUserId: input.actorUserId,
    },
  });

  await recomputeClaimProposal(input.claimId, input.organizationId);
  return evidence.id;
}

function summarize(adapterName: string, result: SourceCheckResult, scope: EvidenceScope): string {
  // Organisation-scoped evidence must never be summarised as confirming the
  // claim. "GLEIF confirms this claim" would tell a reviewer the internship
  // checked out, when all that was confirmed is that the firm exists.
  if (scope === EvidenceScope.ORGANIZATION_CONTEXT) {
    switch (result) {
      case SourceCheckResult.MATCH:
        return `${adapterName} confirms the organisation exists and is registered. It does not address the applicant's engagement there.`;
      case SourceCheckResult.PARTIAL_MATCH:
        return `${adapterName} found a similarly named organisation, but not close enough to be certain it is the same one.`;
      case SourceCheckResult.RECORD_NOT_FOUND:
        return `${adapterName} holds no entry for this organisation. Its register does not cover every legitimate organisation.`;
      default:
        return `${adapterName} could not be consulted about this organisation.`;
    }
  }

  switch (result) {
    case SourceCheckResult.MATCH:
      return `${adapterName} confirms this claim.`;
    case SourceCheckResult.PARTIAL_MATCH:
      return `${adapterName} confirms part of this claim.`;
    case SourceCheckResult.NO_MATCH:
      return `${adapterName} holds a record that differs from this claim.`;
    case SourceCheckResult.RECORD_NOT_FOUND:
      return `${adapterName} holds no record of this claim (evidence gap, not a negative finding).`;
    case SourceCheckResult.SOURCE_UNAVAILABLE:
      return `${adapterName} could not be reached.`;
    case SourceCheckResult.INCONCLUSIVE:
      return `${adapterName} returned a record too ambiguous to attribute.`;
    case SourceCheckResult.ERROR:
      return `${adapterName} returned an error.`;
  }
}

export function toAdapterInput(claim: ExtractedClaim): AdapterClaimInput {
  return {
    id: claim.id,
    category: claim.category,
    normalizedText: claim.normalizedText,
    sourcePassage: claim.sourcePassage,
    personName: claim.personName,
    organizationName: claim.organizationName,
    title: claim.title,
    startDate: claim.startDate,
    endDate: claim.endDate,
    amountValue: claim.amountValue ? Number(claim.amountValue) : null,
    amountUnit: claim.amountUnit,
  };
}

export { isAbsenceResult };
