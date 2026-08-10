import { revalidatePath } from 'next/cache';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { loadCase, loadClarification, loadOutreach } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { approveOutreach, declineOutreach, draftOutreach, recordOutreachResponse, recordOutreachSent } from '@/modules/outreach';
import { approveAndSendClarification, closeClarification, editClarification } from '@/modules/clarification';
import { EmptyState, Pill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Outreach and clarification approval queues.
 *
 * Nothing on this page transmits anything. A reviewer approves a draft, sends
 * it through their own channel, and records that they did. For clarification
 * requests, approving mints the applicant's single-use link, which is displayed
 * once for the reviewer to pass on.
 */

async function newOutreach(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('outreach:draft');
  const caseId = String(formData.get('caseId') ?? '');
  await loadCase(actor, caseId);

  await draftOutreach({
    caseId,
    organizationId: actor.organizationId,
    recipientOrgName: String(formData.get('recipientOrgName') ?? '').trim(),
    recipientEmail: String(formData.get('recipientEmail') ?? '').trim() || undefined,
    claimId: String(formData.get('claimId') ?? '') || undefined,
    userId: actor.userId,
  });
  revalidatePath(`/cases/${caseId}/outreach`);
}

async function approve(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('outreach:approve');
  const outreachId = String(formData.get('outreachId') ?? '');
  const request = await loadOutreach(actor, outreachId);

  await approveOutreach({
    outreachId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    editedBody: String(formData.get('body') ?? '') || undefined,
  });
  revalidatePath(`/cases/${request.caseId}/outreach`);
}

async function decline(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('outreach:approve');
  const outreachId = String(formData.get('outreachId') ?? '');
  const request = await loadOutreach(actor, outreachId);
  await declineOutreach({
    outreachId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    reason: String(formData.get('reason') ?? 'Declined by reviewer'),
  });
  revalidatePath(`/cases/${request.caseId}/outreach`);
}

async function markSent(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('outreach:approve');
  const outreachId = String(formData.get('outreachId') ?? '');
  const request = await loadOutreach(actor, outreachId);
  await recordOutreachSent({ outreachId, organizationId: actor.organizationId, userId: actor.userId });
  revalidatePath(`/cases/${request.caseId}/outreach`);
}

async function logReply(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('outreach:record_response');
  const outreachId = String(formData.get('outreachId') ?? '');
  const request = await loadOutreach(actor, outreachId);

  await recordOutreachResponse({
    outreachId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    respondentName: String(formData.get('respondentName') ?? '').trim(),
    respondentRole: String(formData.get('respondentRole') ?? '').trim() || undefined,
    content: String(formData.get('content') ?? ''),
  });
  revalidatePath(`/cases/${request.caseId}/outreach`);
}

async function approveClarification(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('clarification:approve');
  const clarificationId = String(formData.get('clarificationId') ?? '');
  const request = await loadClarification(actor, clarificationId);

  await editClarification({
    clarificationId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    subject: String(formData.get('subject') ?? request.subject),
    body: String(formData.get('body') ?? request.body),
    acceptableEvidence: request.acceptableEvidence,
  });

  const result = await approveAndSendClarification({
    clarificationId,
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  // The link is shown once, via the redirect target, and is not stored in clear.
  revalidatePath(`/cases/${request.caseId}/outreach`);
  const { redirect } = await import('next/navigation');
  redirect(`/cases/${request.caseId}/outreach?link=${encodeURIComponent(result.portalUrl)}`);
}

async function close(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('clarification:approve');
  const clarificationId = String(formData.get('clarificationId') ?? '');
  const request = await loadClarification(actor, clarificationId);
  await closeClarification({ clarificationId, organizationId: actor.organizationId, userId: actor.userId });
  revalidatePath(`/cases/${request.caseId}/outreach`);
}

export default async function OutreachPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ link?: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  const { link } = await searchParams;
  await loadCase(actor, id);

  const [outreach, clarifications, claims] = await Promise.all([
    prisma.outreachRequest.findMany({
      where: { caseId: id, organizationId: actor.organizationId },
      include: { responses: true, approvedBy: { select: { name: true } }, claim: { select: { normalizedText: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.clarificationRequest.findMany({
      where: { caseId: id, organizationId: actor.organizationId },
      include: { responses: { orderBy: { submittedAt: 'asc' } }, claim: { select: { normalizedText: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.extractedClaim.findMany({
      where: { caseId: id, organizationId: actor.organizationId },
      select: { id: true, normalizedText: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const canApprove = actor.permissions.includes('outreach:approve');
  const canApproveClarification = actor.permissions.includes('clarification:approve');

  return (
    <>
      <div className="notice">
        <strong>This system never sends anything</strong>
        Requests are drafted here and approved by you. You then send them through your own channel and record that you
        did. Automated contact with a third party about a named individual is deliberately not implemented.
      </div>

      {link ? (
        <div className="notice notice-warn" role="alert">
          <strong>Applicant link — shown once</strong>
          <span className="mono" style={{ wordBreak: 'break-all' }}>
            {link}
          </span>
          <br />
          Send this to the applicant yourself. Only a hash is stored, so it cannot be shown again. It opens one
          clarification request and nothing else on the case.
        </div>
      ) : null}

      {/* ---------------------------------------------- clarifications */}
      <section className="card">
        <h2>Applicant clarification requests</h2>
        {clarifications.length === 0 ? <EmptyState>None drafted for this case.</EmptyState> : null}

        {clarifications.map((c) => (
          <article key={c.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.85rem', marginTop: '0.85rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <strong style={{ flex: '1 1 260px' }}>{c.subject}</strong>
              <Pill tone={c.status === 'RESPONDED' ? 'ok' : c.status === 'SENT' ? 'info' : 'neutral'}>
                {c.status.replace(/_/g, ' ').toLowerCase()}
              </Pill>
            </div>
            {c.claim ? <p className="small muted">Regarding: {c.claim.normalizedText}</p> : null}

            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>
                Read the request
              </summary>
              <pre className="small" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                {c.body}
              </pre>
              <p className="small">
                <strong>Evidence the applicant may supply:</strong>
              </p>
              <ul className="small">
                {c.acceptableEvidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>

            {c.responses.length > 0 ? (
              <div className="notice small">
                <strong>Applicant response ({c.responses.length})</strong>
                {c.responses.map((r) => (
                  <p key={r.id} style={{ marginBottom: '0.4rem' }}>
                    <span className="muted">{formatDateTime(r.submittedAt)}: </span>
                    {r.message}
                  </p>
                ))}
              </div>
            ) : null}

            {canApproveClarification && (c.status === 'DRAFT' || c.status === 'PENDING_APPROVAL') ? (
              <details className="no-print">
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Review, edit, and approve</summary>
                <form action={approveClarification} style={{ marginTop: '0.6rem' }}>
                  <input type="hidden" name="clarificationId" value={c.id} />
                  <div className="field">
                    <label htmlFor={`cs-${c.id}`}>Subject</label>
                    <input id={`cs-${c.id}`} name="subject" type="text" defaultValue={c.subject} />
                  </div>
                  <div className="field">
                    <label htmlFor={`cb-${c.id}`}>Message to the applicant</label>
                    <textarea id={`cb-${c.id}`} name="body" defaultValue={c.body} style={{ minHeight: '14rem' }} />
                    <span className="hint">
                      Keep the wording neutral. The applicant sees exactly this text, the claim, and the acceptable
                      evidence — nothing else from the case.
                    </span>
                  </div>
                  <button type="submit">Approve and generate the applicant link</button>
                </form>
              </details>
            ) : null}

            {canApproveClarification && c.status === 'RESPONDED' ? (
              <form action={close} className="no-print">
                <input type="hidden" name="clarificationId" value={c.id} />
                <button type="submit" className="btn-secondary btn-small">
                  Close and revoke the applicant link
                </button>
              </form>
            ) : null}
          </article>
        ))}
      </section>

      {/* ---------------------------------------------- outreach */}
      <section className="card">
        <h2>Outreach to organisations</h2>
        {outreach.length === 0 ? <EmptyState>No outreach drafted for this case.</EmptyState> : null}

        {outreach.map((o) => (
          <article key={o.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.85rem', marginTop: '0.85rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <strong style={{ flex: '1 1 260px' }}>{o.recipientOrgName}</strong>
              <Pill
                tone={
                  o.status === 'RESPONSE_RECEIVED' ? 'ok' : o.status === 'DECLINED_BY_REVIEWER' ? 'neutral' : 'info'
                }
              >
                {o.status.replace(/_/g, ' ').toLowerCase()}
              </Pill>
            </div>
            {o.claim ? <p className="small muted">Regarding: {o.claim.normalizedText}</p> : null}
            <p className="small muted">
              Requires consent scope: {o.requiredConsent.replace(/_/g, ' ').toLowerCase()}
              {o.approvedBy ? ` · approved by ${o.approvedBy.name} on ${formatDateTime(o.approvedAt)}` : ''}
            </p>

            <details>
              <summary className="small" style={{ cursor: 'pointer' }}>
                Read the draft
              </summary>
              <pre className="small" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                {o.body}
              </pre>
            </details>

            {o.responses.map((r) => (
              <div className="notice small" key={r.id}>
                <strong>
                  Reply from {r.respondentName}
                  {r.respondentRole ? `, ${r.respondentRole}` : ''} — {formatDateTime(r.receivedAt)}
                </strong>
                {r.content}
                {r.isConfidential ? (
                  <p className="muted" style={{ marginTop: '0.3rem', marginBottom: 0 }}>
                    Held confidentially. Not shown to the applicant.
                  </p>
                ) : null}
              </div>
            ))}

            <div className="inline-actions no-print">
              {canApprove && o.status === 'PENDING_APPROVAL' ? (
                <>
                  <details style={{ flex: '1 1 100%' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Edit and approve</summary>
                    <form action={approve} style={{ marginTop: '0.6rem' }}>
                      <input type="hidden" name="outreachId" value={o.id} />
                      <div className="field">
                        <label htmlFor={`ob-${o.id}`}>Message</label>
                        <textarea id={`ob-${o.id}`} name="body" defaultValue={o.body} style={{ minHeight: '14rem' }} />
                      </div>
                      <button type="submit">Approve for sending</button>
                    </form>
                  </details>
                  <form action={decline}>
                    <input type="hidden" name="outreachId" value={o.id} />
                    <input type="hidden" name="reason" value="Not required for this case" />
                    <button type="submit" className="btn-secondary btn-small">
                      Decline
                    </button>
                  </form>
                </>
              ) : null}

              {canApprove && o.status === 'APPROVED_FOR_SENDING' ? (
                <form action={markSent}>
                  <input type="hidden" name="outreachId" value={o.id} />
                  <button type="submit" className="btn-secondary btn-small">
                    I have sent this — record it
                  </button>
                </form>
              ) : null}

              {actor.permissions.includes('outreach:record_response') && o.status !== 'DRAFT' ? (
                <details style={{ flex: '1 1 100%' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Record a reply</summary>
                  <form action={logReply} style={{ marginTop: '0.6rem' }}>
                    <input type="hidden" name="outreachId" value={o.id} />
                    <div className="row">
                      <div>
                        <label htmlFor={`rn-${o.id}`}>Respondent name</label>
                        <input id={`rn-${o.id}`} name="respondentName" type="text" required />
                      </div>
                      <div>
                        <label htmlFor={`rr-${o.id}`}>Their role</label>
                        <input id={`rr-${o.id}`} name="respondentRole" type="text" />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor={`rc-${o.id}`}>What they said (verbatim)</label>
                      <textarea id={`rc-${o.id}`} name="content" required />
                    </div>
                    <button type="submit">Record reply as evidence</button>
                  </form>
                </details>
              ) : null}
            </div>
          </article>
        ))}

        {actor.permissions.includes('outreach:draft') ? (
          <details className="no-print" style={{ marginTop: '1rem' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Draft new outreach</summary>
            <form action={newOutreach} style={{ marginTop: '0.6rem' }}>
              <input type="hidden" name="caseId" value={id} />
              <div className="row">
                <div>
                  <label htmlFor="recipientOrgName">Organisation</label>
                  <input id="recipientOrgName" name="recipientOrgName" type="text" required />
                </div>
                <div>
                  <label htmlFor="recipientEmail">Contact address (optional)</label>
                  <input id="recipientEmail" name="recipientEmail" type="email" />
                </div>
                <div>
                  <label htmlFor="claimId">About which claim</label>
                  <select id="claimId" name="claimId">
                    <option value="">(case-level)</option>
                    {claims.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.normalizedText.slice(0, 70)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <button type="submit">Create draft</button>
            </form>
          </details>
        ) : null}
      </section>
    </>
  );
}
