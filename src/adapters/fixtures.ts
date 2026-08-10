import { SourceCheckResult } from '@prisma/client';
import { organizationKey, normalizeTitle, comparePersonNames, extractDoi, normalizeText } from '@/lib/text';
import type { AdapterClaimInput } from './types';

/**
 * Recorded fixtures backing every adapter by default.
 *
 * All organisations, people, awards, and identifiers here are fictional. No
 * real applicant data is used anywhere in this repository.
 *
 * Fixtures are matched deterministically so tests and the seeded demonstration
 * cases produce identical evidence on every run.
 */

export interface FixtureRecord {
  adapterKey: string;
  /** All specified selectors must match for the record to apply. */
  match: {
    doi?: string;
    organization?: string;
    title?: string;
    person?: string;
    /** Substring of the normalized claim text. */
    textIncludes?: string;
  };
  result: SourceCheckResult;
  url: string | null;
  excerpt: string | null;
  detail: string;
}

export const FIXTURES: FixtureRecord[] = [
  // ---------------------------------------------------------------- Case 1
  {
    adapterKey: 'crossref',
    match: { doi: '10.5281/zenodo.7654321' },
    result: SourceCheckResult.MATCH,
    url: 'https://doi.org/10.5281/zenodo.7654321',
    excerpt:
      'Okonkwo, A.; Adeyemi, T. (2024). "Low-cost spectrometry for classroom physics: a field trial in three Lagos schools." ' +
      'Journal of Undergraduate Physics Education, 12(2), 44–58.',
    detail: 'DOI resolves to a registered work whose title and first author match the claim.',
  },
  {
    adapterKey: 'award-database',
    match: { organization: 'Nigerian Mathematics Olympiad', textIncludes: 'national finalist' },
    result: SourceCheckResult.MATCH,
    url: 'https://example-olympiad.org/2024/finalists',
    excerpt:
      'National Finalists, 2024 cohort: … Amara Okonkwo (Lagos International College) … Listed under Senior Division.',
    detail: 'The published finalist list for the stated year includes a person of this name at the stated school.',
  },
  {
    adapterKey: 'university-registrar',
    match: { organization: 'Lagos International College' },
    result: SourceCheckResult.MATCH,
    url: null,
    excerpt:
      'Registrar confirmation: enrolment 2021-09 to 2025-06, Diploma Programme, in good standing. Confirmed by the ' +
      'records office through the approved verification channel.',
    detail: 'Enrolment dates and programme match the claim.',
  },
  {
    adapterKey: 'university-registrar',
    match: { organization: 'University of Lagos' },
    result: SourceCheckResult.MATCH,
    url: null,
    excerpt:
      'Department of Physics confirms a summer research assistant placement, June–August 2024, supervised by ' +
      'Dr. T. Adeyemi.',
    detail: 'Department confirms the placement and its dates.',
  },

  // ---------------------------------------------------------------- Case 2
  {
    adapterKey: 'employer-confirmation',
    match: { organization: 'Northwind Analytics' },
    result: SourceCheckResult.MATCH,
    url: null,
    excerpt:
      'People Operations confirms continuous employment from 2021-03-15 to date. Title history: Software Engineer II ' +
      '(2021-03-15 to 2023-01-31), Senior Software Engineer (2023-02-01 to present). Initial three months were a ' +
      'contract-to-hire engagement converted to permanent on 2021-06-14.',
    detail:
      'The employer confirms both titles and both start dates. The two documents each stated one part of the same ' +
      'employment history.',
  },
  {
    adapterKey: 'university-registrar',
    match: { organization: 'Riverton State University' },
    result: SourceCheckResult.MATCH,
    url: null,
    excerpt: 'Registrar confirms B.S. Computer Science conferred 2020-05-16. Enrolment 2016-08 to 2020-05.',
    detail: 'Degree, field, and conferral date match the claim.',
  },

  // ---------------------------------------------------------------- Case 3
  {
    // The registry HOLDS a record and it says something different. This is the
    // only shape of result that may become conflicting evidence.
    adapterKey: 'award-database',
    match: { organization: 'International Robotics Challenge', textIncludes: 'first place' },
    result: SourceCheckResult.NO_MATCH,
    url: 'https://example-robotics-challenge.org/2023/results',
    excerpt:
      '2023 Open Division final standings: 1st — Team Helios (Seoul); 2nd — Team Vanguard (Toronto); ' +
      '3rd — Team Kestrel (Bengaluru); 4th — Team Aurora (Chennai). Team Aurora roster includes P. Raman.',
    detail:
      'The published results for this competition and year list the named team in fourth place rather than first. ' +
      'Both the results page and the claim refer to the same event.',
  },
  {
    adapterKey: 'web-archive',
    match: { organization: 'International Robotics Challenge' },
    result: SourceCheckResult.NO_MATCH,
    url: 'https://web.archive.example/2023/robotics-results',
    excerpt:
      'Archived capture of the official results page dated 2023-11-02 shows the same final standings, with Team ' +
      'Helios in first place.',
    detail:
      'An independent archived capture of the official page taken shortly after the event shows the same standings ' +
      'as the live page, so the discrepancy is not explained by a later edit to the site.',
  },
  {
    adapterKey: 'crossref',
    match: { doi: '10.1109/exampleconf.2023.99881' },
    result: SourceCheckResult.PARTIAL_MATCH,
    url: 'https://doi.org/10.1109/exampleconf.2023.99881',
    excerpt:
      'Sundaram, K.; Iyer, M.; Raman, P. (2023). "Adaptive grasp planning under partial occlusion." ' +
      'Proceedings of the Example Conference on Robotics, pp. 210–219.',
    detail:
      'The DOI resolves and the named person appears in the author list, in third position rather than as first ' +
      'author. Author order conventions vary by field and by group.',
  },

  // ------------------------------------------- organisation existence (offline)
  // Demonstrates the central distinction: the firm is confirmed real, while the
  // engagement remains unverifiable by any public source.
  {
    adapterKey: 'gleif',
    match: { organization: 'Star Mountain Capital' },
    result: SourceCheckResult.MATCH,
    url: 'https://search.gleif.org/',
    excerpt:
      'LEI 5493001KJTIIGC8Y1R12 — STAR MOUNTAIN CAPITAL EXAMPLE LLC, New York, US. Entity status: ACTIVE. ' +
      'Registration status: ISSUED.',
    detail:
      'The organisation named in this claim is a registered legal entity. This confirms the organisation exists ' +
      'and is registered. It does NOT address whether the applicant was engaged there — no public register records ' +
      'employment. Confirming the engagement requires the employer.',
  },
  {
    adapterKey: 'gleif',
    match: { organization: 'Northwind Analytics' },
    result: SourceCheckResult.MATCH,
    url: 'https://search.gleif.org/',
    excerpt: 'LEI 549300EXAMPLE0NW1234 — NORTHWIND ANALYTICS LLC, Boston, US. Entity status: ACTIVE.',
    detail:
      "The employer named in this claim is a registered legal entity. This does not address the applicant's " +
      'engagement there.',
  },
  {
    adapterKey: 'ror',
    match: { organization: 'Riverton State University' },
    result: SourceCheckResult.MATCH,
    url: 'https://ror.org/',
    excerpt:
      'Riverton State University — United States, established 1891. ROR id https://ror.org/00example1. ' +
      'Status: active. Also known as: RSU.',
    detail:
      'The institution named in this claim is a registered educational organisation. ROR holds no enrolment ' +
      'records, so this does not address whether the applicant studied there.',
  },
  {
    adapterKey: 'ror',
    match: { organization: 'Lagos International College' },
    result: SourceCheckResult.RECORD_NOT_FOUND,
    url: 'https://ror.org/',
    excerpt: null,
    detail:
      'ROR holds no institution matching this name. ROR covers research and higher-education organisations, so ' +
      'secondary schools are expected to be absent. This does not indicate the institution is not real.',
  },

  // ---------------------------------------------------------------- adversarial
  {
    // Ambiguous name: a real record exists but cannot be tied to this person.
    adapterKey: 'award-database',
    match: { organization: 'Midwest Collegiate Debate Association' },
    result: SourceCheckResult.INCONCLUSIVE,
    url: 'https://example-debate.org/champions',
    excerpt: 'Regional champions 2022: J. Smith (Central State). No first name or affiliation detail published.',
    detail:
      'A record with a matching family name and initial exists, but the published entry carries too little detail to ' +
      'establish that it refers to this applicant. This is not evidence for or against the claim.',
  },
  {
    // Organisation renamed. Must resolve, not be flagged as a mismatch.
    adapterKey: 'employer-confirmation',
    match: { organization: 'Meta Platforms' },
    result: SourceCheckResult.MATCH,
    url: null,
    excerpt:
      'Employment verification confirms the stated dates and title. Note: the organisation was named Facebook, Inc. ' +
      'during part of the period stated and was renamed Meta Platforms, Inc. in October 2021.',
    detail: 'Employer confirms the engagement. The differing organisation name reflects a corporate rename.',
  },
  {
    // International organisation under a local-language name.
    adapterKey: 'university-registrar',
    match: { organization: 'Universidad Nacional Autónoma de México' },
    result: SourceCheckResult.MATCH,
    url: null,
    excerpt:
      'La Dirección General de Administración Escolar confirma la inscripción del solicitante y la conclusión de ' +
      'estudios. (Registrar confirms enrolment and completion of studies.)',
    detail: 'The institution confirms enrolment. The claim and the record refer to the same university.',
  },
  {
    // Source that simply cannot be reached. Must be retried, never inferred from.
    adapterKey: 'license-registry',
    match: { organization: 'State Board of Professional Surveyors' },
    result: SourceCheckResult.SOURCE_UNAVAILABLE,
    url: 'https://example-surveyors-board.gov/lookup',
    excerpt: null,
    detail:
      'The registry lookup service did not respond. No conclusion can be drawn from this; the check should be ' +
      'retried or the board contacted directly.',
  },
  {
    adapterKey: 'license-registry',
    match: { organization: 'National Council of Clinical Laboratory Technicians' },
    result: SourceCheckResult.MATCH,
    url: 'https://example-nccltech.org/verify',
    excerpt: 'Certificate #CLT-2019-44821 — status: Active. Issued 2019-04-02. Renewed 2023-04-01.',
    detail: 'The certification registry lists an active certificate matching the claim.',
  },
  {
    adapterKey: 'patent-registry',
    match: { textIncludes: 'patent' },
    result: SourceCheckResult.RECORD_NOT_FOUND,
    url: 'https://example-patent-office.gov/search',
    excerpt: null,
    detail:
      'No granted patent matching these details was found in the searched collection. Applications are typically not ' +
      'published until 18 months after filing, so a pending application would not appear here.',
  },
];

/**
 * Finds the fixture that applies to a claim, or null when the fixture set holds
 * nothing — which adapters translate to RECORD_NOT_FOUND, an evidence gap.
 */
export function findFixture(adapterKey: string, claim: AdapterClaimInput, applicantName: string): FixtureRecord | null {
  const claimDoi =
    extractDoi(claim.sourcePassage) ?? extractDoi(claim.normalizedText) ?? extractDoi(claim.amountUnit ?? '');
  const claimText = normalizeText(`${claim.normalizedText} ${claim.sourcePassage}`);

  for (const fixture of FIXTURES) {
    if (fixture.adapterKey !== adapterKey) continue;
    const m = fixture.match;

    if (m.doi !== undefined) {
      if (!claimDoi || claimDoi.toLowerCase() !== m.doi.toLowerCase()) continue;
    }
    if (m.organization !== undefined) {
      const claimOrg = claim.organizationName;
      if (!claimOrg) continue;
      if (organizationKey(claimOrg) !== organizationKey(m.organization)) continue;
    }
    if (m.title !== undefined) {
      if (!claim.title || normalizeTitle(claim.title) !== normalizeTitle(m.title)) continue;
    }
    if (m.person !== undefined) {
      const candidate = claim.personName ?? applicantName;
      if (!comparePersonNames(candidate, m.person).match) continue;
    }
    if (m.textIncludes !== undefined) {
      if (!claimText.includes(normalizeText(m.textIncludes))) continue;
    }

    return fixture;
  }

  return null;
}
