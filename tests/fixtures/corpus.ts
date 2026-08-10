/**
 * Labelled evaluation corpus.
 *
 * Every person, institution, employer, and competition here is invented. Real
 * résumés are deliberately NOT used, and not because of squeamishness:
 *
 *   You cannot evaluate a verification system on real applications, because you
 *   do not know the ground truth. If a real CV says "Senior Engineer at Acme,
 *   2019–2022" you have no way to know whether that is accurate, so a flag the
 *   system raises cannot be scored as a true or false positive. Measuring
 *   accuracy REQUIRES knowing the answer in advance, which means synthetic data.
 *
 * So each case below carries labels: which observations a correct system must
 * raise (`expectedFindings`), and — more importantly — which it must NOT raise
 * (`mustNotFlag`). The second list is what stops a verification tool from
 * quietly becoming a machine for punishing unusual but legitimate lives.
 */

export interface CorpusCase {
  key: string;
  /** What situation this case is testing. */
  scenario: string;
  policyKey: 'university-application' | 'job-application';
  documents: Array<{ filename: string; kind: 'RESUME_CV' | 'APPLICATION' | 'RECOMMENDATION_LETTER'; content: string }>;
  /** Discrepancy kinds a correct system must raise. */
  expectedFindings: string[];
  /**
   * Discrepancy kinds that would be FALSE POSITIVES here. A system that raises
   * any of these has harmed a legitimate applicant.
   */
  mustNotFlag: string[];
  /** Claim texts the extractor must find, matched case-insensitively. */
  expectedClaimSubstrings: string[];
}

export const CORPUS: CorpusCase[] = [
  // ------------------------------------------------------------ true positives
  {
    key: 'title-and-date-divergence',
    scenario: 'Résumé and application form state different titles and start dates for the same employer.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Senior Software Engineer, Northwind Analytics (Mar 2021 - Present)

EDUCATION
B.S. Computer Science, Riverton State University (Aug 2016 - May 2020)
`,
      },
      {
        filename: 'form.txt',
        kind: 'APPLICATION',
        content: `EXPERIENCE
Software Engineer, Northwind Analytics (Jun 2021 - Present)

EDUCATION
B.S. Computer Science, Riverton State University (Aug 2016 - May 2020)
`,
      },
    ],
    expectedFindings: ['TITLE_MISMATCH', 'CONFLICTING_DATES'],
    mustNotFlag: ['OVERLAPPING_FULL_TIME_COMMITMENT'],
    expectedClaimSubstrings: ['Northwind Analytics', 'Riverton State University'],
  },
  {
    key: 'award-level-divergence',
    scenario: 'The same competition result is described at two different levels across documents.',
    policyKey: 'university-application',
    documents: [
      {
        filename: 'cv.txt',
        kind: 'RESUME_CV',
        content: `AWARDS
First Place, Cascadia Junior Physics Olympiad (2024)
`,
      },
      {
        filename: 'statement.txt',
        kind: 'APPLICATION',
        content: `AWARDS
Finalist, Cascadia Junior Physics Olympiad (2024)
`,
      },
    ],
    expectedFindings: ['AWARD_LEVEL_INCONSISTENCY'],
    mustNotFlag: ['CLAIM_SOURCE_CONFLICT'],
    expectedClaimSubstrings: ['Cascadia Junior Physics Olympiad'],
  },
  {
    key: 'impossible-hours',
    scenario: 'A volunteer-hours total exceeds the hours available in the stated period.',
    policyKey: 'university-application',
    documents: [
      {
        filename: 'cv.txt',
        kind: 'RESUME_CV',
        content: `VOLUNTEER
Shelter Coordinator, Elmwood Community Trust (Jan 2024 - Feb 2024)
- Contributed 4000 hours of coordination during the winter programme
`,
      },
    ],
    expectedFindings: ['ARITHMETIC_INCONSISTENCY'],
    mustNotFlag: ['DOCUMENT_ANOMALY'],
    expectedClaimSubstrings: ['Elmwood Community Trust'],
  },
  {
    key: 'genuine-simultaneous-full-time',
    scenario: 'Two full-time roles at different employers overlap by most of a year.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Staff Engineer, Halcyon Systems (Jan 2022 - Dec 2022)
Staff Engineer, Brightwater Robotics (Feb 2022 - Nov 2022)
`,
      },
    ],
    expectedFindings: ['OVERLAPPING_FULL_TIME_COMMITMENT'],
    mustNotFlag: ['TITLE_MISMATCH'],
    expectedClaimSubstrings: ['Halcyon Systems', 'Brightwater Robotics'],
  },

  // ------------------------------------------------------------ true negatives
  // Every case below describes an ordinary life. A finding here is a failure.
  {
    key: 'student-working-during-degree',
    scenario: 'A summer internship during a degree programme. The commonest false positive in screening.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EDUCATION
B.S. Computer Science, Riverton State University (Aug 2016 - May 2020)

EXPERIENCE
Software Engineering Intern, Northwind Analytics (Jun 2019 - Aug 2019)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['OVERLAPPING_FULL_TIME_COMMITMENT', 'CONFLICTING_DATES', 'TITLE_MISMATCH'],
    expectedClaimSubstrings: ['Riverton State University', 'Northwind Analytics'],
  },
  {
    key: 'employer-renamed-itself',
    scenario: 'The same employment described under the company name before and after a corporate rename.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Software Engineer, Facebook, Inc. (Jan 2020 - Dec 2022)
`,
      },
      {
        filename: 'form.txt',
        kind: 'APPLICATION',
        content: `EXPERIENCE
Software Engineer, Meta Platforms (Jan 2020 - Dec 2022)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['OVERLAPPING_FULL_TIME_COMMITMENT', 'ORGANIZATION_NAME_MISMATCH', 'CONFLICTING_DATES'],
    expectedClaimSubstrings: ['Facebook', 'Meta Platforms'],
  },
  {
    key: 'international-institution-two-languages',
    scenario: 'A university named in Spanish on one document and in English on another.',
    policyKey: 'university-application',
    documents: [
      {
        filename: 'cv.txt',
        kind: 'RESUME_CV',
        content: `EDUCATION
Licenciatura en Física, Universidad Nacional Autónoma de México (Aug 2018 - Jun 2022)
`,
      },
      {
        filename: 'form.txt',
        kind: 'APPLICATION',
        content: `EDUCATION
Licenciatura en Física, UNAM (Aug 2018 - Jun 2022)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['ORGANIZATION_NAME_MISMATCH', 'OVERLAPPING_FULL_TIME_COMMITMENT', 'CONFLICTING_DATES'],
    expectedClaimSubstrings: ['Universidad Nacional Autónoma de México'],
  },
  {
    key: 'equivalent-job-titles',
    scenario: 'The same role described as "Software Engineer" and "Software Developer".',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Software Engineer, Northwind Analytics (Jan 2020 - Dec 2022)
`,
      },
      {
        filename: 'form.txt',
        kind: 'APPLICATION',
        content: `EXPERIENCE
Software Developer, Northwind Analytics (Jan 2020 - Dec 2022)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['TITLE_MISMATCH', 'CONFLICTING_DATES'],
    expectedClaimSubstrings: ['Northwind Analytics'],
  },
  {
    key: 'part-time-alongside-full-time',
    scenario: 'An advisory role held alongside a full-time job.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Staff Engineer, Halcyon Systems (Jan 2022 - Dec 2023)
Part-time Technical Advisor, Elmwood Community Trust (Mar 2022 - Dec 2023)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['OVERLAPPING_FULL_TIME_COMMITMENT'],
    expectedClaimSubstrings: ['Halcyon Systems', 'Elmwood Community Trust'],
  },
  {
    key: 'obscure-award-no-online-record',
    scenario:
      'A genuine but tiny local prize that no registry has ever heard of. Absence of a record must produce no finding.',
    policyKey: 'university-application',
    documents: [
      {
        filename: 'cv.txt',
        kind: 'RESUME_CV',
        content: `AWARDS
Regional Winner, Nowhere Valley Junior Science Fair (2022)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['CLAIM_SOURCE_CONFLICT', 'AWARD_LEVEL_INCONSISTENCY', 'PUBLICATION_AUTHORSHIP_DISCREPANCY'],
    expectedClaimSubstrings: ['Nowhere Valley Junior Science Fair'],
  },
  {
    key: 'coarse-dates-only',
    scenario: 'Two roles stated only to the year, touching at a boundary. Precision cannot support a conflict finding.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Analyst, Halcyon Systems (2020 - 2022)
Analyst, Brightwater Robotics (2022 - 2024)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['OVERLAPPING_FULL_TIME_COMMITMENT', 'CONFLICTING_DATES'],
    expectedClaimSubstrings: ['Halcyon Systems', 'Brightwater Robotics'],
  },
  {
    key: 'career-break-and-return',
    scenario: 'A multi-year gap between roles. A gap is not a discrepancy and must never be flagged.',
    policyKey: 'job-application',
    documents: [
      {
        filename: 'resume.txt',
        kind: 'RESUME_CV',
        content: `EXPERIENCE
Analyst, Halcyon Systems (Jan 2015 - Dec 2017)
Senior Analyst, Brightwater Robotics (Jan 2021 - Dec 2023)
`,
      },
    ],
    expectedFindings: [],
    mustNotFlag: ['OVERLAPPING_FULL_TIME_COMMITMENT', 'CONFLICTING_DATES', 'TITLE_MISMATCH'],
    expectedClaimSubstrings: ['Halcyon Systems', 'Brightwater Robotics'],
  },
];

/** Cases whose correct output is "no findings at all". */
export const NEGATIVE_CASES = CORPUS.filter((c) => c.expectedFindings.length === 0);
export const POSITIVE_CASES = CORPUS.filter((c) => c.expectedFindings.length > 0);
