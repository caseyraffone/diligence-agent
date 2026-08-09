import { AuthorityLevel, EvidenceRelation, SourceCheckResult, StatementType, ClaimStatus } from '@prisma/client';

/**
 * The source hierarchy and the evidence-to-status proposal logic.
 *
 * Nothing in this file assigns a status. It produces a *proposal* that a
 * reviewer sees and acts on. The strongest thing the system may do on its own
 * is route a claim to HUMAN_REVIEW_REQUIRED.
 */

/** 1 is most authoritative. Ordering is what most rules actually depend on. */
export const AUTHORITY_RANK: Record<AuthorityLevel, number> = {
  [AuthorityLevel.L1_ISSUING_AUTHORITY]: 1,
  [AuthorityLevel.L2_OFFICIAL_WEBSITE]: 2,
  [AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE]: 3,
  [AuthorityLevel.L4_SIGNED_VERIFIABLE_RECORD]: 4,
  [AuthorityLevel.L5_INDEPENDENT_REPORTING]: 5,
  [AuthorityLevel.L6_APPLICANT_PROVIDED]: 6,
  [AuthorityLevel.L7_INFORMAL_SELF_PUBLISHED]: 7,
};

export const AUTHORITY_LABELS: Record<AuthorityLevel, string> = {
  [AuthorityLevel.L1_ISSUING_AUTHORITY]: '1 — Issuing organization or authoritative registry',
  [AuthorityLevel.L2_OFFICIAL_WEBSITE]: '2 — Official website of the school, employer, competition, or government',
  [AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE]: '3 — Direct confirmation from an authorized representative',
  [AuthorityLevel.L4_SIGNED_VERIFIABLE_RECORD]: '4 — Signed or cryptographically verifiable record',
  [AuthorityLevel.L5_INDEPENDENT_REPORTING]: '5 — Independent reputable reporting',
  [AuthorityLevel.L6_APPLICANT_PROVIDED]: '6 — Applicant-provided evidence',
  [AuthorityLevel.L7_INFORMAL_SELF_PUBLISHED]: '7 — Informal or self-published source',
};

export function isAtLeastAsAuthoritative(a: AuthorityLevel, b: AuthorityLevel): boolean {
  return AUTHORITY_RANK[a] <= AUTHORITY_RANK[b];
}

export function strongest(levels: AuthorityLevel[]): AuthorityLevel | null {
  if (levels.length === 0) return null;
  return levels.reduce((best, l) => (AUTHORITY_RANK[l] < AUTHORITY_RANK[best] ? l : best));
}

/**
 * Results that mean "we looked and found nothing".
 *
 * This distinction carries the whole fairness posture of the product: absence
 * of a record is *not* a negative result. A claim whose only signal is
 * RECORD_NOT_FOUND can never be proposed as conflicting.
 */
export const ABSENCE_RESULTS: ReadonlySet<SourceCheckResult> = new Set([
  SourceCheckResult.RECORD_NOT_FOUND,
  SourceCheckResult.SOURCE_UNAVAILABLE,
  SourceCheckResult.INCONCLUSIVE,
  SourceCheckResult.ERROR,
]);

export function isAbsenceResult(result: SourceCheckResult): boolean {
  return ABSENCE_RESULTS.has(result);
}

export interface EvidenceSummaryInput {
  relation: EvidenceRelation;
  statementType: StatementType;
  authorityLevel: AuthorityLevel;
}

export interface StatusProposal {
  /** What the system suggests. Advisory only. */
  proposedStatus: ClaimStatus;
  /** Plain-language justification shown next to the proposal in the UI. */
  rationale: string;
  /** True when a human must record the outcome before it becomes the status. */
  requiresHumanDecision: boolean;
}

/**
 * Proposes a status from the evidence attached to a claim.
 *
 * Deliberate properties:
 *  - Never proposes VERIFIED/CORROBORATED/CONFLICTING as an assignment; those
 *    are returned as proposals with requiresHumanDecision = true.
 *  - Applicant-provided evidence alone (L6/L7) never reaches "verified".
 *  - No supporting and no conflicting evidence yields UNABLE_TO_VERIFY, framed
 *    explicitly as an evidence gap rather than a negative finding.
 */
export function proposeStatus(evidence: EvidenceSummaryInput[]): StatusProposal {
  const supporting = evidence.filter((e) => e.relation === EvidenceRelation.SUPPORTING);
  const conflicting = evidence.filter((e) => e.relation === EvidenceRelation.CONFLICTING);

  // Only third-party and confirmed material counts toward corroboration.
  // An applicant restating their own claim is not corroboration of it.
  const independentSupport = supporting.filter(
    (e) =>
      e.statementType === StatementType.CONFIRMED_FACT || e.statementType === StatementType.THIRD_PARTY_STATEMENT,
  );

  if (conflicting.length > 0) {
    const strongestConflict = strongest(conflicting.map((e) => e.authorityLevel));
    return {
      proposedStatus: ClaimStatus.CONFLICTING_INFORMATION,
      rationale:
        `${conflicting.length} source(s) state something materially different from this claim; ` +
        `the most authoritative is ${strongestConflict ? AUTHORITY_LABELS[strongestConflict] : 'unclassified'}. ` +
        'The conflict is documented. Its cause has not been established and may be benign.',
      requiresHumanDecision: true,
    };
  }

  if (independentSupport.length === 0) {
    if (supporting.length > 0) {
      return {
        proposedStatus: ClaimStatus.PARTIALLY_CORROBORATED,
        rationale:
          'The only supporting material is applicant-provided or informal. That is consistent with the claim but ' +
          'does not independently establish it.',
        requiresHumanDecision: false,
      };
    }
    return {
      proposedStatus: ClaimStatus.UNABLE_TO_VERIFY,
      rationale:
        'No authoritative record was located through the channels available. This is an evidence gap, not a finding ' +
        'against the applicant: many legitimate achievements are not published online or in a searchable registry.',
      requiresHumanDecision: false,
    };
  }

  const best = strongest(independentSupport.map((e) => e.authorityLevel))!;

  // Direct confirmation from the issuer or an authorized representative.
  if (AUTHORITY_RANK[best] <= AUTHORITY_RANK[AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE]) {
    return {
      proposedStatus: ClaimStatus.VERIFIED,
      rationale: `Confirmed by ${AUTHORITY_LABELS[best]}. A reviewer must record this outcome.`,
      requiresHumanDecision: true,
    };
  }

  if (AUTHORITY_RANK[best] <= AUTHORITY_RANK[AuthorityLevel.L5_INDEPENDENT_REPORTING]) {
    return {
      proposedStatus: ClaimStatus.CORROBORATED,
      rationale:
        `Supported by ${AUTHORITY_LABELS[best]} without direct confirmation from the issuing organization. ` +
        'A reviewer must record this outcome.',
      requiresHumanDecision: true,
    };
  }

  return {
    proposedStatus: ClaimStatus.PARTIALLY_CORROBORATED,
    rationale: 'Supporting material exists but only at a low authority level.',
    requiresHumanDecision: false,
  };
}

/**
 * Maps a source-check result to the evidence relation it may create.
 *
 * The critical line: an absence result NEVER becomes CONFLICTING evidence. It
 * becomes a NEUTRAL system observation recording that a search was performed.
 */
export function relationForResult(result: SourceCheckResult): EvidenceRelation {
  switch (result) {
    case SourceCheckResult.MATCH:
    case SourceCheckResult.PARTIAL_MATCH:
      return EvidenceRelation.SUPPORTING;
    case SourceCheckResult.NO_MATCH:
      // The registry holds a record and it says something different. That is a
      // genuine conflict, unlike "no record exists".
      return EvidenceRelation.CONFLICTING;
    default:
      return EvidenceRelation.NEUTRAL;
  }
}

export function statementTypeForResult(result: SourceCheckResult, level: AuthorityLevel): StatementType {
  if (isAbsenceResult(result)) return StatementType.SYSTEM_OBSERVATION;
  if (AUTHORITY_RANK[level] <= AUTHORITY_RANK[AuthorityLevel.L4_SIGNED_VERIFIABLE_RECORD]) {
    return StatementType.CONFIRMED_FACT;
  }
  if (level === AuthorityLevel.L6_APPLICANT_PROVIDED) return StatementType.APPLICANT_STATEMENT;
  return StatementType.THIRD_PARTY_STATEMENT;
}
