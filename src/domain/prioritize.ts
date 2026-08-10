import { ClaimStatus, DiscrepancySeverity } from '@prisma/client';

/**
 * Case and claim prioritization for the reviewer queue.
 *
 * The system may order work by evidence gaps and unresolved inconsistencies.
 * It may not order work by anything about the person.
 *
 * The permitted input set is closed and declared below. Anything not on this
 * list — including nationality, name origin, institution prestige, country of
 * study, language, or any proxy for a protected characteristic — is not
 * accepted by these functions, because it is not a parameter they take. A test
 * asserts the input shape has not grown.
 */

export const PERMITTED_PRIORITY_FACTORS = [
  'claimsAwaitingVerification',
  'claimsUnableToVerify',
  'openDiscrepancies',
  'discrepancySeverity',
  'overdueClarifications',
  'daysUntilDue',
  'failedSourceChecks',
] as const;

export type PriorityFactor = (typeof PERMITTED_PRIORITY_FACTORS)[number];

export interface CasePriorityInput {
  claimsAwaitingVerification: number;
  claimsUnableToVerify: number;
  openDiscrepancies: number;
  highestOpenSeverity: DiscrepancySeverity | null;
  overdueClarifications: number;
  /** Null when the case has no due date. Negative when already overdue. */
  daysUntilDue: number | null;
  failedSourceChecks: number;
}

export interface PriorityBreakdown {
  score: number;
  /** Per-factor contribution, shown in the UI so the ordering is explainable. */
  contributions: Array<{ factor: PriorityFactor; points: number; explanation: string }>;
}

const SEVERITY_POINTS: Record<DiscrepancySeverity, number> = {
  [DiscrepancySeverity.INFORMATIONAL]: 0,
  [DiscrepancySeverity.REVIEW_SUGGESTED]: 8,
  [DiscrepancySeverity.REVIEW_REQUIRED]: 20,
};

/**
 * Computes an explainable priority score. Higher means "a reviewer's attention
 * would resolve more uncertainty here", never "this person is more suspicious".
 */
export function scoreCasePriority(input: CasePriorityInput): PriorityBreakdown {
  const contributions: PriorityBreakdown['contributions'] = [];

  const awaiting = Math.min(input.claimsAwaitingVerification, 40) * 2;
  if (awaiting > 0) {
    contributions.push({
      factor: 'claimsAwaitingVerification',
      points: awaiting,
      explanation: `${input.claimsAwaitingVerification} claim(s) have not been checked yet.`,
    });
  }

  const unable = Math.min(input.claimsUnableToVerify, 20) * 3;
  if (unable > 0) {
    contributions.push({
      factor: 'claimsUnableToVerify',
      points: unable,
      explanation:
        `${input.claimsUnableToVerify} claim(s) could not be checked against an available source. ` +
        'These need a reviewer to choose another channel — not a negative inference.',
    });
  }

  const open = Math.min(input.openDiscrepancies, 20) * 5;
  if (open > 0) {
    contributions.push({
      factor: 'openDiscrepancies',
      points: open,
      explanation: `${input.openDiscrepancies} unresolved inconsistency/inconsistencies between documents or sources.`,
    });
  }

  if (input.highestOpenSeverity) {
    const points = SEVERITY_POINTS[input.highestOpenSeverity];
    if (points > 0) {
      contributions.push({
        factor: 'discrepancySeverity',
        points,
        explanation: `Highest open severity is ${input.highestOpenSeverity}.`,
      });
    }
  }

  const overdue = Math.min(input.overdueClarifications, 10) * 4;
  if (overdue > 0) {
    contributions.push({
      factor: 'overdueClarifications',
      points: overdue,
      explanation: `${input.overdueClarifications} applicant clarification(s) are past their due date.`,
    });
  }

  if (input.daysUntilDue !== null) {
    // Due-date pressure grows as the deadline approaches and after it passes.
    const points = input.daysUntilDue <= 0 ? 30 : Math.max(0, Math.round(30 - input.daysUntilDue * 2));
    if (points > 0) {
      contributions.push({
        factor: 'daysUntilDue',
        points,
        explanation:
          input.daysUntilDue <= 0
            ? `Case is ${Math.abs(input.daysUntilDue)} day(s) past its review due date.`
            : `Case is due in ${input.daysUntilDue} day(s).`,
      });
    }
  }

  const failed = Math.min(input.failedSourceChecks, 15) * 2;
  if (failed > 0) {
    contributions.push({
      factor: 'failedSourceChecks',
      points: failed,
      explanation: `${input.failedSourceChecks} source check(s) errored or found the source unavailable, and should be retried.`,
    });
  }

  const score = contributions.reduce((sum, c) => sum + c.points, 0);
  return { score, contributions };
}

/**
 * Next best action for a claim. Advisory routing only — it never suggests an
 * admissions, hiring, or eligibility outcome, because no such action exists in
 * the returned union.
 */
export type NextAction =
  | 'RUN_SOURCE_CHECK'
  | 'REQUEST_ISSUER_CONFIRMATION'
  | 'REQUEST_APPLICANT_CLARIFICATION'
  | 'SCHEDULE_INTERVIEW'
  | 'RECORD_REVIEWER_DECISION'
  | 'NO_ACTION_NEEDED';

export interface NextActionInput {
  status: ClaimStatus;
  hasRunAnySourceCheck: boolean;
  hasSupportingEvidence: boolean;
  hasConflictingEvidence: boolean;
  hasOpenClarification: boolean;
  isContributionClaim: boolean;
}

export interface NextActionSuggestion {
  action: NextAction;
  reason: string;
}

export function suggestNextAction(input: NextActionInput): NextActionSuggestion {
  if (input.hasOpenClarification) {
    return {
      action: 'NO_ACTION_NEEDED',
      reason: 'Awaiting the applicant’s response to an open clarification request.',
    };
  }

  if (input.status === ClaimStatus.VERIFIED || input.status === ClaimStatus.CORROBORATED) {
    return { action: 'NO_ACTION_NEEDED', reason: 'A reviewer has already recorded an outcome for this claim.' };
  }

  if (!input.hasRunAnySourceCheck) {
    return { action: 'RUN_SOURCE_CHECK', reason: 'No source has been consulted for this claim yet.' };
  }

  if (input.hasConflictingEvidence) {
    return {
      action: 'REQUEST_APPLICANT_CLARIFICATION',
      reason:
        'Sources disagree. The applicant should have the opportunity to explain or supply evidence before any ' +
        'conclusion is recorded.',
    };
  }

  if (!input.hasSupportingEvidence) {
    return {
      action: 'REQUEST_ISSUER_CONFIRMATION',
      reason:
        'Public sources did not hold a record. Direct confirmation from the issuing organization is the appropriate ' +
        'next channel — absence of an online record establishes nothing.',
    };
  }

  if (input.isContributionClaim) {
    return {
      action: 'SCHEDULE_INTERVIEW',
      reason:
        'This claim describes a personal contribution to research or a project, which records cannot confirm. ' +
        'A structured conversation is the appropriate way to corroborate it.',
    };
  }

  return {
    action: 'RECORD_REVIEWER_DECISION',
    reason: 'Evidence has been gathered and is ready for a reviewer to weigh.',
  };
}
