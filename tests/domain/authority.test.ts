import { describe, expect, it } from 'vitest';
import { AuthorityLevel, ClaimStatus, EvidenceRelation, SourceCheckResult, StatementType } from '@prisma/client';
import {
  AUTHORITY_RANK,
  isAbsenceResult,
  proposeStatus,
  relationForResult,
  statementTypeForResult,
  strongest,
} from '@/domain/authority';

const supporting = (authorityLevel: AuthorityLevel, statementType: StatementType = StatementType.CONFIRMED_FACT) => ({
  relation: EvidenceRelation.SUPPORTING,
  statementType,
  authorityLevel,
});

describe('source hierarchy', () => {
  it('ranks the issuing authority above everything else', () => {
    expect(AUTHORITY_RANK[AuthorityLevel.L1_ISSUING_AUTHORITY]).toBeLessThan(
      AUTHORITY_RANK[AuthorityLevel.L7_INFORMAL_SELF_PUBLISHED],
    );
  });

  it('picks the strongest level from a set', () => {
    expect(
      strongest([
        AuthorityLevel.L6_APPLICANT_PROVIDED,
        AuthorityLevel.L2_OFFICIAL_WEBSITE,
        AuthorityLevel.L5_INDEPENDENT_REPORTING,
      ]),
    ).toBe(AuthorityLevel.L2_OFFICIAL_WEBSITE);
  });
});

describe('absence is never a negative finding', () => {
  it('classifies every "we looked and found nothing" result as absence', () => {
    expect(isAbsenceResult(SourceCheckResult.RECORD_NOT_FOUND)).toBe(true);
    expect(isAbsenceResult(SourceCheckResult.SOURCE_UNAVAILABLE)).toBe(true);
    expect(isAbsenceResult(SourceCheckResult.INCONCLUSIVE)).toBe(true);
    expect(isAbsenceResult(SourceCheckResult.ERROR)).toBe(true);
  });

  it('never turns an absence result into conflicting evidence', () => {
    for (const result of [
      SourceCheckResult.RECORD_NOT_FOUND,
      SourceCheckResult.SOURCE_UNAVAILABLE,
      SourceCheckResult.INCONCLUSIVE,
      SourceCheckResult.ERROR,
    ]) {
      expect(relationForResult(result)).toBe(EvidenceRelation.NEUTRAL);
    }
  });

  it('only treats a differing held record as conflicting', () => {
    expect(relationForResult(SourceCheckResult.NO_MATCH)).toBe(EvidenceRelation.CONFLICTING);
    expect(relationForResult(SourceCheckResult.MATCH)).toBe(EvidenceRelation.SUPPORTING);
    expect(relationForResult(SourceCheckResult.PARTIAL_MATCH)).toBe(EvidenceRelation.SUPPORTING);
  });

  it('types an absence as a system observation, not a third-party statement', () => {
    expect(statementTypeForResult(SourceCheckResult.RECORD_NOT_FOUND, AuthorityLevel.L1_ISSUING_AUTHORITY)).toBe(
      StatementType.SYSTEM_OBSERVATION,
    );
  });
});

describe('status proposals', () => {
  it('proposes UNABLE_TO_VERIFY with neutral framing when nothing was found', () => {
    const proposal = proposeStatus([]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.UNABLE_TO_VERIFY);
    expect(proposal.requiresHumanDecision).toBe(false);
    expect(proposal.rationale).toMatch(/evidence gap, not a finding against the applicant/i);
  });

  it('never proposes VERIFIED without requiring a human to record it', () => {
    const proposal = proposeStatus([supporting(AuthorityLevel.L1_ISSUING_AUTHORITY)]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.VERIFIED);
    expect(proposal.requiresHumanDecision).toBe(true);
  });

  it('will not let applicant-provided evidence alone reach verified', () => {
    const proposal = proposeStatus([
      supporting(AuthorityLevel.L6_APPLICANT_PROVIDED, StatementType.APPLICANT_STATEMENT),
    ]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.PARTIALLY_CORROBORATED);
    expect(proposal.requiresHumanDecision).toBe(false);
  });

  it('proposes CORROBORATED for independent reporting, still needing a human', () => {
    const proposal = proposeStatus([
      supporting(AuthorityLevel.L5_INDEPENDENT_REPORTING, StatementType.THIRD_PARTY_STATEMENT),
    ]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.CORROBORATED);
    expect(proposal.requiresHumanDecision).toBe(true);
  });

  it('flags a conflict without asserting why it arose', () => {
    const proposal = proposeStatus([
      supporting(AuthorityLevel.L1_ISSUING_AUTHORITY),
      {
        relation: EvidenceRelation.CONFLICTING,
        statementType: StatementType.CONFIRMED_FACT,
        authorityLevel: AuthorityLevel.L2_OFFICIAL_WEBSITE,
      },
    ]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.CONFLICTING_INFORMATION);
    expect(proposal.requiresHumanDecision).toBe(true);
    expect(proposal.rationale).toMatch(/has not been established and may be benign/i);
  });

  it('does not count an applicant restating their own claim as corroboration', () => {
    const proposal = proposeStatus([
      supporting(AuthorityLevel.L6_APPLICANT_PROVIDED, StatementType.APPLICANT_STATEMENT),
      supporting(AuthorityLevel.L7_INFORMAL_SELF_PUBLISHED, StatementType.APPLICANT_STATEMENT),
    ]);
    expect(proposal.proposedStatus).not.toBe(ClaimStatus.VERIFIED);
    expect(proposal.proposedStatus).not.toBe(ClaimStatus.CORROBORATED);
  });
});
