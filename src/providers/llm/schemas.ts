import { z } from 'zod';

/**
 * Zod contracts for every structured model output.
 *
 * These schemas are a security boundary, not just a parsing convenience. Note
 * what they do NOT contain: there is no `status` field, no `verified` boolean,
 * no `fraudLikelihood`, no `recommendation`, no `decision`, and no field
 * describing a person's protected characteristics. A model — whether confused,
 * adversarial, or steered by injected text inside an uploaded document — cannot
 * emit those values, because a response containing them fails validation and is
 * rejected before anything is written.
 */

export const CLAIM_CATEGORIES = [
  'EDUCATION_ENROLLMENT',
  'DEGREE_AWARD',
  'EMPLOYMENT',
  'AWARD_COMPETITION',
  'RESEARCH_POSITION',
  'PUBLICATION',
  'ATHLETIC_PARTICIPATION',
  'CERTIFICATION_LICENSE',
  'VOLUNTEER_LEADERSHIP',
  'PROJECT_VENTURE_PATENT',
  'QUANTITATIVE_METRIC',
  'OTHER',
] as const;

/** A single extracted claim. Every field is descriptive; none is evaluative. */
export const ExtractedClaimSchema = z.object({
  /** Verbatim text from the document, used to cite back to the page. */
  sourcePassage: z.string().min(1).max(2000),
  /** One-sentence restatement in a consistent form. */
  normalizedText: z.string().min(1).max(500),
  category: z.enum(CLAIM_CATEGORIES),
  personName: z.string().max(200).nullable(),
  organizationName: z.string().max(300).nullable(),
  title: z.string().max(300).nullable(),
  location: z.string().max(200).nullable(),
  /** ISO-8601 date or partial date (YYYY, YYYY-MM, YYYY-MM-DD). */
  startDate: z.string().max(40).nullable(),
  endDate: z.string().max(40).nullable(),
  datePrecision: z.enum(['DAY', 'MONTH', 'YEAR', 'RANGE_APPROXIMATE', 'UNKNOWN']),
  amountValue: z.number().finite().nullable(),
  amountUnit: z.string().max(60).nullable(),
  /** Whether an outside record could in principle confirm this. */
  isObjectivelyVerifiable: z.boolean(),
  /** Whether the claim implies a full-time commitment during its date range. */
  impliesFullTimeCommitment: z.boolean(),
  /**
   * Confidence that the text was READ AND STRUCTURED correctly.
   * Explicitly not a judgement about the applicant's honesty, and never used
   * as evidence for or against a claim.
   */
  extractionConfidence: z.number().min(0).max(1),
});

export type ExtractedClaimPayload = z.infer<typeof ExtractedClaimSchema>;

export const ClaimExtractionResponseSchema = z.object({
  claims: z.array(ExtractedClaimSchema).max(200),
  /**
   * Observable oddities in the text, e.g. an instruction addressed to an
   * automated reader. Recorded for a human; never acted on by the system.
   */
  documentObservations: z
    .array(
      z.object({
        observation: z.string().max(500),
        whyItMayMatter: z.string().max(500),
      }),
    )
    .max(50)
    .default([]),
});

export type ClaimExtractionResponse = z.infer<typeof ClaimExtractionResponseSchema>;

export const CLAIM_EXTRACTION_HINT = `{
  "claims": [{
    "sourcePassage": string,          // verbatim from the document
    "normalizedText": string,
    "category": one of ${CLAIM_CATEGORIES.join(' | ')},
    "personName": string | null,
    "organizationName": string | null,
    "title": string | null,
    "location": string | null,
    "startDate": string | null,       // YYYY | YYYY-MM | YYYY-MM-DD
    "endDate": string | null,
    "datePrecision": "DAY" | "MONTH" | "YEAR" | "RANGE_APPROXIMATE" | "UNKNOWN",
    "amountValue": number | null,
    "amountUnit": string | null,
    "isObjectivelyVerifiable": boolean,
    "impliesFullTimeCommitment": boolean,
    "extractionConfidence": number    // 0..1, about READING accuracy only
  }],
  "documentObservations": [{ "observation": string, "whyItMayMatter": string }]
}`;

// ---------------------------------------------------------------- interviews

export const InterviewQuestionSchema = z.object({
  area: z.enum([
    'ORIGINAL_PROBLEM',
    'SPECIFIC_CONTRIBUTION',
    'METHODS_AND_TOOLS',
    'DECISIONS_AND_TRADEOFFS',
    'UNEXPECTED_FAILURES',
    'DATA_SOURCES',
    'RESULTS_AND_LIMITATIONS',
    'COLLABORATION_AND_DIVISION',
    'WHAT_WOULD_CHANGE',
    'TECHNICAL_WALKTHROUGH',
  ]),
  question: z.string().min(10).max(600),
  /** What a corroborating answer would demonstrate. Not a "correct answer". */
  whatACorroboratingAnswerShows: z.string().min(10).max(600),
});

export const InterviewQuestionsResponseSchema = z.object({
  topic: z.string().min(1).max(300),
  questions: z.array(InterviewQuestionSchema).min(1).max(20),
});

export type InterviewQuestionsResponse = z.infer<typeof InterviewQuestionsResponseSchema>;

export const INTERVIEW_QUESTIONS_HINT = `{
  "topic": string,
  "questions": [{
    "area": "ORIGINAL_PROBLEM" | "SPECIFIC_CONTRIBUTION" | "METHODS_AND_TOOLS" | "DECISIONS_AND_TRADEOFFS" |
            "UNEXPECTED_FAILURES" | "DATA_SOURCES" | "RESULTS_AND_LIMITATIONS" | "COLLABORATION_AND_DIVISION" |
            "WHAT_WOULD_CHANGE" | "TECHNICAL_WALKTHROUGH",
    "question": string,
    "whatACorroboratingAnswerShows": string
  }]
}`;

// ---------------------------------------------------------------- clarification

export const ClarificationDraftResponseSchema = z.object({
  subject: z.string().min(5).max(200),
  /** Neutral body. Reviewed and editable by a human before it is ever sent. */
  body: z.string().min(40).max(4000),
  acceptableEvidence: z.array(z.string().min(3).max(300)).min(1).max(12),
});

export type ClarificationDraftResponse = z.infer<typeof ClarificationDraftResponseSchema>;

export const CLARIFICATION_DRAFT_HINT = `{
  "subject": string,
  "body": string,                       // neutral, respectful, no accusation
  "acceptableEvidence": [string]        // concrete things the applicant could provide
}`;

// ---------------------------------------------------------------- evidence summary

export const EvidenceSummaryResponseSchema = z.object({
  /** Neutral prose describing what the evidence shows. No conclusion. */
  summary: z.string().min(20).max(2000),
  openQuestions: z.array(z.string().min(5).max(400)).max(20).default([]),
});

export type EvidenceSummaryResponse = z.infer<typeof EvidenceSummaryResponseSchema>;

export const EVIDENCE_SUMMARY_HINT = `{
  "summary": string,          // describe what sources show; do NOT conclude
  "openQuestions": [string]
}`;

/**
 * Words a model must not use to characterise a person in generated prose. If a
 * draft contains one, it is rejected and regenerated rather than shown to a
 * reviewer, because reviewer-facing language shapes reviewer judgement.
 */
export const PROHIBITED_CHARACTERIZATIONS = [
  'liar',
  'lied',
  'lying',
  'fraud',
  'fraudulent',
  'fraudster',
  'fabricated',
  'falsified',
  'forged',
  'dishonest',
  'deceptive',
  'scam',
  'cheat',
] as const;

export function findProhibitedCharacterizations(text: string): string[] {
  const lower = text.toLowerCase();
  return PROHIBITED_CHARACTERIZATIONS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
}
