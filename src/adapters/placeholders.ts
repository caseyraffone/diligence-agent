import { AuthorityLevel, ClaimCategory } from '@prisma/client';
import { FixtureBackedAdapter } from './base';
import type { IntegrationStatus } from './types';

/**
 * Adapters whose interface and fixtures are complete, but whose production
 * implementation needs something code cannot supply: a contract, credentials, a
 * lawful basis, or per-jurisdiction work.
 *
 * They are shipped as working fixture adapters rather than omitted, so the
 * verification workflow, the evidence trail, and the reports are exercised
 * end to end — and so the gap between "simulated" and "live" is visible in the
 * admin screen instead of hidden in a backlog.
 *
 * Each `integrationNote` states what real access actually requires. Read them
 * before promising a customer a go-live date.
 */

export class OrcidAdapter extends FixtureBackedAdapter {
  readonly key = 'orcid';
  readonly name = 'ORCID researcher registry';
  readonly authorityLevel = AuthorityLevel.L4_SIGNED_VERIFIABLE_RECORD;
  readonly supportedCategories = [ClaimCategory.PUBLICATION, ClaimCategory.RESEARCH_POSITION];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'ORCID has a public API, but meaningful use requires the applicant to supply and authenticate their own ORCID iD ' +
    '(via ORCID OAuth) — matching a name to an iD without that step is unreliable and risks attaching the wrong ' +
    'person\'s record. Production also needs an ORCID member client id/secret for the member API. Implement only ' +
    'alongside an applicant-authenticated iD collection step.';
}

export class UniversityRegistrarAdapter extends FixtureBackedAdapter {
  readonly key = 'university-registrar';
  readonly name = 'University registrar / enrolment verification';
  readonly authorityLevel = AuthorityLevel.L1_ISSUING_AUTHORITY;
  readonly supportedCategories = [
    ClaimCategory.EDUCATION_ENROLLMENT,
    ClaimCategory.DEGREE_AWARD,
    ClaimCategory.RESEARCH_POSITION,
  ];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'Requires an agreement with each institution or a clearinghouse intermediary, plus documented applicant consent ' +
    'for education-record disclosure. In the United States this is FERPA-governed; in the EU/UK it needs an Article 6 ' +
    'lawful basis and, in practice, an explicit consent record. There is no general-purpose public API — production ' +
    'integrations are per-institution or per-clearinghouse and are commercially negotiated.';
}

export class EmployerConfirmationAdapter extends FixtureBackedAdapter {
  readonly key = 'employer-confirmation';
  readonly name = 'Employer / employment verification';
  readonly authorityLevel = AuthorityLevel.L1_ISSUING_AUTHORITY;
  readonly supportedCategories = [ClaimCategory.EMPLOYMENT, ClaimCategory.RESEARCH_POSITION];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'Employment verification is either a commercial data service under contract, or direct outreach to the employer. ' +
    'Where it informs an employment decision in the United States it is likely a consumer report under the FCRA, ' +
    'which brings disclosure, authorization, and adverse-action obligations. Treat the outreach workflow — a reviewer ' +
    'drafting, approving, and sending a request themselves — as the supported path until counsel has signed off.';
}

export class AwardDatabaseAdapter extends FixtureBackedAdapter {
  readonly key = 'award-database';
  readonly name = 'Award and competition results';
  readonly authorityLevel = AuthorityLevel.L2_OFFICIAL_WEBSITE;
  readonly supportedCategories = [ClaimCategory.AWARD_COMPETITION, ClaimCategory.ATHLETIC_PARTICIPATION];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'There is no unified results database; each competition publishes its own, in its own format, often as HTML or ' +
    'PDF. Production means a per-organizer adapter, and only where the organizer\'s terms permit automated access. ' +
    'Do not implement this as a generic scraper. Older results are frequently offline entirely — absence here is ' +
    'especially weak signal.';
}

export class AthleticRosterAdapter extends FixtureBackedAdapter {
  readonly key = 'athletic-roster';
  readonly name = 'Official team rosters and results';
  readonly authorityLevel = AuthorityLevel.L2_OFFICIAL_WEBSITE;
  readonly supportedCategories = [ClaimCategory.ATHLETIC_PARTICIPATION];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'Rosters live on individual school, club, and federation sites. Historical rosters are routinely removed at the ' +
    'end of a season, so a current-page check cannot confirm past participation and its absence proves nothing. ' +
    'Governing-body record APIs, where they exist, generally require membership.';
}

export class LicenseRegistryAdapter extends FixtureBackedAdapter {
  readonly key = 'license-registry';
  readonly name = 'Professional licence and certification registries';
  readonly authorityLevel = AuthorityLevel.L1_ISSUING_AUTHORITY;
  readonly supportedCategories = [ClaimCategory.CERTIFICATION_LICENSE];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'Licensing is per-jurisdiction and per-profession: each board runs its own lookup, many are HTML-only, some ' +
    'prohibit automated querying in their terms of use, and a few charge for API access. Implement board by board, ' +
    'checking each one\'s terms first. Never build a generic scraper across boards.';
}

export class PatentRegistryAdapter extends FixtureBackedAdapter {
  readonly key = 'patent-registry';
  readonly name = 'Patent and trademark registries';
  readonly authorityLevel = AuthorityLevel.L1_ISSUING_AUTHORITY;
  readonly supportedCategories = [ClaimCategory.PROJECT_VENTURE_PATENT];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'USPTO (PatentsView / Open Data Portal), EPO OPS, and WIPO PATENTSCOPE all offer APIs; EPO OPS requires ' +
    'registration and a key, and PatentsView requires a free API key. Inventor-name matching is genuinely hard — ' +
    'names are not unique and are often recorded inconsistently. Note that applications are not published until ' +
    'roughly 18 months after filing, so a pending application legitimately has no public record.';
}

export class WebArchiveAdapter extends FixtureBackedAdapter {
  readonly key = 'web-archive';
  readonly name = 'Archived official pages';
  readonly authorityLevel = AuthorityLevel.L5_INDEPENDENT_REPORTING;
  readonly supportedCategories = [
    ClaimCategory.AWARD_COMPETITION,
    ClaimCategory.EMPLOYMENT,
    ClaimCategory.PROJECT_VENTURE_PATENT,
    ClaimCategory.VOLUNTEER_LEADERSHIP,
    ClaimCategory.ATHLETIC_PARTICIPATION,
  ];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote =
    'The Internet Archive Wayback Machine has a public availability API suitable for checking whether an official ' +
    'page said something different at a past date — useful when a site has since been edited. Coverage is uneven and ' +
    'a missing capture means nothing. Respect the archive\'s rate limits, and never use archives to reach content ' +
    'that was behind authentication.';
}
