import { AuthorityLevel, ClaimCategory, SourceCheckResult } from '@prisma/client';
import { findFixture } from './fixtures';
import type { AdapterClaimInput, IntegrationStatus, SourceAdapter, SourceCheckOutcome, SourceQuery } from './types';

/**
 * Shared fixture-backed adapter.
 *
 * Every adapter extends this and gets identical, deterministic offline
 * behaviour. Live-capable adapters override `checkLive()`; the base class
 * decides whether live mode applies and always falls back to fixtures.
 */
export abstract class FixtureBackedAdapter implements SourceAdapter {
  abstract readonly key: string;
  abstract readonly name: string;
  abstract readonly authorityLevel: AuthorityLevel;
  abstract readonly supportedCategories: ClaimCategory[];
  abstract readonly integrationStatus: IntegrationStatus;
  abstract readonly integrationNote: string;

  supports(claim: AdapterClaimInput): boolean {
    return this.supportedCategories.includes(claim.category);
  }

  async check(query: SourceQuery): Promise<SourceCheckOutcome> {
    const live = await this.checkLive(query);
    if (live) return live;
    return this.checkFixture(query);
  }

  /**
   * Live implementations return an outcome; everything else returns null so the
   * fixture path runs. Implementations must consult `liveSourcesEnabled()`
   * themselves and return null when it is off.
   */
  protected async checkLive(_query: SourceQuery): Promise<SourceCheckOutcome | null> {
    return null;
  }

  protected checkFixture(query: SourceQuery): SourceCheckOutcome {
    const fixture = findFixture(this.key, query.claim, query.applicantName);
    const retrievedAt = new Date();

    if (!fixture) {
      return {
        // Nothing on file. An evidence gap, never a negative finding.
        result: SourceCheckResult.RECORD_NOT_FOUND,
        authorityLevel: this.authorityLevel,
        url: null,
        excerpt: null,
        detail:
          `${this.name} holds no record matching this claim. This means the claim could not be confirmed through ` +
          'this channel. It is not an indication that the claim is inaccurate — many legitimate records are not ' +
          'published or are held only by the issuing organisation.',
        retrievedAt,
        isLive: false,
      };
    }

    return {
      result: fixture.result,
      authorityLevel: this.authorityLevel,
      url: fixture.url,
      excerpt: fixture.excerpt,
      detail: fixture.detail,
      retrievedAt,
      isLive: false,
    };
  }
}
