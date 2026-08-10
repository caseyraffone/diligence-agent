import { revalidatePath } from 'next/cache';
import { TipStatus } from '@prisma/client';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { prisma } from '@/lib/prisma';
import { triageTip } from '@/modules/tips';
import { EmptyState, Pill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function triage(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('tip:triage');
  await triageTip({
    tipId: String(formData.get('tipId') ?? ''),
    organizationId: actor.organizationId,
    userId: actor.userId,
    status: String(formData.get('status') ?? '') as Parameters<typeof triageTip>[0]['status'],
    reviewNote: String(formData.get('reviewNote') ?? ''),
  });
  revalidatePath('/tips');
}

export default async function TipsPage() {
  const actor = await requireActor();

  // Enforced by permission, not by hiding the link: a reviewer without
  // `tip:read` gets a 404-equivalent rather than an empty page.
  if (!actor.permissions.includes('tip:read')) {
    const { notFound } = await import('next/navigation');
    notFound();
  }

  const tips = await prisma.anonymousTip.findMany({
    where: { organizationId: actor.organizationId },
    include: { case: { select: { id: true, reference: true } } },
    orderBy: { submittedAt: 'desc' },
    take: 100,
  });

  return (
    <>
      <div className="page-head">
        <h1>Anonymous submissions</h1>
        <p>
          Confidential allegations received through the public form. Access is restricted to reviewers holding the tip
          permission.
        </p>
      </div>

      <div className="notice notice-warn">
        <strong>Every submission here is an unverified allegation</strong>
        A submission cannot change any claim’s status, and there is no mechanism in this system for it to do so. To
        matter, an allegation must lead you to independent evidence — and it is that evidence, not the allegation,
        that supports any finding. Repeat submissions of the same text are suppressed so volume cannot masquerade as
        corroboration. Submissions are never shown to the applicant, and the identity of a submitter is not collected.
      </div>

      {tips.length === 0 ? <EmptyState>No submissions received.</EmptyState> : null}

      {tips.map((tip) => (
        <section className="card" key={tip.id}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="small muted" style={{ flex: '1 1 200px' }}>
              Received {formatDateTime(tip.submittedAt)}
              {tip.case ? (
                <>
                  {' '}
                  · linked to <a href={`/cases/${tip.case.id}`}>{tip.case.reference}</a>
                </>
              ) : (
                ' · not linked to a case'
              )}
            </span>
            <Pill
              tone={
                tip.status === 'INDEPENDENTLY_CORROBORATED'
                  ? 'ok'
                  : tip.status === 'CLOSED_UNSUBSTANTIATED' || tip.status === 'CLOSED_OUT_OF_SCOPE'
                    ? 'neutral'
                    : 'warn'
              }
            >
              {tip.status.replace(/_/g, ' ').toLowerCase()}
            </Pill>
          </div>

          <blockquote className="quote">{tip.allegationText}</blockquote>
          {tip.claimedEvidence ? (
            <p className="small">
              <strong>Evidence offered:</strong> {tip.claimedEvidence}
            </p>
          ) : null}

          {tip.reviewNote ? (
            <div className="notice small">
              <strong>Reviewer note</strong>
              {tip.reviewNote}
            </div>
          ) : null}

          {actor.permissions.includes('tip:triage') ? (
            <details className="no-print">
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Record a triage decision</summary>
              <form action={triage} style={{ marginTop: '0.6rem' }}>
                <input type="hidden" name="tipId" value={tip.id} />
                <div className="field">
                  <label htmlFor={`s-${tip.id}`}>Outcome</label>
                  <select id={`s-${tip.id}`} name="status" required>
                    <option value={TipStatus.UNDER_REVIEW}>Under review</option>
                    <option value={TipStatus.CORROBORATION_REQUIRED}>Needs independent corroboration</option>
                    <option value={TipStatus.INDEPENDENTLY_CORROBORATED}>Independently corroborated by other evidence</option>
                    <option value={TipStatus.CLOSED_UNSUBSTANTIATED}>Closed — no supporting evidence found</option>
                    <option value={TipStatus.CLOSED_OUT_OF_SCOPE}>Closed — out of scope</option>
                  </select>
                  <span className="hint">
                    “Independently corroborated” is refused unless the case already holds confirmed or third-party
                    evidence. The allegation itself can never be its own corroboration.
                  </span>
                </div>
                <div className="field">
                  <label htmlFor={`n-${tip.id}`}>Note (required)</label>
                  <textarea id={`n-${tip.id}`} name="reviewNote" required minLength={10} />
                </div>
                <button type="submit">Save</button>
              </form>
            </details>
          ) : null}
        </section>
      ))}
    </>
  );
}
