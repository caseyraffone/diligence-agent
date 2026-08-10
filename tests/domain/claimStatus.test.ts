import { describe, expect, it } from 'vitest';
import { ClaimStatus } from '@prisma/client';
import {
  ALL_STATUSES,
  HUMAN_ONLY_STATUSES,
  SYSTEM_ASSIGNABLE_STATUSES,
  STATUS_LABELS,
  STATUS_MEANINGS,
  allowedTransitions,
  assertActorMayAssign,
  assertTransition,
  canTransition,
} from '@/domain/claimStatus';
import { InvalidTransitionError } from '@/lib/errors';

describe('claim status vocabulary', () => {
  it('contains no status that accuses a person', () => {
    const accusatory = /fraud|liar|lie|false|fake|forged|dishonest|reject|deny|fail/i;
    for (const status of ALL_STATUSES) {
      expect(status).not.toMatch(accusatory);
      expect(STATUS_LABELS[status]).not.toMatch(accusatory);
    }
  });

  it('describes "unable to verify" as an evidence gap, never as falsity', () => {
    const meaning = STATUS_MEANINGS[ClaimStatus.UNABLE_TO_VERIFY];
    expect(meaning).toMatch(/says nothing about whether the claim is true/i);
    expect(meaning).not.toMatch(/false|untrue|fabricat/i);
  });

  it('labels every status', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
      expect(STATUS_MEANINGS[status]).toBeTruthy();
    }
  });
});

describe('who may assign what', () => {
  it('forbids the pipeline from assigning any conclusion', () => {
    for (const status of HUMAN_ONLY_STATUSES) {
      expect(() => assertActorMayAssign('SYSTEM', status)).toThrow(InvalidTransitionError);
    }
  });

  it('routes the system to HUMAN_REVIEW_REQUIRED instead', () => {
    expect(() => assertActorMayAssign('SYSTEM', ClaimStatus.HUMAN_REVIEW_REQUIRED)).not.toThrow();
  });

  it('lets a human assign anything the transition graph permits', () => {
    for (const status of ALL_STATUSES) {
      expect(() => assertActorMayAssign('HUMAN', status)).not.toThrow();
    }
  });

  it('keeps human-only and system-assignable sets disjoint and complete', () => {
    for (const status of ALL_STATUSES) {
      const human = HUMAN_ONLY_STATUSES.has(status);
      const system = SYSTEM_ASSIGNABLE_STATUSES.has(status);
      // Every status belongs to exactly one bucket — no gaps, no overlap.
      expect(human !== system).toBe(true);
    }
  });
});

describe('transitions', () => {
  it('allows a claim to leave UNABLE_TO_VERIFY when evidence arrives', () => {
    // The central fairness property: not finding a record must never be a
    // one-way door.
    expect(canTransition(ClaimStatus.UNABLE_TO_VERIFY, ClaimStatus.VERIFIED)).toBe(true);
    expect(canTransition(ClaimStatus.UNABLE_TO_VERIFY, ClaimStatus.CORROBORATED)).toBe(true);
  });

  it('allows a conflicting claim to be revised when it is explained', () => {
    expect(canTransition(ClaimStatus.CONFLICTING_INFORMATION, ClaimStatus.VERIFIED)).toBe(true);
    expect(canTransition(ClaimStatus.CONFLICTING_INFORMATION, ClaimStatus.CORROBORATED)).toBe(true);
  });

  it('makes every status reachable out of, so nothing is terminal', () => {
    for (const status of ALL_STATUSES) {
      expect(allowedTransitions(status).length).toBeGreaterThan(0);
    }
  });

  it('treats a no-op transition as valid', () => {
    expect(canTransition(ClaimStatus.VERIFIED, ClaimStatus.VERIFIED)).toBe(true);
  });

  it('requires a written rationale for a human status change', () => {
    expect(() =>
      assertTransition({
        from: ClaimStatus.PENDING_VERIFICATION,
        to: ClaimStatus.VERIFIED,
        actor: 'HUMAN',
        rationale: 'ok',
      }),
    ).toThrow(/rationale/i);

    expect(() =>
      assertTransition({
        from: ClaimStatus.PENDING_VERIFICATION,
        to: ClaimStatus.VERIFIED,
        actor: 'HUMAN',
        rationale: 'Registrar confirmed enrolment dates directly by email on 2026-02-01.',
      }),
    ).not.toThrow();
  });

  it('rejects a system attempt to mark a claim verified', () => {
    expect(() =>
      assertTransition({ from: ClaimStatus.PENDING_VERIFICATION, to: ClaimStatus.VERIFIED, actor: 'SYSTEM' }),
    ).toThrow(InvalidTransitionError);
  });
});
