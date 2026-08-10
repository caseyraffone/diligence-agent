import { AuthorityLevel, ClaimCategory, SourceCheckResult } from '@prisma/client';
import { liveSourcesEnabled } from '@/lib/env';
import { organizationsMatch, normalizeOrganization } from '@/lib/text';
import { FixtureBackedAdapter } from './base';
import { cacheGet, cacheKey, cacheSet, liveUserAgent } from './cache';
import type { AdapterClaimInput, IntegrationStatus, SourceCheckOutcome, SourceQuery } from './types';

/**
 * ORGANISATION EXISTENCE ADAPTERS
 *
 * These answer one question and are careful to answer only that question:
 *
 *   "Is the organisation named in this claim a real, registered entity that
 *    matches how the applicant described it?"
 *
 * They do NOT address whether the applicant was ever engaged there. That
 * separation is enforced structurally: `verifies = 'ORGANIZATION_EXISTENCE'`
 * causes the evidence verifier to record their output as ORGANIZATION_CONTEXT,
 * which `proposeStatus` excludes from the status proposal entirely.
 *
 * Why it matters: a résumé says "Summer Analyst, Star Mountain Capital". A
 * registry can confirm Star Mountain Capital is a real registered firm. There is
 * no public record anywhere of who interned there. A system that let the first
 * fact quietly corroborate the second would be manufacturing confidence it has
 * no basis for — and, worse, would treat the absence of an internship record as
 * meaningful when no such record exists for anyone.
 *
 * Both adapters below use genuinely open APIs: no key, no contract, no scraping,
 * documented for programmatic access.
 */

interface GleifRecord {
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      legalAddress?: { country?: string; city?: string };
      status?: string;
      legalForm?: { id?: string };
    };
    registration?: { status?: string; initialRegistrationDate?: string };
  };
}

/**
 * GLEIF — the Global Legal Entity Identifier Foundation register.
 *
 * Open REST API, no key. The authoritative global source for "is this a real
 * legal entity", covering firms that trade in financial markets worldwide,
 * which includes most banks, funds, and investment advisers.
 */
export class GleifOrganizationAdapter extends FixtureBackedAdapter {
  readonly key = 'gleif';
  readonly name = 'GLEIF legal entity register';
  readonly authorityLevel = AuthorityLevel.L1_ISSUING_AUTHORITY;
  readonly supportedCategories: ClaimCategory[] = [
    ClaimCategory.EMPLOYMENT,
    ClaimCategory.PROJECT_VENTURE_PATENT,
    ClaimCategory.RESEARCH_POSITION,
  ];
  readonly integrationStatus: IntegrationStatus = 'LIVE_CAPABLE';
  readonly verifies = 'ORGANIZATION_EXISTENCE' as const;
  readonly integrationNote =
    'Open REST API, no credentials required. Confirms that a named legal entity is registered, its jurisdiction, ' +
    'and its registration status. Says nothing about whether anyone worked there — employment still requires ' +
    'employer confirmation or a contracted verification service.';

  override supports(claim: AdapterClaimInput): boolean {
    return this.supportedCategories.includes(claim.category) && Boolean(claim.organizationName);
  }

  protected override async checkLive(query: SourceQuery): Promise<SourceCheckOutcome | null> {
    if (!liveSourcesEnabled()) return null;
    const name = query.claim.organizationName;
    if (!name) return null;

    const key = cacheKey(this.key, { name: normalizeOrganization(name) });
    const cached = cacheGet<SourceCheckOutcome>(key);
    if (cached) return { ...cached, retrievedAt: new Date() };

    const url =
      'https://api.gleif.org/api/v1/lei-records?page[size]=5&filter[entity.legalName]=' + encodeURIComponent(name);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': liveUserAgent(), accept: 'application/vnd.api+json' },
      });

      if (!response.ok) {
        return {
          result: SourceCheckResult.SOURCE_UNAVAILABLE,
          authorityLevel: this.authorityLevel,
          url,
          excerpt: null,
          detail: `GLEIF returned status ${response.status}. The check should be retried.`,
          retrievedAt: new Date(),
          isLive: true,
        };
      }

      const body = (await response.json()) as { data?: GleifRecord[] };
      const outcome = this.evaluate(body.data ?? [], name, url);
      cacheSet(key, outcome);
      return outcome;
    } catch (e) {
      return {
        result: SourceCheckResult.SOURCE_UNAVAILABLE,
        authorityLevel: this.authorityLevel,
        url,
        excerpt: null,
        detail: `Could not reach GLEIF: ${e instanceof Error ? e.message : 'unknown error'}. Retry the check.`,
        retrievedAt: new Date(),
        isLive: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exported shape of the mapping logic, unit-tested against recorded payloads. */
  evaluate(records: GleifRecord[], claimedName: string, url: string): SourceCheckOutcome {
    if (records.length === 0) {
      return {
        result: SourceCheckResult.RECORD_NOT_FOUND,
        authorityLevel: this.authorityLevel,
        url,
        excerpt: null,
        detail:
          `GLEIF holds no legal entity matching "${claimedName}". Many legitimate organisations have no LEI — ` +
          'the register covers entities participating in financial markets, so small firms, charities, schools, and ' +
          'sole traders are routinely absent. This does not indicate the organisation is not real.',
        retrievedAt: new Date(),
        isLive: true,
      };
    }

    const exact = records.find((r) => {
      const legal = r.attributes?.entity?.legalName?.name;
      return legal ? organizationsMatch(legal, claimedName) : false;
    });

    const chosen = exact ?? records[0]!;
    const entity = chosen.attributes?.entity;
    const legalName = entity?.legalName?.name ?? '(unnamed)';
    const country = entity?.legalAddress?.country ?? 'unknown jurisdiction';
    const city = entity?.legalAddress?.city;
    const status = entity?.status ?? 'unknown';
    const registration = chosen.attributes?.registration?.status ?? 'unknown';
    const lei = chosen.attributes?.lei ?? 'unknown';

    const excerpt =
      `LEI ${lei} — ${legalName}, ${city ? `${city}, ` : ''}${country}. ` +
      `Entity status: ${status}. Registration status: ${registration}.`;

    if (!exact) {
      return {
        result: SourceCheckResult.PARTIAL_MATCH,
        authorityLevel: this.authorityLevel,
        url,
        excerpt,
        detail:
          `GLEIF holds entities with similar names but none matching "${claimedName}" closely enough to be certain ` +
          'they are the same organisation. Organisations trade under names that differ from their registered legal ' +
          'name, so this is common and is not itself a concern.',
        retrievedAt: new Date(),
        isLive: true,
      };
    }

    return {
      result: SourceCheckResult.MATCH,
      authorityLevel: this.authorityLevel,
      url,
      excerpt,
      detail:
        `The organisation named in this claim is a registered legal entity (LEI ${lei}, ${country}). ` +
        'This confirms the organisation exists and is registered. It does NOT address whether the applicant was ' +
        'engaged there — no public register records employment. Confirming the engagement requires the employer.',
      retrievedAt: new Date(),
      isLive: true,
      raw: chosen,
    };
  }
}

interface RorRecord {
  id?: string;
  name?: string;
  status?: string;
  types?: string[];
  country?: { country_name?: string; country_code?: string };
  established?: number;
  aliases?: string[];
  acronyms?: string[];
  links?: string[];
}

/**
 * ROR — the Research Organization Registry.
 *
 * Open API, no key. Covers universities, research institutes, hospitals, and
 * government labs worldwide, including local-language names and acronyms, which
 * makes it good at exactly the cases naive matching gets wrong.
 */
export class RorOrganizationAdapter extends FixtureBackedAdapter {
  readonly key = 'ror';
  readonly name = 'Research Organization Registry (ROR)';
  readonly authorityLevel = AuthorityLevel.L2_OFFICIAL_WEBSITE;
  readonly supportedCategories: ClaimCategory[] = [
    ClaimCategory.EDUCATION_ENROLLMENT,
    ClaimCategory.DEGREE_AWARD,
    ClaimCategory.RESEARCH_POSITION,
  ];
  readonly integrationStatus: IntegrationStatus = 'LIVE_CAPABLE';
  readonly verifies = 'ORGANIZATION_EXISTENCE' as const;
  readonly integrationNote =
    'Open API, no credentials required. Confirms a research or educational institution exists, its country, and its ' +
    'known aliases and acronyms. Does not hold enrolment or employment records — those remain with the registrar.';

  override supports(claim: AdapterClaimInput): boolean {
    return this.supportedCategories.includes(claim.category) && Boolean(claim.organizationName);
  }

  protected override async checkLive(query: SourceQuery): Promise<SourceCheckOutcome | null> {
    if (!liveSourcesEnabled()) return null;
    const name = query.claim.organizationName;
    if (!name) return null;

    const key = cacheKey(this.key, { name: normalizeOrganization(name) });
    const cached = cacheGet<SourceCheckOutcome>(key);
    if (cached) return { ...cached, retrievedAt: new Date() };

    const url = 'https://api.ror.org/organizations?query=' + encodeURIComponent(name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': liveUserAgent(), accept: 'application/json' },
      });

      if (!response.ok) {
        return {
          result: SourceCheckResult.SOURCE_UNAVAILABLE,
          authorityLevel: this.authorityLevel,
          url,
          excerpt: null,
          detail: `ROR returned status ${response.status}. The check should be retried.`,
          retrievedAt: new Date(),
          isLive: true,
        };
      }

      const body = (await response.json()) as { items?: RorRecord[] };
      const outcome = this.evaluate(body.items ?? [], name, url);
      cacheSet(key, outcome);
      return outcome;
    } catch (e) {
      return {
        result: SourceCheckResult.SOURCE_UNAVAILABLE,
        authorityLevel: this.authorityLevel,
        url,
        excerpt: null,
        detail: `Could not reach ROR: ${e instanceof Error ? e.message : 'unknown error'}. Retry the check.`,
        retrievedAt: new Date(),
        isLive: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exported shape of the mapping logic, unit-tested against recorded payloads. */
  evaluate(items: RorRecord[], claimedName: string, url: string): SourceCheckOutcome {
    if (items.length === 0) {
      return {
        result: SourceCheckResult.RECORD_NOT_FOUND,
        authorityLevel: this.authorityLevel,
        url,
        excerpt: null,
        detail:
          `ROR holds no institution matching "${claimedName}". ROR covers research and higher-education ` +
          'organisations, so schools, colleges, and training providers outside that scope are expected to be absent. ' +
          'This does not indicate the institution is not real.',
        retrievedAt: new Date(),
        isLive: true,
      };
    }

    // ROR aliases and acronyms are what make a local-language or abbreviated
    // institution name resolve, which is precisely the case naive matching fails.
    const exact = items.find((item) => {
      const candidates = [item.name, ...(item.aliases ?? []), ...(item.acronyms ?? [])].filter((n): n is string =>
        Boolean(n),
      );
      return candidates.some((n) => organizationsMatch(n, claimedName));
    });

    if (!exact) {
      const best = items[0]!;
      return {
        result: SourceCheckResult.PARTIAL_MATCH,
        authorityLevel: this.authorityLevel,
        url,
        excerpt: `Closest ROR entry: ${best.name ?? '(unnamed)'} (${best.country?.country_name ?? 'unknown country'}).`,
        detail:
          `ROR returned institutions with similar names but none matching "${claimedName}" closely enough to be ` +
          'certain they are the same. Institutions are commonly referred to by informal or historical names.',
        retrievedAt: new Date(),
        isLive: true,
      };
    }

    const aliases = [...(exact.aliases ?? []), ...(exact.acronyms ?? [])].slice(0, 4);
    const excerpt =
      `${exact.name ?? '(unnamed)'} — ${exact.country?.country_name ?? 'unknown country'}` +
      `${exact.established ? `, established ${exact.established}` : ''}. ` +
      `ROR id ${exact.id ?? 'unknown'}. Status: ${exact.status ?? 'unknown'}.` +
      (aliases.length > 0 ? ` Also known as: ${aliases.join('; ')}.` : '');

    return {
      result: SourceCheckResult.MATCH,
      authorityLevel: this.authorityLevel,
      url,
      excerpt,
      detail:
        'The institution named in this claim is a registered research or educational organisation. ' +
        'This confirms the institution exists. It does NOT address whether the applicant studied or worked there — ' +
        'ROR holds no enrolment or employment records. Confirming that requires the registrar.',
      retrievedAt: new Date(),
      isLive: true,
      raw: exact,
    };
  }
}
