import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { ValidationError } from '@/lib/errors';
import { runStructured } from '@/providers/llm/client';
import { InterviewQuestionsResponseSchema, INTERVIEW_QUESTIONS_HINT } from '@/providers/llm/schemas';

/**
 * RESEARCH, PROJECT, AND CONTRIBUTION VERIFICATION
 *
 * Some claims cannot be verified by any record. "I designed the control loop"
 * or "I led the data pipeline work" is not in a registry anywhere. The
 * appropriate instrument is a structured conversation about the work.
 *
 * The design constraint that matters: this must not become a trivia test.
 * Questions ask about problem context, personal scope, decisions, failures, and
 * tradeoffs — things someone who did the work can discuss and someone who
 * didn't cannot, without depending on recall of a specific fact. Nervousness,
 * a language barrier, or time having passed must not read as evasion.
 *
 * Scoring records whether an answer CORROBORATES the described contribution.
 * There is no "credibility" or "honesty" score, and no automated conclusion:
 * `humanReviewed` cannot be set without a written conclusion from a reviewer.
 */

export type CorroborationRating = 'CORROBORATES' | 'PARTIALLY_CORROBORATES' | 'DOES_NOT_ADDRESS' | 'NOT_ASKED';

export interface ScorecardEntry {
  questionId: string;
  rating: CorroborationRating;
  notes: string;
}

export async function generateInterview(input: {
  caseId: string;
  organizationId: string;
  claimId?: string;
  topic?: string;
  userId: string;
}): Promise<string> {
  const claim = input.claimId
    ? await prisma.extractedClaim.findFirstOrThrow({
        where: { id: input.claimId, organizationId: input.organizationId },
      })
    : null;

  const topic = input.topic ?? claim?.normalizedText ?? 'the applicant’s described contribution';

  const generated = await runStructured({
    task: 'GENERATE_INTERVIEW_QUESTIONS',
    instruction:
      'Generate structured interview questions that help a reviewer understand the applicant’s specific personal ' +
      'contribution to the work described. Cover the original problem, their specific contribution, methods and ' +
      'tools, decisions and tradeoffs, unexpected failures, data sources, results and limitations, collaboration and ' +
      'division of work, what they would change, and a detailed walkthrough of one technical component. ' +
      'Questions must be open-ended and answerable by someone who did the work, even long afterwards. ' +
      'Do not write trivia questions, do not ask for memorised figures, and do not ask anything about the person ' +
      'rather than the work.',
    untrusted: [{ label: 'claim under discussion', content: `${topic}\n\n${claim?.sourcePassage ?? ''}` }],
    schema: InterviewQuestionsResponseSchema,
    schemaName: 'InterviewQuestionsResponse',
    schemaHint: INTERVIEW_QUESTIONS_HINT,
  });

  const questions = generated.data.questions.map((q, index) => ({
    id: `q${index + 1}`,
    area: q.area,
    question: q.question,
    whatACorroboratingAnswerShows: q.whatACorroboratingAnswerShows,
  }));

  const interview = await prisma.interview.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId,
      claimId: input.claimId ?? null,
      topic: generated.data.topic,
      questions,
      scorecard: questions.map((q) => ({ questionId: q.id, rating: 'NOT_ASKED', notes: '' })),
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'INTERVIEW_QUESTIONS_GENERATED',
    entityType: 'Interview',
    entityId: interview.id,
    metadata: { claimId: input.claimId ?? null, questionCount: questions.length },
  });

  return interview.id;
}

/**
 * Records the reviewer's scorecard and conclusion.
 *
 * A conclusion is mandatory before the interview counts as reviewed. The system
 * deliberately computes no aggregate score: turning "3 of 10 corroborated" into
 * a number invites treating it as a verdict, which is precisely what a
 * conversation about someone's work should not produce.
 */
export async function recordInterviewOutcome(input: {
  interviewId: string;
  organizationId: string;
  userId: string;
  scorecard: ScorecardEntry[];
  conclusion: string;
  conductedAt?: Date;
}): Promise<void> {
  const interview = await prisma.interview.findFirstOrThrow({
    where: { id: input.interviewId, organizationId: input.organizationId },
  });

  if (input.conclusion.trim().length < 20) {
    throw new ValidationError(
      'An interview conclusion must be written by the reviewer and be at least 20 characters. ' +
        'The scorecard alone is not a conclusion.',
    );
  }

  await prisma.interview.update({
    where: { id: interview.id },
    data: {
      scorecard: input.scorecard.map((s) => ({ questionId: s.questionId, rating: s.rating, notes: s.notes })),
      conclusion: input.conclusion,
      humanReviewed: true,
      conductedByUserId: input.userId,
      conductedAt: input.conductedAt ?? new Date(),
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: interview.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'INTERVIEW_OUTCOME_RECORDED',
    entityType: 'Interview',
    entityId: interview.id,
    metadata: {
      corroborates: input.scorecard.filter((s) => s.rating === 'CORROBORATES').length,
      partially: input.scorecard.filter((s) => s.rating === 'PARTIALLY_CORROBORATES').length,
      notAddressed: input.scorecard.filter((s) => s.rating === 'DOES_NOT_ADDRESS').length,
    },
  });
}
