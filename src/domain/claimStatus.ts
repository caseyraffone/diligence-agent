import { ClaimStatus } from '@prisma/client';
import { InvalidTransitionError } from '@/lib/errors';

/**
 * The claim verification state machine.
 *
 * Every status here is neutral. None of them asserts that a person lied or that
 * fraud occurred, and there is deliberately no such status to assign.
 *
 * Three rules are enforced mechanically:
 *
 *  1. UNABLE_TO_VERIFY is an evidence state, not a finding about the applicant.
 *     It carries no implication of falsity and is reachable from, and
 *     returnable to, any other non-terminal state.
 *  2. Terminal-ish statuses (VERIFIED, CORROBORATED, CONFLICTING_INFORMATION)
 *     may only be entered by an authorized human via a ReviewerDecision. The
 *     `actor` parameter makes an automated attempt fail loudly.
 *  3. Nothing is irreversible. Every status can be revisited when new evidence
 *     arrives, which is what makes the appeal and correction path real.
 */

export type StatusActor = 'SYSTEM' | 'HUMAN';

export const ALL_STATUSES: ClaimStatus[] = [
  ClaimStatus.PENDING_VERIFICATION,
  ClaimStatus.VERIFIED,
  ClaimStatus.CORROBORATED,
  ClaimStatus.PARTIALLY_CORROBORATED,
  ClaimStatus.UNABLE_TO_VERIFY,
  ClaimStatus.CONFLICTING_INFORMATION,
  ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
  ClaimStatus.HUMAN_REVIEW_REQUIRED,
];

/**
 * Statuses a human reviewer must set. The system may *propose* them by routing
 * the claim to HUMAN_REVIEW_REQUIRED, but may never assign them itself.
 */
export const HUMAN_ONLY_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  ClaimStatus.VERIFIED,
  ClaimStatus.CORROBORATED,
  ClaimStatus.CONFLICTING_INFORMATION,
]);

/** Statuses the automated pipeline is permitted to assign on its own. */
export const SYSTEM_ASSIGNABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  ClaimStatus.PENDING_VERIFICATION,
  ClaimStatus.PARTIALLY_CORROBORATED,
  ClaimStatus.UNABLE_TO_VERIFY,
  ClaimStatus.HUMAN_REVIEW_REQUIRED,
  ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
]);

/**
 * Legal transitions. The graph is intentionally permissive between evidence
 * states — new evidence can arrive at any time — and strict about *who* may
 * make the move, which is handled separately by `assertActorMayAssign`.
 */
const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  [ClaimStatus.PENDING_VERIFICATION]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.CORROBORATED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
  ],
  [ClaimStatus.PARTIALLY_CORROBORATED]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.CORROBORATED,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
    ClaimStatus.PENDING_VERIFICATION,
  ],
  // Reachable back out of: an unverifiable claim becomes verifiable the moment
  // the issuing organization replies or the applicant supplies a record.
  [ClaimStatus.UNABLE_TO_VERIFY]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.CORROBORATED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
    ClaimStatus.PENDING_VERIFICATION,
  ],
  [ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.CORROBORATED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
    ClaimStatus.PENDING_VERIFICATION,
  ],
  [ClaimStatus.HUMAN_REVIEW_REQUIRED]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.CORROBORATED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.PENDING_VERIFICATION,
  ],
  // Human-set conclusions remain revisable: an appeal or a late record must be
  // able to move a claim back out of a conflicting or verified state.
  [ClaimStatus.CONFLICTING_INFORMATION]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.CORROBORATED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
  ],
  [ClaimStatus.CORROBORATED]: [
    ClaimStatus.VERIFIED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
  ],
  [ClaimStatus.VERIFIED]: [
    ClaimStatus.CORROBORATED,
    ClaimStatus.PARTIALLY_CORROBORATED,
    ClaimStatus.CONFLICTING_INFORMATION,
    ClaimStatus.UNABLE_TO_VERIFY,
    ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED,
    ClaimStatus.HUMAN_REVIEW_REQUIRED,
  ],
};

export function allowedTransitions(from: ClaimStatus): ClaimStatus[] {
  return [...TRANSITIONS[from]];
}

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/**
 * Enforces that the automated pipeline never assigns a conclusion. This is the
 * single most important guard in the product: it is what keeps the system
 * decision-support rather than decision-making.
 */
export function assertActorMayAssign(actor: StatusActor, to: ClaimStatus): void {
  if (actor === 'HUMAN') return;
  if (HUMAN_ONLY_STATUSES.has(to)) {
    throw new InvalidTransitionError(
      `Status ${to} may only be recorded by an authorized human reviewer. ` +
        `The automated pipeline must route the claim to ${ClaimStatus.HUMAN_REVIEW_REQUIRED} instead.`,
    );
  }
  if (!SYSTEM_ASSIGNABLE_STATUSES.has(to)) {
    throw new InvalidTransitionError(`Status ${to} is not system-assignable.`);
  }
}

export interface TransitionRequest {
  from: ClaimStatus;
  to: ClaimStatus;
  actor: StatusActor;
  /** Required for human decisions; the audit trail is meaningless without it. */
  rationale?: string;
}

/**
 * Validates a proposed status change. Throws InvalidTransitionError with a
 * reviewer-readable explanation rather than returning a boolean, so callers
 * cannot ignore the failure.
 */
export function assertTransition(request: TransitionRequest): void {
  const { from, to, actor, rationale } = request;

  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`Cannot move a claim from ${from} to ${to}.`);
  }
  assertActorMayAssign(actor, to);

  if (actor === 'HUMAN' && from !== to) {
    if (!rationale || rationale.trim().length < 10) {
      throw new InvalidTransitionError(
        'A human status change requires a written rationale of at least 10 characters citing the evidence relied on.',
      );
    }
  }
}

/** Neutral, reviewer-facing label. Never accusatory. */
export const STATUS_LABELS: Record<ClaimStatus, string> = {
  [ClaimStatus.PENDING_VERIFICATION]: 'Pending verification',
  [ClaimStatus.VERIFIED]: 'Verified',
  [ClaimStatus.CORROBORATED]: 'Corroborated',
  [ClaimStatus.PARTIALLY_CORROBORATED]: 'Partially corroborated',
  [ClaimStatus.UNABLE_TO_VERIFY]: 'Unable to verify',
  [ClaimStatus.CONFLICTING_INFORMATION]: 'Conflicting information',
  [ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED]: 'Applicant clarification requested',
  [ClaimStatus.HUMAN_REVIEW_REQUIRED]: 'Human review required',
};

/**
 * Explanatory text shown next to each status so a reviewer is reminded what it
 * does and does not mean.
 */
export const STATUS_MEANINGS: Record<ClaimStatus, string> = {
  [ClaimStatus.PENDING_VERIFICATION]: 'No verification attempt has completed yet.',
  [ClaimStatus.VERIFIED]:
    'The issuing or authoritative source confirmed this claim directly. Recorded by a human reviewer.',
  [ClaimStatus.CORROBORATED]:
    'Independent sources agree with this claim, without direct confirmation from the issuer. Recorded by a human reviewer.',
  [ClaimStatus.PARTIALLY_CORROBORATED]:
    'Some elements are supported; others are not yet established. This is not a negative finding.',
  [ClaimStatus.UNABLE_TO_VERIFY]:
    'No authoritative record was located through available channels. This says nothing about whether the claim is true. ' +
    'Many legitimate achievements leave no public record.',
  [ClaimStatus.CONFLICTING_INFORMATION]:
    'Two or more sources state materially different things. The conflict is documented; its cause is not established. ' +
    'Recorded by a human reviewer.',
  [ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED]:
    'The applicant has been asked, in neutral terms, to clarify or supply evidence. Awaiting their response.',
  [ClaimStatus.HUMAN_REVIEW_REQUIRED]:
    'The system has gathered what it can and is routing this claim to a trained reviewer for judgement.',
};
