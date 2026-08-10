import { revalidatePath } from 'next/cache';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { loadCase, loadInterview } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { generateInterview, recordInterviewOutcome, type CorroborationRating } from '@/modules/interviews';
import { EmptyState, Pill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Interview workspace.
 *
 * Some claims cannot be verified by any record — "I designed the control loop"
 * is not in a registry. The instrument for those is a structured conversation
 * about the work.
 *
 * Two things this screen deliberately does NOT do:
 *
 *  - It computes no aggregate score. Reducing a conversation about someone's
 *    work to a number invites treating it as a verdict, which is exactly what a
 *    conversation is worse at than a record.
 *  - It rates whether an answer CORROBORATES the described contribution, never
 *    whether the person seemed credible. Nervousness, a language barrier, and
 *    the passage of time are not signals about honesty.
 */

interface StoredQuestion {
  id: string;
  area: string;
  question: string;
  whatACorroboratingAnswerShows: string;
}

interface StoredScore {
  questionId: string;
  rating: CorroborationRating;
  notes: string;
}

const RATING_LABELS: Record<CorroborationRating, string> = {
  CORROBORATES: 'Corroborates the description',
  PARTIALLY_CORROBORATES: 'Partially corroborates',
  DOES_NOT_ADDRESS: 'Did not address the question',
  NOT_ASKED: 'Not asked',
};

const AREA_LABELS: Record<string, string> = {
  ORIGINAL_PROBLEM: 'The original problem',
  SPECIFIC_CONTRIBUTION: 'Their specific contribution',
  METHODS_AND_TOOLS: 'Methods and tools',
  DECISIONS_AND_TRADEOFFS: 'Decisions and tradeoffs',
  UNEXPECTED_FAILURES: 'Unexpected failures',
  DATA_SOURCES: 'Data sources',
  RESULTS_AND_LIMITATIONS: 'Results and limitations',
  COLLABORATION_AND_DIVISION: 'Collaboration and division of work',
  WHAT_WOULD_CHANGE: 'What they would change',
  TECHNICAL_WALKTHROUGH: 'Technical walkthrough',
};

async function createInterview(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('interview:manage');
  const caseId = String(formData.get('caseId') ?? '');
  await loadCase(actor, caseId);

  const claimId = String(formData.get('claimId') ?? '') || undefined;

  await generateInterview({
    caseId,
    organizationId: actor.organizationId,
    claimId,
    userId: actor.userId,
  });

  revalidatePath(`/cases/${caseId}/interviews`);
}

async function saveOutcome(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('interview:manage');
  const interviewId = String(formData.get('interviewId') ?? '');
  const interview = await loadInterview(actor, interviewId);

  const questions = (interview.questions ?? []) as unknown as StoredQuestion[];

  const scorecard = questions.map((q) => ({
    questionId: q.id,
    rating: (String(formData.get(`rating-${q.id}`) ?? 'NOT_ASKED') as CorroborationRating) ?? 'NOT_ASKED',
    notes: String(formData.get(`notes-${q.id}`) ?? ''),
  }));

  await recordInterviewOutcome({
    interviewId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    scorecard,
    conclusion: String(formData.get('conclusion') ?? ''),
  });

  revalidatePath(`/cases/${interview.caseId}/interviews`);
}

export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  await loadCase(actor, id);

  const [interviews, claims] = await Promise.all([
    prisma.interview.findMany({
      where: { caseId: id, organizationId: actor.organizationId },
      include: {
        claim: { select: { id: true, normalizedText: true, category: true } },
        conductedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    // Claims describing a personal contribution — the ones records cannot settle.
    prisma.extractedClaim.findMany({
      where: {
        caseId: id,
        organizationId: actor.organizationId,
        category: { in: ['RESEARCH_POSITION', 'PROJECT_VENTURE_PATENT', 'PUBLICATION', 'EMPLOYMENT'] },
      },
      select: { id: true, normalizedText: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const canManage = actor.permissions.includes('interview:manage');

  return (
    <>
      <div className="notice">
        <strong>What a structured conversation is for</strong>
        Records can confirm that a project existed. They cannot confirm who did which part of it. These questions are
        designed so that someone who did the work can discuss it — the problem behind it, the decisions, what went wrong
        — without depending on recall of any specific fact. Rate whether an answer{' '}
        <em>corroborates the described contribution</em>. Do not rate how confident, fluent, or nervous someone seemed:
        those are not signals about honesty, and treating them as such penalises people for anxiety or for speaking a
        second language.
      </div>

      {canManage ? (
        <section className="card no-print">
          <h2>Prepare a conversation</h2>
          <p className="small muted">
            Generates open-ended questions across ten areas, each paired with what a corroborating answer would
            demonstrate.
          </p>
          <form action={createInterview}>
            <input type="hidden" name="caseId" value={id} />
            <div className="row">
              <div>
                <label htmlFor="claimId">About which claim</label>
                <select id="claimId" name="claimId">
                  <option value="">(case-level)</option>
                  {claims.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.normalizedText.slice(0, 80)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <button type="submit">Generate questions</button>
              </div>
            </div>
          </form>
        </section>
      ) : null}

      {interviews.length === 0 ? <EmptyState>No conversations prepared for this case.</EmptyState> : null}

      {interviews.map((interview) => {
        const questions = (interview.questions ?? []) as unknown as StoredQuestion[];
        const scores = (interview.scorecard ?? []) as unknown as StoredScore[];
        const scoreFor = (questionId: string): StoredScore | undefined =>
          scores.find((s) => s.questionId === questionId);

        const tally = {
          CORROBORATES: scores.filter((s) => s.rating === 'CORROBORATES').length,
          PARTIALLY_CORROBORATES: scores.filter((s) => s.rating === 'PARTIALLY_CORROBORATES').length,
          DOES_NOT_ADDRESS: scores.filter((s) => s.rating === 'DOES_NOT_ADDRESS').length,
          NOT_ASKED: scores.filter((s) => s.rating === 'NOT_ASKED').length,
        };

        return (
          <section className="card" key={interview.id} id={interview.id}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1rem', flex: '1 1 320px', margin: 0 }}>{interview.topic}</h2>
              {interview.humanReviewed ? (
                <Pill tone="ok">Reviewed</Pill>
              ) : (
                <Pill tone="neutral">Not yet conducted</Pill>
              )}
            </div>

            {interview.claim ? (
              <p className="small muted">
                Regarding: <a href={`/cases/${id}/claims#${interview.claim.id}`}>{interview.claim.normalizedText}</a>
              </p>
            ) : (
              <p className="small muted">Case-level conversation.</p>
            )}

            {interview.humanReviewed ? (
              <div className="notice small">
                <strong>
                  Conducted by {interview.conductedBy?.name ?? 'a reviewer'}
                  {interview.conductedAt ? ` on ${formatDateTime(interview.conductedAt)}` : ''}
                </strong>
                {interview.conclusion}
                <p className="muted" style={{ marginTop: '0.4rem', marginBottom: 0 }}>
                  {tally.CORROBORATES} corroborating · {tally.PARTIALLY_CORROBORATES} partial · {tally.DOES_NOT_ADDRESS}{' '}
                  not addressed · {tally.NOT_ASKED} not asked. These are counts, not a score — weigh them alongside the
                  rest of the evidence rather than as a result in themselves.
                </p>
              </div>
            ) : null}

            <form action={saveOutcome}>
              <input type="hidden" name="interviewId" value={interview.id} />

              <div className="table-wrap">
                <table>
                  <caption>
                    {questions.length} questions. Each is open-ended by design — there is no correct answer to check
                    against.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Area</th>
                      <th scope="col">Question</th>
                      <th scope="col">What a corroborating answer shows</th>
                      <th scope="col">Assessment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questions.map((q) => {
                      const existing = scoreFor(q.id);
                      return (
                        <tr key={q.id}>
                          <td className="small muted">{AREA_LABELS[q.area] ?? q.area}</td>
                          <td className="small">{q.question}</td>
                          <td className="small muted">{q.whatACorroboratingAnswerShows}</td>
                          <td>
                            {canManage ? (
                              <>
                                <label htmlFor={`rating-${q.id}`} className="small">
                                  Does the answer corroborate?
                                </label>
                                <select
                                  id={`rating-${q.id}`}
                                  name={`rating-${q.id}`}
                                  defaultValue={existing?.rating ?? 'NOT_ASKED'}
                                >
                                  {(Object.keys(RATING_LABELS) as CorroborationRating[]).map((r) => (
                                    <option key={r} value={r}>
                                      {RATING_LABELS[r]}
                                    </option>
                                  ))}
                                </select>
                                <label htmlFor={`notes-${q.id}`} className="small" style={{ marginTop: '0.35rem' }}>
                                  Notes
                                </label>
                                <textarea
                                  id={`notes-${q.id}`}
                                  name={`notes-${q.id}`}
                                  defaultValue={existing?.notes ?? ''}
                                  style={{ minHeight: '3.5rem' }}
                                />
                              </>
                            ) : (
                              <div className="small">
                                {existing ? RATING_LABELS[existing.rating] : 'Not asked'}
                                {existing?.notes ? <div className="muted">{existing.notes}</div> : null}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {canManage ? (
                <div className="field" style={{ marginTop: '0.85rem' }}>
                  <label htmlFor={`conclusion-${interview.id}`}>Your conclusion (required)</label>
                  <textarea
                    id={`conclusion-${interview.id}`}
                    name="conclusion"
                    required
                    minLength={20}
                    defaultValue={interview.conclusion ?? ''}
                    placeholder="What did the conversation establish about the applicant's described contribution, and what remains open?"
                  />
                  <span className="hint">
                    The system computes no score from the ratings above. A conversation is evidence a person weighs, not
                    a result. Recording a conclusion marks this as human-reviewed.
                  </span>
                </div>
              ) : null}

              {canManage ? <button type="submit">Save conclusion</button> : null}
            </form>
          </section>
        );
      })}
    </>
  );
}
