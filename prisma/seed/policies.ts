import { ClaimCategory, UseCase } from '@prisma/client';

/**
 * Built-in verification policy templates.
 *
 * A policy is how an organisation encodes its own standards: which claim types
 * it cares about, which sources it accepts, what evidence is required before a
 * reviewer may record "verified", how long records are kept, when a case
 * escalates, and what language appears on the report.
 *
 * `approvedSourceKeys` is the security-relevant field: an adapter that is not
 * listed is never consulted for that policy, no matter what the claim is.
 */

export interface PolicyTemplateSeed {
  key: string;
  name: string;
  useCase: UseCase;
  description: string;
  relevantClaimCategories: ClaimCategory[];
  approvedSourceKeys: string[];
  evidenceRequirements: {
    minAuthorityForVerified: string;
    minAuthorityForCorroborated: string;
    requireTwoIndependentSourcesForAwards: boolean;
    applicantEvidenceAloneIsNeverVerified: boolean;
  };
  retentionDays: number;
  escalationRules: {
    escalateOnConflictingInformation: boolean;
    escalateAfterFailedChecks: number;
    escalateWhenDocumentAnomalyObserved: boolean;
  };
  reportLanguage: {
    header: string;
    footer: string;
  };
}

const COMMON_FOOTER =
  'This report supports human judgement and does not make or recommend a decision about any person. ' +
  'Inability to verify a claim is not evidence that the claim is untrue.';

export const POLICY_TEMPLATES: PolicyTemplateSeed[] = [
  {
    key: 'university-application',
    name: 'University application review',
    useCase: UseCase.UNIVERSITY_APPLICATION,
    description:
      'Verification of academic history, awards, research, and activities declared in an undergraduate or ' +
      'postgraduate application.',
    relevantClaimCategories: [
      ClaimCategory.EDUCATION_ENROLLMENT,
      ClaimCategory.DEGREE_AWARD,
      ClaimCategory.AWARD_COMPETITION,
      ClaimCategory.RESEARCH_POSITION,
      ClaimCategory.PUBLICATION,
      ClaimCategory.ATHLETIC_PARTICIPATION,
      ClaimCategory.VOLUNTEER_LEADERSHIP,
      ClaimCategory.QUANTITATIVE_METRIC,
    ],
    approvedSourceKeys: [
      'university-registrar',
      'award-database',
      'crossref',
      'pubmed',
      'orcid',
      'athletic-roster',
      'web-archive',
    ],
    evidenceRequirements: {
      minAuthorityForVerified: 'L3_AUTHORIZED_REPRESENTATIVE',
      minAuthorityForCorroborated: 'L5_INDEPENDENT_REPORTING',
      requireTwoIndependentSourcesForAwards: true,
      applicantEvidenceAloneIsNeverVerified: true,
    },
    retentionDays: 730,
    escalationRules: {
      escalateOnConflictingInformation: true,
      escalateAfterFailedChecks: 2,
      escalateWhenDocumentAnomalyObserved: true,
    },
    reportLanguage: {
      header:
        'Application verification summary. Prepared for a trained admissions reviewer. Not an admissions decision ' +
        'and not a recommendation.',
      footer: COMMON_FOOTER,
    },
  },
  {
    key: 'job-application',
    name: 'Employment application review',
    useCase: UseCase.JOB_APPLICATION,
    description: 'Verification of employment history, education, certifications, and stated accomplishments.',
    relevantClaimCategories: [
      ClaimCategory.EMPLOYMENT,
      ClaimCategory.EDUCATION_ENROLLMENT,
      ClaimCategory.DEGREE_AWARD,
      ClaimCategory.CERTIFICATION_LICENSE,
      ClaimCategory.PROJECT_VENTURE_PATENT,
      ClaimCategory.QUANTITATIVE_METRIC,
    ],
    approvedSourceKeys: [
      'employer-confirmation',
      'university-registrar',
      'license-registry',
      'patent-registry',
      'web-archive',
    ],
    evidenceRequirements: {
      minAuthorityForVerified: 'L3_AUTHORIZED_REPRESENTATIVE',
      minAuthorityForCorroborated: 'L5_INDEPENDENT_REPORTING',
      requireTwoIndependentSourcesForAwards: false,
      applicantEvidenceAloneIsNeverVerified: true,
    },
    retentionDays: 365,
    escalationRules: {
      escalateOnConflictingInformation: true,
      escalateAfterFailedChecks: 2,
      escalateWhenDocumentAnomalyObserved: false,
    },
    reportLanguage: {
      header:
        'Employment application verification summary. Prepared for a trained reviewer. Not a hiring decision and ' +
        'not a recommendation. Where this informs an employment decision, background-screening law may apply.',
      footer: COMMON_FOOTER,
    },
  },
  {
    key: 'scholarship-fellowship',
    name: 'Scholarship and fellowship review',
    useCase: UseCase.SCHOLARSHIP_FELLOWSHIP,
    description: 'Verification of eligibility-relevant academic, research, and service claims for funded awards.',
    relevantClaimCategories: [
      ClaimCategory.EDUCATION_ENROLLMENT,
      ClaimCategory.DEGREE_AWARD,
      ClaimCategory.AWARD_COMPETITION,
      ClaimCategory.RESEARCH_POSITION,
      ClaimCategory.PUBLICATION,
      ClaimCategory.VOLUNTEER_LEADERSHIP,
    ],
    approvedSourceKeys: ['university-registrar', 'award-database', 'crossref', 'pubmed', 'orcid', 'web-archive'],
    evidenceRequirements: {
      minAuthorityForVerified: 'L2_OFFICIAL_WEBSITE',
      minAuthorityForCorroborated: 'L5_INDEPENDENT_REPORTING',
      requireTwoIndependentSourcesForAwards: true,
      applicantEvidenceAloneIsNeverVerified: true,
    },
    retentionDays: 1095,
    escalationRules: {
      escalateOnConflictingInformation: true,
      escalateAfterFailedChecks: 1,
      escalateWhenDocumentAnomalyObserved: true,
    },
    reportLanguage: {
      header: 'Scholarship verification summary. Prepared for a selection committee. Not an award decision.',
      footer: COMMON_FOOTER,
    },
  },
  {
    key: 'professional-licensing',
    name: 'Professional licensing review',
    useCase: UseCase.PROFESSIONAL_LICENSING,
    description: 'Verification of qualifications, licences, and certifications for a licensing body.',
    relevantClaimCategories: [
      ClaimCategory.CERTIFICATION_LICENSE,
      ClaimCategory.DEGREE_AWARD,
      ClaimCategory.EDUCATION_ENROLLMENT,
      ClaimCategory.EMPLOYMENT,
    ],
    approvedSourceKeys: ['license-registry', 'university-registrar', 'employer-confirmation'],
    evidenceRequirements: {
      // Licensing decisions warrant the issuing authority itself, nothing less.
      minAuthorityForVerified: 'L1_ISSUING_AUTHORITY',
      minAuthorityForCorroborated: 'L3_AUTHORIZED_REPRESENTATIVE',
      requireTwoIndependentSourcesForAwards: false,
      applicantEvidenceAloneIsNeverVerified: true,
    },
    retentionDays: 2555,
    escalationRules: {
      escalateOnConflictingInformation: true,
      escalateAfterFailedChecks: 1,
      escalateWhenDocumentAnomalyObserved: true,
    },
    reportLanguage: {
      header:
        'Licensing verification summary. Prepared for an authorised licensing reviewer. Not a licensing ' +
        'determination.',
      footer: COMMON_FOOTER,
    },
  },
  {
    key: 'grant',
    name: 'Grant application review',
    useCase: UseCase.GRANT,
    description: 'Verification of institutional affiliation, research record, and prior funding claims.',
    relevantClaimCategories: [
      ClaimCategory.RESEARCH_POSITION,
      ClaimCategory.PUBLICATION,
      ClaimCategory.EMPLOYMENT,
      ClaimCategory.QUANTITATIVE_METRIC,
      ClaimCategory.PROJECT_VENTURE_PATENT,
    ],
    approvedSourceKeys: ['crossref', 'pubmed', 'orcid', 'university-registrar', 'patent-registry', 'web-archive'],
    evidenceRequirements: {
      minAuthorityForVerified: 'L3_AUTHORIZED_REPRESENTATIVE',
      minAuthorityForCorroborated: 'L5_INDEPENDENT_REPORTING',
      requireTwoIndependentSourcesForAwards: false,
      applicantEvidenceAloneIsNeverVerified: true,
    },
    retentionDays: 2555,
    escalationRules: {
      escalateOnConflictingInformation: true,
      escalateAfterFailedChecks: 2,
      escalateWhenDocumentAnomalyObserved: false,
    },
    reportLanguage: {
      header: 'Grant application verification summary. Prepared for a review panel. Not a funding decision.',
      footer: COMMON_FOOTER,
    },
  },
  {
    key: 'vendor-founder-diligence',
    name: 'Vendor and founder due diligence',
    useCase: UseCase.VENDOR_FOUNDER_DILIGENCE,
    description: 'Verification of company, founder, and track-record claims made during commercial diligence.',
    relevantClaimCategories: [
      ClaimCategory.EMPLOYMENT,
      ClaimCategory.PROJECT_VENTURE_PATENT,
      ClaimCategory.QUANTITATIVE_METRIC,
      ClaimCategory.DEGREE_AWARD,
      ClaimCategory.AWARD_COMPETITION,
    ],
    approvedSourceKeys: ['employer-confirmation', 'patent-registry', 'university-registrar', 'web-archive', 'award-database'],
    evidenceRequirements: {
      minAuthorityForVerified: 'L3_AUTHORIZED_REPRESENTATIVE',
      minAuthorityForCorroborated: 'L5_INDEPENDENT_REPORTING',
      requireTwoIndependentSourcesForAwards: false,
      applicantEvidenceAloneIsNeverVerified: true,
    },
    retentionDays: 1825,
    escalationRules: {
      escalateOnConflictingInformation: true,
      escalateAfterFailedChecks: 2,
      escalateWhenDocumentAnomalyObserved: true,
    },
    reportLanguage: {
      header: 'Diligence verification summary. Prepared for an authorised reviewer. Not a contracting or ' +
        'investment recommendation.',
      footer: COMMON_FOOTER,
    },
  },
];
