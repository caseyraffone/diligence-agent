import { revalidatePath } from 'next/cache';
import { ClaimCategory, ClaimStatus } from '@prisma/client';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { loadCase, loadClaim } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { reviseClaim } from '@/modules/claimMapper';
import { recordReviewerDecision } from '@/modules/caseReviewer';
import { runSourceCheck, buildVerificationPlan } from '@/modules/evidenceVerifier';
import { draftClarification } from '@/modules/clarification';
import { allowedTransitions, STATUS_LABELS, STATUS_MEANINGS } from '@/domain/claimStatus';
import { AUTHORITY_LABELS } from '@/domain/authority';
import { DecisionSupportNotice, EmptyState, Pill, ResultPill, StatusPill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function editClaim(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('claim:edit');
  const claimId = String(formData.get('claimId') ?? '');
  const claim = await loadClaim(actor, claimId);

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 5) return;

  await reviseClaim({
    claimId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    reason,
    changes: {
      normalizedText: String(formData.get('normalizedText') ?? claim.normalizedText),
      organizationName: String(formData.get('organizationName') ?? '') || null,
      title: String(formData.get('title') ?? '') || null,
      category: String(formData.get('category') ?? claim.category) as ClaimCategory,
    },
  });

  revalidatePath(`/cases/${claim.caseId}/claims`);
}

async function decide(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('claim:decide');
  const claimId = String(formData.get('claimId') ?? '');
  const claim = await loadClaim(actor, claimId);

  await recordReviewerDecision({
    claimId,
    organizationId: actor.organizationId,
    userId: actor.userId,
    newStatus: String(formData.get('newStatus') ?? '') as ClaimStatus,
    rationale: String(formData.get('rationale') ?? ''),
  });

  revalidatePath(`/cases/${claim.caseId}/claims`);
}

async function checkSource(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('sourcecheck:run');
  const claimId = String(formData.get('claimId') ?? '');
  const claim = await loadClaim(actor, claimId);

  await runSourceCheck({
    claimId,
    organizationId: actor.organizationId,
    adapterKey: String(formData.get('adapterKey') ?? ''),
    actorUserId: actor.userId,
    actorType: 'USER',
  });

  revalidatePath(`/cases/${claim.caseId}/claims`);
}

async function askApplicant(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('clarification:draft');
  const claimId = String(formData.get('claimId') ?? '');
  const claim = await loadClaim(actor, claimId);

  await draftClarification({
    caseId: claim.caseId,
    organizationId: actor.organizationId,
    claimId,
    userId: actor.userId,
  });

  revalidatePath(`/cases/${claim.caseId}/outreach`);
}

export default async function ClaimsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; category?: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  const filters = await searchParams;
  const record = await loadCase(actor, id);

  const claims = await prisma.extractedClaim.findMany({
    where: {
      caseId: id,
      organizationId: actor.organizationId,
      ...(filters.status ? { status: filters.status as ClaimStatus } : {}),
      ...(filters.category ? { category: filters.category as ClaimCategory } : {}),
    },
    include: {
      document: { select: { id: true, filename: true } },
      evidenceItems: { include: { sourceCheck: true }, orderBy: { createdAt: 'asc' } },
      sourceChecks: { orderBy: { retrievedAt: 'desc' } },
      decisions: { include: { decidedBy: { select: { name: true } } }, orderBy: { decidedAt: 'desc' } },
      revisions: { orderBy: { createdAt: 'desc' }, take: 3, include: { user: { select: { name: true } } } },
    },
    orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
  });

  const canEdit = actor.permissions.includes('claim:edit');
  const canDecide = actor.permissions.includes('claim:decide');
  const canCheck = actor.permissions.includes('sourcecheck:run');

  return (
    <>
      <DecisionSupportNotice />

      <form className="card no-print" method="get">
        <div className="row">
          <div>
            <label htmlFor="status">Verification status</label>
            <select id="status" name="status" defaultValue={filters.status ?? ''}>
              <option value="">Any status</option>
              {Object.values(ClaimStatus).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="category">Claim type</label>
            <select id="category" name="category" defaultValue={filters.category ?? ''}>
              <option value="">Any type</option>
              {Object.values(ClaimCategory).map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button type="submit">Filter</button>
          </div>
        </div>
      </form>

      <p className="small muted">
        {claims.length} claim{claims.length === 1 ? '' : 's'}. Each cites the document and page it came from — open the
        source passage to check the system’s reading against the original.
      </p>

      {claims.length === 0 ? <EmptyState>No claims match these filters.</EmptyState> : null}

      {claims.map((claim) => {
        const plan = buildVerificationPlan(claim, record.policyTemplate.approvedSourceKeys);
        const latestDecision = claim.decisions[0];
        const supporting = claim.evidenceItems.filter((e) => e.relation === 'SUPPORTING');
        const conflicting = claim.evidenceItems.filter((e) => e.relation === 'CONFLICTING');
        const neutral = claim.evidenceItems.filter((e) => e.relation === 'NEUTRAL');

        return (
          <section className="card" key={claim.id} id={claim.id}>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 420px', minWidth: 0 }}>
                <h2 style={{ fontSize: '1rem' }}>{claim.normalizedText}</h2>
                <p className="small muted" style={{ marginBottom: '0.35rem' }}>
                  {claim.category.replace(/_/g, ' ').toLowerCase()} ·{' '}
                  <a href={`/cases/${id}/documents/${claim.document.id}#page-${claim.pageNumber}`}>
                    {claim.document.filename}, page {claim.pageNumber}
                  </a>{' '}
                  · extraction confidence {(claim.extractionConfidence * 100).toFixed(0)}%
                </p>
                <blockquote className="quote small">“{claim.sourcePassage}”</blockquote>
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <StatusPill status={claim.status} />
              </div>
            </div>

            <p className="small muted">{STATUS_MEANINGS[claim.status]}</p>

            {/* --------------------------------------------- evidence matrix */}
            <h3>Evidence</h3>
            <div className="table-wrap">
              <table>
                <caption>
                  {supporting.length} supporting · {conflicting.length} conflicting · {neutral.length} neutral
                  observation(s). A neutral row records that a source was consulted and held nothing — that is an
                  evidence gap, not a mark against the claim.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Relation</th>
                    <th scope="col">Kind of statement</th>
                    <th scope="col">Authority</th>
                    <th scope="col">What it says</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {claim.evidenceItems.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Pill
                          tone={e.relation === 'SUPPORTING' ? 'ok' : e.relation === 'CONFLICTING' ? 'conflict' : 'neutral'}
                        >
                          {e.relation.toLowerCase()}
                        </Pill>
                      </td>
                      <td className="small">{e.statementType.replace(/_/g, ' ').toLowerCase()}</td>
                      <td className="small">{AUTHORITY_LABELS[e.authorityLevel]}</td>
                      <td className="small">
                        <div>{e.summary}</div>
                        {e.detail ? <div className="muted">{e.detail}</div> : null}
                        {e.sourceCheck?.excerpt ? (
                          <blockquote className="quote small">“{e.sourceCheck.excerpt}”</blockquote>
                        ) : null}
                      </td>
                      <td className="small">
                        {e.sourceCheck ? (
                          <>
                            <div>{e.sourceCheck.adapterKey}</div>
                            <ResultPill result={e.sourceCheck.result} />
                            <div className="muted" style={{ marginTop: '0.2rem' }}>
                              retrieved {formatDateTime(e.sourceCheck.retrievedAt)}
                              {e.sourceCheck.isLive ? ' (live)' : ' (fixture)'}
                            </div>
                            {e.sourceCheck.url ? (
                              <a href={e.sourceCheck.url} rel="noreferrer noopener nofollow" target="_blank">
                                open source
                              </a>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                  {claim.evidenceItems.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <EmptyState>No source has been consulted for this claim yet.</EmptyState>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {/* --------------------------------------------- verification plan */}
            <h3>Verification plan</h3>
            {plan.manualChannelNote ? (
              <p className="small muted">{plan.manualChannelNote}</p>
            ) : (
              <ul className="small">
                {plan.steps.map((step) => (
                  <li key={step.adapterKey}>
                    <strong>{step.adapterName}</strong> — {AUTHORITY_LABELS[step.authorityLevel]}.{' '}
                    {step.integrationStatus === 'LIVE_CAPABLE' ? (
                      <Pill tone="ok">live capable</Pill>
                    ) : (
                      <Pill tone="neutral">fixture</Pill>
                    )}{' '}
                    {step.rationale}
                    {canCheck ? (
                      <form action={checkSource} style={{ display: 'inline' }}>
                        <input type="hidden" name="claimId" value={claim.id} />
                        <input type="hidden" name="adapterKey" value={step.adapterKey} />
                        <button type="submit" className="btn-secondary btn-small" style={{ marginLeft: '0.4rem' }}>
                          Run check
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {/* --------------------------------------------- decision history */}
            {latestDecision ? (
              <div className="notice small">
                <strong>
                  Outcome recorded by {latestDecision.decidedBy.name} on {formatDateTime(latestDecision.decidedAt)}
                </strong>
                {latestDecision.previousStatus ? `${STATUS_LABELS[latestDecision.previousStatus]} → ` : ''}
                {STATUS_LABELS[latestDecision.newStatus]}. {latestDecision.rationale}
              </div>
            ) : null}

            {claim.revisions.length > 0 ? (
              <details className="small">
                <summary>Edit history ({claim.revisions.length})</summary>
                <ul>
                  {claim.revisions.map((r) => (
                    <li key={r.id}>
                      {formatDateTime(r.createdAt)} — {r.user?.name ?? 'system'}: {r.reason}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  The original extraction is preserved. Edits are recorded alongside it, never in place of it.
                </p>
              </details>
            ) : null}

            {/* --------------------------------------------- actions */}
            <div className="inline-actions no-print" style={{ marginTop: '0.75rem' }}>
              {canDecide ? (
                <details style={{ flex: '1 1 100%' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Record a verification outcome</summary>
                  <form action={decide} style={{ marginTop: '0.6rem' }}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <div className="field">
                      <label htmlFor={`status-${claim.id}`}>New status</label>
                      <select id={`status-${claim.id}`} name="newStatus" required>
                        {allowedTransitions(claim.status).map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>
                      <span className="hint">
                        Verified, Corroborated, and Conflicting information can only be recorded by a person — the
                        automated pipeline is not permitted to assign them.
                      </span>
                    </div>
                    <div className="field">
                      <label htmlFor={`rationale-${claim.id}`}>Rationale (required)</label>
                      <textarea
                        id={`rationale-${claim.id}`}
                        name="rationale"
                        required
                        minLength={10}
                        placeholder="Cite the evidence you relied on and why it supports this outcome."
                      />
                    </div>
                    <button type="submit">Record outcome</button>
                  </form>
                </details>
              ) : null}

              {canEdit ? (
                <details style={{ flex: '1 1 100%' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Correct this claim</summary>
                  <form action={editClaim} style={{ marginTop: '0.6rem' }}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <div className="field">
                      <label htmlFor={`text-${claim.id}`}>Normalised claim</label>
                      <input id={`text-${claim.id}`} name="normalizedText" type="text" defaultValue={claim.normalizedText} />
                    </div>
                    <div className="row">
                      <div>
                        <label htmlFor={`org-${claim.id}`}>Organisation</label>
                        <input id={`org-${claim.id}`} name="organizationName" type="text" defaultValue={claim.organizationName ?? ''} />
                      </div>
                      <div>
                        <label htmlFor={`title-${claim.id}`}>Title</label>
                        <input id={`title-${claim.id}`} name="title" type="text" defaultValue={claim.title ?? ''} />
                      </div>
                      <div>
                        <label htmlFor={`cat-${claim.id}`}>Claim type</label>
                        <select id={`cat-${claim.id}`} name="category" defaultValue={claim.category}>
                          {Object.values(ClaimCategory).map((c) => (
                            <option key={c} value={c}>
                              {c.replace(/_/g, ' ').toLowerCase()}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor={`reason-${claim.id}`}>Reason for the correction (required)</label>
                      <input id={`reason-${claim.id}`} name="reason" type="text" required minLength={5} />
                    </div>
                    <button type="submit" className="btn-secondary">
                      Save correction
                    </button>
                  </form>
                </details>
              ) : null}

              {actor.permissions.includes('clarification:draft') ? (
                <form action={askApplicant}>
                  <input type="hidden" name="claimId" value={claim.id} />
                  <button type="submit" className="btn-secondary btn-small">
                    Draft a clarification request
                  </button>
                </form>
              ) : null}
            </div>
          </section>
        );
      })}
    </>
  );
}
