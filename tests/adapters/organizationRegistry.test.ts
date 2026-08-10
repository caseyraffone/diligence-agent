import { describe, expect, it } from 'vitest';
import {
  AuthorityLevel,
  ClaimStatus,
  EvidenceRelation,
  EvidenceScope,
  SourceCheckResult,
  StatementType,
} from '@prisma/client';
import { GleifOrganizationAdapter, RorOrganizationAdapter } from '@/adapters/organizationRegistry';
import { proposeStatus } from '@/domain/authority';

/**
 * The central distinction in the product.
 *
 * The HTTP call itself is not exercised here — tests never touch a third party.
 * What is exercised is the response mapping, against payloads shaped like the
 * real GLEIF and ROR responses, and the scoping rule that keeps organisation
 * evidence out of claim conclusions.
 */

const gleif = new GleifOrganizationAdapter();
const ror = new RorOrganizationAdapter();

const GLEIF_HIT = [
  {
    attributes: {
      lei: '5493001KJTIIGC8Y1R12',
      entity: {
        legalName: { name: 'Star Mountain Capital LLC' },
        legalAddress: { country: 'US', city: 'New York' },
        status: 'ACTIVE',
      },
      registration: { status: 'ISSUED', initialRegistrationDate: '2013-02-01' },
    },
  },
];

const ROR_HIT = [
  {
    id: 'https://ror.org/01cwqze88',
    name: 'Universidad Nacional Autónoma de México',
    status: 'active',
    types: ['Education'],
    country: { country_name: 'Mexico', country_code: 'MX' },
    established: 1910,
    aliases: ['National Autonomous University of Mexico'],
    acronyms: ['UNAM'],
  },
];

describe('GLEIF organisation lookup', () => {
  it('confirms a registered legal entity', () => {
    const outcome = gleif.evaluate(GLEIF_HIT, 'Star Mountain Capital', 'https://api.gleif.org/x');
    expect(outcome.result).toBe(SourceCheckResult.MATCH);
    expect(outcome.excerpt).toContain('5493001KJTIIGC8Y1R12');
    expect(outcome.excerpt).toContain('New York');
  });

  it('states explicitly that it does not address the engagement', () => {
    // This wording is the whole point. Without it a reviewer reads "match" as
    // "the internship checks out".
    const outcome = gleif.evaluate(GLEIF_HIT, 'Star Mountain Capital', 'https://api.gleif.org/x');
    expect(outcome.detail).toMatch(/does NOT address whether the applicant was engaged there/i);
    expect(outcome.detail).toMatch(/no public register records employment/i);
  });

  it('treats an absent LEI as meaningless rather than negative', () => {
    const outcome = gleif.evaluate([], 'Elmwood Community Trust', 'https://api.gleif.org/x');
    expect(outcome.result).toBe(SourceCheckResult.RECORD_NOT_FOUND);
    expect(outcome.detail).toMatch(/does not indicate the organisation is not real/i);
    // Small firms, charities, and schools legitimately have no LEI.
    expect(outcome.detail).toMatch(/routinely absent/i);
  });

  it('does not claim certainty when only a similar name is found', () => {
    const outcome = gleif.evaluate(GLEIF_HIT, 'Stone Mountain Capital Partners', 'https://api.gleif.org/x');
    expect(outcome.result).toBe(SourceCheckResult.PARTIAL_MATCH);
    expect(outcome.detail).toMatch(/is not itself a concern/i);
  });

  it('never returns NO_MATCH — it cannot contradict a claim it does not address', () => {
    for (const [records, name] of [
      [GLEIF_HIT, 'Star Mountain Capital'],
      [GLEIF_HIT, 'Something Else Entirely'],
      [[], 'Nowhere Ltd'],
    ] as const) {
      const outcome = gleif.evaluate(records as typeof GLEIF_HIT, name, 'u');
      expect(outcome.result).not.toBe(SourceCheckResult.NO_MATCH);
    }
  });
});

describe('ROR institution lookup', () => {
  it('resolves an institution through its acronym', () => {
    const outcome = ror.evaluate(ROR_HIT, 'UNAM', 'https://api.ror.org/x');
    expect(outcome.result).toBe(SourceCheckResult.MATCH);
    expect(outcome.excerpt).toContain('Mexico');
  });

  it('resolves an institution through its local-language name', () => {
    const outcome = ror.evaluate(ROR_HIT, 'Universidad Nacional Autónoma de México', 'https://api.ror.org/x');
    expect(outcome.result).toBe(SourceCheckResult.MATCH);
  });

  it('states that it holds no enrolment records', () => {
    const outcome = ror.evaluate(ROR_HIT, 'UNAM', 'https://api.ror.org/x');
    expect(outcome.detail).toMatch(/does NOT address whether the applicant studied or worked there/i);
  });

  it('treats a secondary school being absent as expected, not suspicious', () => {
    const outcome = ror.evaluate([], 'Lagos International College', 'https://api.ror.org/x');
    expect(outcome.result).toBe(SourceCheckResult.RECORD_NOT_FOUND);
    expect(outcome.detail).toMatch(/does not indicate the institution is not real/i);
  });
});

describe('organisation evidence cannot verify a claim', () => {
  const orgEvidence = {
    relation: EvidenceRelation.SUPPORTING,
    statementType: StatementType.CONFIRMED_FACT,
    authorityLevel: AuthorityLevel.L1_ISSUING_AUTHORITY,
    scope: EvidenceScope.ORGANIZATION_CONTEXT,
  };

  it('does not let "the company is real" corroborate "I worked there"', () => {
    // Without the scope rule this is L1 CONFIRMED_FACT supporting evidence and
    // would propose VERIFIED — the exact false confidence this design forbids.
    const proposal = proposeStatus([orgEvidence]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.UNABLE_TO_VERIFY);
    expect(proposal.proposedStatus).not.toBe(ClaimStatus.VERIFIED);
    expect(proposal.proposedStatus).not.toBe(ClaimStatus.CORROBORATED);
  });

  it('still reaches verified once the employer actually confirms', () => {
    const proposal = proposeStatus([
      orgEvidence,
      {
        relation: EvidenceRelation.SUPPORTING,
        statementType: StatementType.THIRD_PARTY_STATEMENT,
        authorityLevel: AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE,
        scope: EvidenceScope.CLAIM,
      },
    ]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.VERIFIED);
    expect(proposal.requiresHumanDecision).toBe(true);
  });

  it('defaults undeclared scope to CLAIM so existing evidence is unaffected', () => {
    const proposal = proposeStatus([
      {
        relation: EvidenceRelation.SUPPORTING,
        statementType: StatementType.CONFIRMED_FACT,
        authorityLevel: AuthorityLevel.L1_ISSUING_AUTHORITY,
      },
    ]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.VERIFIED);
  });

  it('ignores organisation context when weighing a conflict', () => {
    const proposal = proposeStatus([
      orgEvidence,
      {
        relation: EvidenceRelation.CONFLICTING,
        statementType: StatementType.CONFIRMED_FACT,
        authorityLevel: AuthorityLevel.L2_OFFICIAL_WEBSITE,
        scope: EvidenceScope.CLAIM,
      },
    ]);
    expect(proposal.proposedStatus).toBe(ClaimStatus.CONFLICTING_INFORMATION);
  });
});

describe('adapter declarations', () => {
  it('marks both as live-capable organisation-existence sources', () => {
    for (const adapter of [gleif, ror]) {
      expect(adapter.integrationStatus).toBe('LIVE_CAPABLE');
      expect(adapter.verifies).toBe('ORGANIZATION_EXISTENCE');
      expect(adapter.integrationNote).toMatch(/no credentials required/i);
    }
  });

  it('requires an organisation name before it will run', () => {
    const base = {
      id: 'c1',
      category: 'EMPLOYMENT' as const,
      normalizedText: 'x',
      sourcePassage: 'x',
      personName: null,
      organizationName: null,
      title: null,
      startDate: null,
      endDate: null,
      amountValue: null,
      amountUnit: null,
    };
    expect(gleif.supports(base)).toBe(false);
    expect(gleif.supports({ ...base, organizationName: 'Northwind Analytics' })).toBe(true);
  });
});

describe('reviewer-facing wording', () => {
  it('never summarises an organisation lookup as confirming the claim', async () => {
    // Regression guard. The generic summary said "GLEIF confirms this claim",
    // which tells a reviewer the internship checked out when all that was
    // confirmed is that the firm is registered.
    const { prisma } = await import('@/lib/prisma');
    const rows = await prisma.evidenceItem.findMany({
      where: { scope: EvidenceScope.ORGANIZATION_CONTEXT },
      select: { summary: true },
    });
    for (const row of rows) {
      expect(row.summary, row.summary).not.toMatch(/confirms this claim/i);
    }
  });
});
