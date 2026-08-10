import { beforeAll, describe, expect, it } from 'vitest';
import { createCase, createTenant, prisma, resetDatabase, uploadText, type TestTenant } from '../helpers/db';
import { drainQueue } from '@/queue/worker';
import { generateInterview, recordInterviewOutcome } from '@/modules/interviews';
import { buildCaseReport } from '@/modules/caseReviewer';
import { ValidationError } from '@/lib/errors';

/**
 * Structured conversations about claimed personal contributions.
 *
 * The behaviour that matters here is what the module refuses to do: it computes
 * no aggregate score, and it will not mark an interview reviewed without a
 * written conclusion from a person.
 */

const CV = `RESEARCH
Robotics Research Intern, Aurora Robotics Lab (Jun 2023 - Sep 2023)
- Rebuilt the grasp planner used by a team of 6 engineers
`;

let tenant: TestTenant;
let caseId: string;
let claimId: string;

beforeAll(async () => {
  await resetDatabase();
  tenant = await createTenant('interviews');
  caseId = (await createCase(tenant, { reference: 'INT-1' })).caseId;
  await uploadText(tenant, caseId, 'cv.txt', CV);
  await drainQueue({ caseId, maxTasks: 50 });

  const claim = await prisma.extractedClaim.findFirstOrThrow({ where: { caseId, category: 'RESEARCH_POSITION' } });
  claimId = claim.id;
});

describe('generating questions', () => {
  it('covers all ten areas with open-ended questions', async () => {
    const interviewId = await generateInterview({
      caseId,
      organizationId: tenant.organizationId,
      claimId,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    const interview = await prisma.interview.findUniqueOrThrow({ where: { id: interviewId } });
    const questions = interview.questions as unknown as Array<{
      id: string;
      area: string;
      question: string;
      whatACorroboratingAnswerShows: string;
    }>;

    expect(questions).toHaveLength(10);

    const areas = questions.map((q) => q.area);
    for (const required of [
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
    ]) {
      expect(areas).toContain(required);
    }

    // Every question states what a corroborating answer would demonstrate —
    // that is what keeps this a conversation rather than a quiz.
    for (const q of questions) {
      expect(q.question.length).toBeGreaterThan(20);
      expect(q.whatACorroboratingAnswerShows.length).toBeGreaterThan(10);
    }
  });

  it('starts unreviewed with every question marked not asked', async () => {
    const interviewId = await generateInterview({
      caseId,
      organizationId: tenant.organizationId,
      claimId,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    const interview = await prisma.interview.findUniqueOrThrow({ where: { id: interviewId } });
    expect(interview.humanReviewed).toBe(false);
    expect(interview.conclusion).toBeNull();

    const scorecard = interview.scorecard as unknown as Array<{ rating: string }>;
    expect(scorecard.every((s) => s.rating === 'NOT_ASKED')).toBe(true);
  });

  it('phrases questions readably, without the claim table’s formatting', async () => {
    // A reviewer reads these aloud. Interpolating the stored claim verbatim
    // produces "What problem was Publication: "X." (DOI 10.x/y) trying to solve?".
    const publicationClaim = await prisma.extractedClaim.findFirst({ where: { caseId, category: 'PUBLICATION' } });
    if (!publicationClaim) return;

    const interviewId = await generateInterview({
      caseId,
      organizationId: tenant.organizationId,
      claimId: publicationClaim.id,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    const interview = await prisma.interview.findUniqueOrThrow({ where: { id: interviewId } });
    const questions = interview.questions as unknown as Array<{ question: string }>;
    const text = questions.map((q) => q.question).join(' ');

    expect(text).not.toMatch(/Publication:/);
    expect(text).not.toMatch(/\(DOI/i);
    expect(interview.topic).not.toMatch(/^Publication:/);
  });

  it('asks nothing about the person, only about the work', async () => {
    const interview = await prisma.interview.findFirstOrThrow({ where: { caseId } });
    const questions = interview.questions as unknown as Array<{ question: string }>;
    const text = questions
      .map((q) => q.question)
      .join(' ')
      .toLowerCase();

    // No character, credibility, or demeanour questions.
    for (const forbidden of ['honest', 'truthful', 'credible', 'trust', 'confident', 'nervous', 'lying']) {
      expect(text, `question set must not ask about "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('recording an outcome', () => {
  it('requires a written conclusion from a human', async () => {
    const interviewId = await generateInterview({
      caseId,
      organizationId: tenant.organizationId,
      claimId,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    await expect(
      recordInterviewOutcome({
        interviewId,
        organizationId: tenant.organizationId,
        userId: tenant.users.LEAD_REVIEWER.id,
        scorecard: [{ questionId: 'q1', rating: 'CORROBORATES', notes: '' }],
        conclusion: 'too short',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const interview = await prisma.interview.findUniqueOrThrow({ where: { id: interviewId } });
    expect(interview.humanReviewed).toBe(false);
  });

  it('stores the scorecard and marks it human-reviewed', async () => {
    const interviewId = await generateInterview({
      caseId,
      organizationId: tenant.organizationId,
      claimId,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    await recordInterviewOutcome({
      interviewId,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
      scorecard: [
        { questionId: 'q1', rating: 'CORROBORATES', notes: 'Described the occlusion problem in detail.' },
        { questionId: 'q2', rating: 'PARTIALLY_CORROBORATES', notes: 'Vague on the division of work.' },
        { questionId: 'q3', rating: 'DOES_NOT_ADDRESS', notes: 'Ran out of time.' },
      ],
      conclusion:
        'The applicant discussed the planner architecture and its failure modes in specific terms consistent with ' +
        'their written description. The division of work with the wider team remains open.',
    });

    const interview = await prisma.interview.findUniqueOrThrow({ where: { id: interviewId } });
    expect(interview.humanReviewed).toBe(true);
    expect(interview.conductedByUserId).toBe(tenant.users.LEAD_REVIEWER.id);
    expect(interview.conductedAt).not.toBeNull();

    const scorecard = interview.scorecard as unknown as Array<{ rating: string; notes: string }>;
    expect(scorecard).toHaveLength(3);
    expect(scorecard[0]!.rating).toBe('CORROBORATES');
  });

  it('never produces an aggregate score anywhere on the record', async () => {
    const interview = await prisma.interview.findFirstOrThrow({ where: { caseId, humanReviewed: true } });
    const serialized = JSON.stringify(interview);
    // No field that could be read as a verdict on the person.
    expect(serialized).not.toMatch(/"(score|rating|credibility|confidence|percentage|grade)":\s*[0-9]/i);
  });

  it('writes an audit event naming the reviewer', async () => {
    const event = await prisma.auditEvent.findFirst({
      where: { caseId, action: 'INTERVIEW_OUTCOME_RECORDED' },
      orderBy: { sequence: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.actorUserId).toBe(tenant.users.LEAD_REVIEWER.id);
  });

  it('does not change the claim status by itself', async () => {
    // A conversation is evidence a reviewer weighs; it is not a status change.
    const claim = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.status).not.toBe('VERIFIED');
    expect(claim.status).not.toBe('CORROBORATED');
  });
});

describe('interviews in the report', () => {
  it('reports counts and the written conclusion, never a score', async () => {
    const report = await buildCaseReport(caseId, tenant.organizationId);

    expect(report.interviews.length).toBeGreaterThan(0);
    const reviewed = report.interviews.find((i) => i.humanReviewed);
    expect(reviewed).toBeDefined();
    expect(reviewed!.conclusion).toContain('planner architecture');
    expect(reviewed!.corroborates).toBe(1);
    expect(reviewed!.partiallyCorroborates).toBe(1);
    expect(reviewed!.doesNotAddress).toBe(1);

    // The report exposes counts, and no derived score field exists.
    expect(Object.keys(reviewed!)).not.toContain('score');
    expect(Object.keys(reviewed!)).not.toContain('credibility');
  });
});
