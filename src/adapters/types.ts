import type { AuthorityLevel, ClaimCategory, SourceCheckResult } from '@prisma/client';

/**
 * External source adapters.
 *
 * The most important contract in this file is the meaning of the result:
 *
 *   RECORD_NOT_FOUND  — the source was reached and holds no record of this.
 *                       This is an EVIDENCE GAP. It can never become
 *                       conflicting evidence, and it never supports an
 *                       inference that the claim is untrue. Many legitimate
 *                       achievements are simply not in any queryable registry.
 *
 *   NO_MATCH          — the source holds a record for this thing and it states
 *                       something materially different. This is the only result
 *                       that may become conflicting evidence.
 *
 *   SOURCE_UNAVAILABLE / ERROR — we could not reach the source. Says nothing
 *                       about the claim; the check should be retried.
 *
 * Conflating RECORD_NOT_FOUND with NO_MATCH would turn an unanswered question
 * into an accusation. Adapters are tested for this distinction.
 *
 * Adapters never assign a claim status and never write to the database.
 */

export interface AdapterClaimInput {
  id: string;
  category: ClaimCategory;
  normalizedText: string;
  sourcePassage: string;
  personName: string | null;
  organizationName: string | null;
  title: string | null;
  startDate: Date | null;
  endDate: Date | null;
  amountValue: number | null;
  amountUnit: string | null;
}

export interface SourceQuery {
  claim: AdapterClaimInput;
  /** Name on the application, used when the claim itself does not carry one. */
  applicantName: string;
}

export interface SourceCheckOutcome {
  result: SourceCheckResult;
  authorityLevel: AuthorityLevel;
  url: string | null;
  /** Relevant passage from the source, quoted for the evidence trail. */
  excerpt: string | null;
  /** Neutral explanation shown to reviewers. Never a fraud conclusion. */
  detail: string;
  retrievedAt: Date;
  isLive: boolean;
  /** Raw payload, persisted to object storage rather than inline. */
  raw?: unknown;
}

export type IntegrationStatus =
  /** A real implementation exists and runs when ENABLE_LIVE_SOURCES=true. */
  | 'LIVE_CAPABLE'
  /** Interface and fixtures only; production access needs work beyond code. */
  | 'PLACEHOLDER';

/**
 * What an adapter's output actually establishes.
 *
 * `ORGANIZATION_EXISTENCE` adapters confirm the organisation named in a claim is
 * real and registered. They say nothing about whether the applicant was ever
 * engaged there, so their evidence is recorded as ORGANIZATION_CONTEXT and is
 * excluded from the status proposal.
 */
export type AdapterVerifies = 'CLAIM' | 'ORGANIZATION_EXISTENCE';

export interface SourceAdapter {
  readonly key: string;
  readonly name: string;
  readonly authorityLevel: AuthorityLevel;
  readonly supportedCategories: ClaimCategory[];
  readonly integrationStatus: IntegrationStatus;
  /** Defaults to CLAIM when an adapter does not declare it. */
  readonly verifies?: AdapterVerifies;
  /**
   * What production access actually requires — credentials, a contract, a
   * jurisdiction-specific legal basis. Surfaced in the admin UI so an operator
   * can see at a glance which sources are real and which are simulated.
   */
  readonly integrationNote: string;
  supports(claim: AdapterClaimInput): boolean;
  check(query: SourceQuery): Promise<SourceCheckOutcome>;
}
