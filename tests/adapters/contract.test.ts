import { describe, expect, it } from 'vitest';
import { AuthorityLevel, ClaimCategory, SourceCheckResult } from '@prisma/client';
import { allAdapters, adaptersForClaim, getAdapter } from '@/adapters/registry';
import type { AdapterClaimInput } from '@/adapters/types';

/**
 * Shared adapter contract.
 *
 * Every adapter must pass this, including any added later. Registering an
 * adapter in the registry is enough to enrol it — there is no opt-out.
 */

function sampleClaim(overrides: Partial<AdapterClaimInput> = {}): AdapterClaimInput {
  return {
    id: 'claim-1',
    category: ClaimCategory.PUBLICATION,
    normalizedText: 'A publication with no DOI',
    sourcePassage: 'A publication with no DOI',
    personName: null,
    organizationName: 'Nowhere Institute of Obscure Studies',
    title: 'Some Title',
    startDate: null,
    endDate: null,
    amountValue: null,
    amountUnit: null,
    ...overrides,
  };
}

const VALID_RESULTS = new Set(Object.values(SourceCheckResult));
const VALID_LEVELS = new Set(Object.values(AuthorityLevel));

describe.each(allAdapters().map((a) => [a.key, a] as const))('adapter contract: %s', (_key, adapter) => {
  it('declares identity, authority, and coverage', () => {
    expect(adapter.key).toMatch(/^[a-z0-9-]+$/);
    expect(adapter.name.length).toBeGreaterThan(3);
    expect(VALID_LEVELS.has(adapter.authorityLevel)).toBe(true);
    expect(adapter.supportedCategories.length).toBeGreaterThan(0);
  });

  it('documents what production access requires', () => {
    // An operator must be able to tell simulated from real at a glance.
    expect(['LIVE_CAPABLE', 'PLACEHOLDER']).toContain(adapter.integrationStatus);
    expect(adapter.integrationNote.length).toBeGreaterThan(40);
  });

  it('only claims to support categories it declares', () => {
    for (const category of Object.values(ClaimCategory)) {
      const supported = adapter.supports(sampleClaim({ category }));
      expect(supported).toBe(adapter.supportedCategories.includes(category));
    }
  });

  it('returns a well-formed outcome for a supported claim', async () => {
    const category = adapter.supportedCategories[0]!;
    const outcome = await adapter.check({ claim: sampleClaim({ category }), applicantName: 'Test Applicant' });

    expect(VALID_RESULTS.has(outcome.result)).toBe(true);
    expect(VALID_LEVELS.has(outcome.authorityLevel)).toBe(true);
    expect(outcome.retrievedAt).toBeInstanceOf(Date);
    expect(typeof outcome.detail).toBe('string');
    expect(outcome.detail.length).toBeGreaterThan(0);
  });

  it('returns RECORD_NOT_FOUND — never NO_MATCH — when it holds nothing', async () => {
    // The distinction the whole fairness posture rests on: a source with no
    // record must never produce the result that becomes conflicting evidence.
    const category = adapter.supportedCategories[0]!;
    const outcome = await adapter.check({
      claim: sampleClaim({
        category,
        organizationName: 'Entirely Fictional Organisation That Matches No Fixture',
        normalizedText: 'An achievement no registry has ever heard of',
        sourcePassage: 'An achievement no registry has ever heard of',
      }),
      applicantName: 'Nobody In Particular',
    });

    expect(outcome.result).toBe(SourceCheckResult.RECORD_NOT_FOUND);
    expect(outcome.detail).toMatch(/not an indication that the claim is inaccurate/i);
  });

  it('makes no network call when live sources are disabled', async () => {
    // NODE_ENV=test hard-disables live mode, so every outcome must be a fixture.
    const category = adapter.supportedCategories[0]!;
    const outcome = await adapter.check({ claim: sampleClaim({ category }), applicantName: 'Test Applicant' });
    expect(outcome.isLive).toBe(false);
  });

  it('never returns a status or a conclusion about a person', async () => {
    const category = adapter.supportedCategories[0]!;
    const outcome = await adapter.check({ claim: sampleClaim({ category }), applicantName: 'Test Applicant' });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toMatch(/\b(VERIFIED|CONFLICTING_INFORMATION|admit|reject|hire)\b/);
    expect(outcome.detail).not.toMatch(/\b(lied|fraud|fraudulent|dishonest|fabricated)\b/i);
  });
});

describe('registry', () => {
  it('has unique adapter keys', () => {
    const keys = allAdapters().map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves a known adapter and returns null for an unknown one', () => {
    expect(getAdapter('crossref')?.key).toBe('crossref');
    expect(getAdapter('does-not-exist')).toBeNull();
  });

  it('only offers adapters the policy has approved', () => {
    const claim = sampleClaim({ category: ClaimCategory.PUBLICATION });
    const approved = adaptersForClaim(claim, ['crossref']);
    expect(approved.map((a) => a.key)).toEqual(['crossref']);

    // A policy approving nothing relevant yields nothing — a valid configuration
    // meaning "this category is checked by human outreach only".
    expect(adaptersForClaim(claim, ['license-registry'])).toHaveLength(0);
  });

  it('orders applicable adapters most-authoritative first', () => {
    const claim = sampleClaim({ category: ClaimCategory.EMPLOYMENT });
    const ordered = adaptersForClaim(claim, ['web-archive', 'employer-confirmation']);
    expect(ordered[0]!.key).toBe('employer-confirmation');
  });

  it('ships exactly the live-capable adapters that use open, agreement-free APIs', () => {
    const live = allAdapters()
      .filter((a) => a.integrationStatus === 'LIVE_CAPABLE')
      .map((a) => a.key)
      .sort();
    // Adding to this list means asserting the source is genuinely open: no key,
    // no contract, and automated access permitted by its terms.
    expect(live).toEqual(['crossref', 'gleif', 'pubmed', 'ror']);
  });

  it('declares which adapters speak to the organisation rather than to the claim', () => {
    const orgOnly = allAdapters()
      .filter((a) => a.verifies === 'ORGANIZATION_EXISTENCE')
      .map((a) => a.key)
      .sort();
    expect(orgOnly).toEqual(['gleif', 'ror']);

    for (const adapter of allAdapters()) {
      expect(adapter.verifies ?? 'CLAIM').toMatch(/^(CLAIM|ORGANIZATION_EXISTENCE)$/);
    }
  });
});

describe('fixture behaviour for demonstration cases', () => {
  it('returns a differing record for the seeded conflicting award', async () => {
    const adapter = getAdapter('award-database')!;
    const outcome = await adapter.check({
      claim: sampleClaim({
        category: ClaimCategory.AWARD_COMPETITION,
        organizationName: 'International Robotics Challenge',
        normalizedText: 'First Place at International Robotics Challenge (2023)',
        sourcePassage: 'First Place, International Robotics Challenge (2023)',
      }),
      applicantName: 'Priya Raman',
    });
    expect(outcome.result).toBe(SourceCheckResult.NO_MATCH);
    expect(outcome.excerpt).toMatch(/Team Aurora/);
  });

  it('resolves an organisation under its renamed form', async () => {
    const adapter = getAdapter('employer-confirmation')!;
    const outcome = await adapter.check({
      claim: sampleClaim({ category: ClaimCategory.EMPLOYMENT, organizationName: 'Facebook, Inc.' }),
      applicantName: 'Test Applicant',
    });
    expect(outcome.result).toBe(SourceCheckResult.MATCH);
    expect(outcome.detail).toMatch(/corporate rename/i);
  });

  it('reports an unreachable registry as unavailable, not as a mismatch', async () => {
    const adapter = getAdapter('license-registry')!;
    const outcome = await adapter.check({
      claim: sampleClaim({
        category: ClaimCategory.CERTIFICATION_LICENSE,
        organizationName: 'State Board of Professional Surveyors',
      }),
      applicantName: 'Test Applicant',
    });
    expect(outcome.result).toBe(SourceCheckResult.SOURCE_UNAVAILABLE);
    expect(outcome.detail).toMatch(/No conclusion can be drawn/i);
  });

  it('treats an ambiguous name record as inconclusive rather than as a match', async () => {
    const adapter = getAdapter('award-database')!;
    const outcome = await adapter.check({
      claim: sampleClaim({
        category: ClaimCategory.AWARD_COMPETITION,
        organizationName: 'Midwest Collegiate Debate Association',
      }),
      applicantName: 'J. Smith',
    });
    expect(outcome.result).toBe(SourceCheckResult.INCONCLUSIVE);
    expect(outcome.detail).toMatch(/not evidence for or against/i);
  });
});
