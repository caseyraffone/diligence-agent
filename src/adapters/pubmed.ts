import { AuthorityLevel, ClaimCategory, SourceCheckResult } from '@prisma/client';
import { liveSourcesEnabled } from '@/lib/env';
import { extractDoi } from '@/lib/text';
import { FixtureBackedAdapter } from './base';
import { cacheGet, cacheKey, cacheSet, liveUserAgent } from './cache';
import type { AdapterClaimInput, IntegrationStatus, SourceCheckOutcome, SourceQuery } from './types';

/**
 * PubMed / NCBI E-utilities — LIVE CAPABLE.
 *
 * Open, no key required for low request rates. NCBI asks unauthenticated
 * callers to stay at or below roughly three requests per second and to identify
 * themselves; we send the configured contact address and cache aggressively.
 *
 * Covers biomedical literature only. A "not found" here is especially weak
 * evidence — most fields are simply not indexed in PubMed at all.
 */
export class PubMedAdapter extends FixtureBackedAdapter {
  readonly key = 'pubmed';
  readonly name = 'PubMed (NCBI E-utilities)';
  readonly authorityLevel = AuthorityLevel.L4_SIGNED_VERIFIABLE_RECORD;
  readonly supportedCategories = [ClaimCategory.PUBLICATION];
  readonly integrationStatus: IntegrationStatus = 'LIVE_CAPABLE';
  readonly integrationNote =
    'Open E-utilities API, no credentials required at low volume. An NCBI API key raises the rate limit and is ' +
    'recommended for production. Indexes biomedical literature only.';

  override supports(claim: AdapterClaimInput): boolean {
    return claim.category === ClaimCategory.PUBLICATION;
  }

  protected override async checkLive(query: SourceQuery): Promise<SourceCheckOutcome | null> {
    if (!liveSourcesEnabled()) return null;

    const doi = extractDoi(query.claim.sourcePassage) ?? extractDoi(query.claim.normalizedText);
    if (!doi) return null;

    const key = cacheKey(this.key, { doi });
    const cached = cacheGet<SourceCheckOutcome>(key);
    if (cached) return { ...cached, retrievedAt: new Date() };

    const searchUrl =
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=' +
      encodeURIComponent(`${doi}[DOI]`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: { 'user-agent': liveUserAgent(), accept: 'application/json' },
      });

      if (!response.ok) {
        return {
          result: SourceCheckResult.SOURCE_UNAVAILABLE,
          authorityLevel: this.authorityLevel,
          url: searchUrl,
          excerpt: null,
          detail: `PubMed returned status ${response.status}. The check should be retried.`,
          retrievedAt: new Date(),
          isLive: true,
        };
      }

      const body = (await response.json()) as { esearchresult?: { idlist?: string[] } };
      const ids = body.esearchresult?.idlist ?? [];

      if (ids.length === 0) {
        const outcome: SourceCheckOutcome = {
          result: SourceCheckResult.RECORD_NOT_FOUND,
          authorityLevel: this.authorityLevel,
          url: searchUrl,
          excerpt: null,
          detail:
            'PubMed holds no record for this DOI. PubMed indexes biomedical literature only, so work in other ' +
            'fields is expected to be absent. This is not evidence about the claim.',
          retrievedAt: new Date(),
          isLive: true,
        };
        cacheSet(key, outcome);
        return outcome;
      }

      const pmid = ids[0]!;
      const outcome: SourceCheckOutcome = {
        result: SourceCheckResult.MATCH,
        authorityLevel: this.authorityLevel,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        excerpt: `PubMed record PMID ${pmid} is indexed for DOI ${doi}.`,
        detail: 'PubMed holds an indexed record for this DOI, confirming the publication exists.',
        retrievedAt: new Date(),
        isLive: true,
        raw: { pmid, ids },
      };
      cacheSet(key, outcome);
      return outcome;
    } catch (e) {
      return {
        result: SourceCheckResult.SOURCE_UNAVAILABLE,
        authorityLevel: this.authorityLevel,
        url: searchUrl,
        excerpt: null,
        detail: `Could not reach PubMed: ${e instanceof Error ? e.message : 'unknown error'}. Retry the check.`,
        retrievedAt: new Date(),
        isLive: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
