import { revalidatePath } from 'next/cache';
import { DiscrepancyStatus } from '@prisma/client';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { loadCase, loadDiscrepancy } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { draftClarification } from '@/modules/clarification';
import { DiscrepancyStatusPill, EmptyState, SeverityPill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function resolve(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('discrepancy:resolve');
  const discrepancyId = String(formData.get('discrepancyId') ?? '');
  const discrepancy = await loadDiscrepancy(actor, discrepancyId);

  const note = String(formData.get('resolutionNote') ?? '').trim();
  const status = String(formData.get('status') ?? '') as DiscrepancyStatus;
  if (note.length < 10) return;

  await prisma.discrepancy.update({
    where: { id: discrepancyId },
    data: { status, resolutionNote: note, resolvedByUserId: actor.userId, resolvedAt: new Date() },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    caseId: discrepancy.caseId,
    actorType: 'USER',
    actorUserId: actor.userId,
    action: 'DISCREPANCY_RESOLVED',
    entityType: 'Discrepancy',
    entityId: discrepancyId,
    metadata: { from: discrepancy.status, to: status },
  });

  revalidatePath(`/cases/${discrepancy.caseId}/discrepancies`);
}

async function askApplicant(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('clarification:draft');
  const discrepancyId = String(formData.get('discrepancyId') ?? '');
  const discrepancy = await loadDiscrepancy(actor, discrepancyId);

  await draftClarification({
    caseId: discrepancy.caseId,
    organizationId: actor.organizationId,
    claimId: discrepancy.claimIds[0],
    discrepancyId,
    userId: actor.userId,
  });

  revalidatePath(`/cases/${discrepancy.caseId}/outreach`);
}

export default async function DiscrepanciesPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  await loadCase(actor, id);

  const discrepancies = await prisma.discrepancy.findMany({
    where: { caseId: id, organizationId: actor.organizationId },
    orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
    include: { resolvedBy: { select: { name: true } } },
  });

  const open = discrepancies.filter((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW');

  return (
    <>
      <div className="notice">
        <strong>These are observations, not findings</strong>
        Each entry records that two sources say different things, or that a file has an unusual property. None of them
        establishes that anything was misrepresented, and each lists the ordinary explanations that produce it. The
        purpose is to tell you where to look.
      </div>

      <p className="small muted">
        {open.length} unresolved of {discrepancies.length} total.
      </p>

      {discrepancies.length === 0 ? <EmptyState>No observations recorded for this case.</EmptyState> : null}

      {discrepancies.map((d) => (
        <section className="card" key={d.id}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1rem', flex: '1 1 300px', margin: 0 }}>{d.title}</h2>
            <SeverityPill severity={d.severity} />
            <DiscrepancyStatusPill status={d.status} />
          </div>

          <p className="small" style={{ marginTop: '0.6rem' }}>
            {d.description}
          </p>

          <p className="small muted">
            Rule <span className="mono">{d.ruleKey}</span> · {d.claimIds.length} claim(s) ·{' '}
            {d.documentIds.length} document(s)
          </p>

          {d.claimIds.length > 0 ? (
            <p className="small">
              {d.claimIds.map((cid) => (
                <a key={cid} href={`/cases/${id}/claims#${cid}`} style={{ marginRight: '0.6rem' }}>
                  view claim
                </a>
              ))}
            </p>
          ) : null}

          {d.resolutionNote ? (
            <div className="notice small">
              <strong>
                Resolved by {d.resolvedBy?.name ?? 'system'} {d.resolvedAt ? `on ${formatDateTime(d.resolvedAt)}` : ''}
              </strong>
              {d.resolutionNote}
            </div>
          ) : null}

          {(d.status === 'OPEN' || d.status === 'UNDER_REVIEW') && actor.permissions.includes('discrepancy:resolve') ? (
            <div className="inline-actions no-print">
              <details style={{ flex: '1 1 100%' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Record how this was resolved</summary>
                <form action={resolve} style={{ marginTop: '0.6rem' }}>
                  <input type="hidden" name="discrepancyId" value={d.id} />
                  <div className="field">
                    <label htmlFor={`s-${d.id}`}>Outcome</label>
                    <select id={`s-${d.id}`} name="status" required>
                      <option value={DiscrepancyStatus.EXPLAINED}>Explained — an ordinary explanation accounts for it</option>
                      <option value={DiscrepancyStatus.RESOLVED}>Resolved — settled by evidence</option>
                      <option value={DiscrepancyStatus.DISMISSED_NOT_AN_ISSUE}>Not an issue — should not have been raised</option>
                      <option value={DiscrepancyStatus.UNDER_REVIEW}>Under review — still working on it</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`n-${d.id}`}>Note (required)</label>
                    <textarea id={`n-${d.id}`} name="resolutionNote" required minLength={10} />
                  </div>
                  <button type="submit">Save</button>
                </form>
              </details>

              {actor.permissions.includes('clarification:draft') ? (
                <form action={askApplicant}>
                  <input type="hidden" name="discrepancyId" value={d.id} />
                  <button type="submit" className="btn-secondary btn-small">
                    Ask the applicant about this
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </section>
      ))}
    </>
  );
}
