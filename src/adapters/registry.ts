import type { ClaimCategory } from '@prisma/client';
import type { AdapterClaimInput, SourceAdapter } from './types';
import { CrossrefAdapter } from './crossref';
import { PubMedAdapter } from './pubmed';
import {
  AthleticRosterAdapter,
  AwardDatabaseAdapter,
  EmployerConfirmationAdapter,
  LicenseRegistryAdapter,
  OrcidAdapter,
  PatentRegistryAdapter,
  UniversityRegistrarAdapter,
  WebArchiveAdapter,
} from './placeholders';

/**
 * Adapter registry.
 *
 * Adding a source means adding one class and one line here. Nothing in the
 * verification domain changes.
 */
const ADAPTERS: SourceAdapter[] = [
  new CrossrefAdapter(),
  new PubMedAdapter(),
  new OrcidAdapter(),
  new UniversityRegistrarAdapter(),
  new EmployerConfirmationAdapter(),
  new AwardDatabaseAdapter(),
  new AthleticRosterAdapter(),
  new LicenseRegistryAdapter(),
  new PatentRegistryAdapter(),
  new WebArchiveAdapter(),
];

export function allAdapters(): SourceAdapter[] {
  return [...ADAPTERS];
}

export function getAdapter(key: string): SourceAdapter | null {
  return ADAPTERS.find((a) => a.key === key) ?? null;
}

/**
 * Adapters applicable to a claim, ordered most-authoritative first, filtered to
 * the policy's approved source list.
 *
 * A policy that approves no source for a category is a real configuration
 * answer, not an error: it means "this organisation checks that category by
 * human outreach only".
 */
export function adaptersForClaim(claim: AdapterClaimInput, approvedKeys: string[]): SourceAdapter[] {
  const approved = new Set(approvedKeys);
  return ADAPTERS.filter((a) => approved.has(a.key) && a.supports(claim)).sort(
    (a, b) => rank(a) - rank(b),
  );
}

function rank(adapter: SourceAdapter): number {
  // AuthorityLevel enum values sort correctly by their L-prefix ordinal.
  const order = [
    'L1_ISSUING_AUTHORITY',
    'L2_OFFICIAL_WEBSITE',
    'L3_AUTHORIZED_REPRESENTATIVE',
    'L4_SIGNED_VERIFIABLE_RECORD',
    'L5_INDEPENDENT_REPORTING',
    'L6_APPLICANT_PROVIDED',
    'L7_INFORMAL_SELF_PUBLISHED',
  ];
  return order.indexOf(adapter.authorityLevel);
}

export function adaptersForCategory(category: ClaimCategory): SourceAdapter[] {
  return ADAPTERS.filter((a) => a.supportedCategories.includes(category));
}

export type { SourceAdapter } from './types';
