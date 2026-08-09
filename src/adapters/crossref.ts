import { AuthorityLevel, ClaimCategory, SourceCheckResult } from '@prisma/client';
import { liveSourcesEnabled } from '@/lib/env';
import { extractDoi, comparePersonNames } from '@/lib/text';
import { FixtureBackedAdapter } from './base';
import { cacheGet, cacheKey, cacheSet, liveUserAgent } from './cache';
import type { AdapterClaimInput, IntegrationStatus, SourceCheckOutcome, SourceQuery } from './types';

interface CrossrefWork {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; sequence?: string }>;
  'container-title'?: string[];
  issued?: { 'date-parts'?: number[][] };
  type?: string;
  publisher?: string;
}

/**
 * Crossref — LIVE CAPABLE.
 *
 * Crossref's REST API is open, requires no key, permits automated access, and
 * asks only for an identifying User-Agent (the "polite pool"). That makes it one
 * of the two sources this MVP is willing to query for real.
 *
 * It answers exactly one question well: does this DOI resolve to a registered
 * work, and does the claimed author appear on it. It cannot speak to a person's
 * actual contribution — that is what the interview module is for.
 */
export class CrossrefAdapter extends FixtureBackedAdapter {
  readonly key = 'crossref';
  readonly name = 'Crossref DOI registry';
  readonly authorityLevel = AuthorityLevel.L4_SIGNED_VERIFIABLE_RECORD;
  readonly supportedCategories = [ClaimCategory.PUBLICATION];
  readonly integrationStatus: IntegrationStatus = 'LIVE_CAPABLE';
  readonly integrationNote =
    'Open REST API, no credentials required. Live calls are enabled by ENABLE_LIVE_SOURCES=true and send ' +
    'LIVE_SOURCE_CONTACT_EMAIL in the User-Agent, as Crossref asks. No agreement needed.';

  override supports(claim: AdapterClaimInput): boolean {
    return claim.category === ClaimCategory.PUBLICATION;
  }

  protected override async checkLive(query: SourceQuery): Promise<SourceCheckOutcome | null> {
    if (!liveSourcesEnabled()) return null;

    const doi = extractDoi(query.claim.sourcePassage) ?? extractDoi(query.claim.normalizedText);
    // Without a DOI there is no precise lookup; a title search would invite
    // false matches on common titles, so we defer to fixtures/other channels.
    if (!doi) return null;

    const key = cacheKey(this.key, { doi });
    const cached = cacheGet<SourceCheckOutcome>(key);
    if (cached) return { ...cached, retrievedAt: new Date() };

    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': liveUserAgent(), accept: 'application/json' },
      });

      if (response.status === 404) {
        const outcome: SourceCheckOutcome = {
          result: SourceCheckResult.RECORD_NOT_FOUND,
          authorityLevel: this.authorityLevel,
          url: `https://doi.org/${doi}`,
          excerpt: null,
          detail:
            `Crossref has no registration for DOI ${doi}. Note that not every publication venue registers DOIs ` +
            'with Crossref — DataCite and other agencies also issue them — so this does not establish that the ' +
            'work does not exist.',
          retrievedAt: new Date(),
          isLive: true,
        };
        cacheSet(key, outcome);
        return outcome;
      }

      if (!response.ok) {
        return {
          result: SourceCheckResult.SOURCE_UNAVAILABLE,
          authorityLevel: this.authorityLevel,
          url,
          excerpt: null,
          detail: `Crossref returned status ${response.status}. The check should be retried.`,
          retrievedAt: new Date(),
          isLive: true,
        };
      }

      const body = (await response.json()) as { message?: CrossrefWork };
      const work = body.message;
      if (!work) {
        return {
          result: SourceCheckResult.INCONCLUSIVE,
          authorityLevel: this.authorityLevel,
          url,
          excerpt: null,
          detail: 'Crossref returned a response that did not contain a work record.',
          retrievedAt: new Date(),
          isLive: true,
        };
      }

      const outcome = this.evaluateWork(work, doi, query.applicantName, query.claim.personName);
      cacheSet(key, outcome);
      return outcome;
    } catch (e) {
      return {
        result: SourceCheckResult.SOURCE_UNAVAILABLE,
        authorityLevel: this.authorityLevel,
        url,
        excerpt: null,
        detail: `Could not reach Crossref: ${e instanceof Error ? e.message : 'unknown error'}. Retry the check.`,
        retrievedAt: new Date(),
        isLive: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private evaluateWork(
    work: CrossrefWork,
    doi: string,
    applicantName: string,
    claimPersonName: string | null,
  ): SourceCheckOutcome {
    const title = work.title?.[0] ?? '(untitled)';
    const venue = work['container-title']?.[0] ?? work.publisher ?? 'unknown venue';
    const year = work.issued?.['date-parts']?.[0]?.[0];
    const authors = (work.author ?? []).map((a) => `${a.given ?? ''} ${a.family ?? ''}`.trim()).filter(Boolean);

    const excerpt = `${authors.join('; ') || '(no authors listed)'} (${year ?? 'n.d.'}). "${title}." ${venue}.`;
    const target = claimPersonName ?? applicantName;
    const position = authors.findIndex((a) => comparePersonNames(a, target).match);

    if (position === -1) {
      return {
        result: SourceCheckResult.PARTIAL_MATCH,
        authorityLevel: this.authorityLevel,
        url: `https://doi.org/${doi}`,
        excerpt,
        detail:
          'The DOI resolves to a registered work, confirming the publication exists. The applicant\'s name was not ' +
          'matched in the author list as recorded by Crossref. Author metadata is often incomplete, and names change; ' +
          'this is a question to put to the applicant, not a finding.',
        retrievedAt: new Date(),
        isLive: true,
        raw: work,
      };
    }

    return {
      result: SourceCheckResult.MATCH,
      authorityLevel: this.authorityLevel,
      url: `https://doi.org/${doi}`,
      excerpt,
      detail:
        `The DOI resolves to a registered work and lists the applicant as author ${position + 1} of ${authors.length}. ` +
        'Authorship order conventions differ by field; this confirms the publication and the applicant\'s presence on it, ' +
        'not the size of their contribution.',
      retrievedAt: new Date(),
      isLive: true,
      raw: work,
    };
  }
}
