import { revalidatePath } from 'next/cache';
import { ConsentScope, DocumentKind } from '@prisma/client';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { buildCaseWorkspace } from '@/modules/caseReviewer';
import { ingestDocument, enqueueVerificationForCase } from '@/modules/orchestrator';
import { drainQueue, unblockConsentTasks } from '@/queue/worker';
import { recordAudit } from '@/lib/audit/audit';
import { getEnv } from '@/lib/env';
import { DecisionSupportNotice, EmptyState, Pill, Stat, StatusPill, formatDateTime } from '@/components/ui';
import { STATUS_MEANINGS } from '@/domain/claimStatus';

export const dynamic = 'force-dynamic';

async function uploadDocuments(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('document:upload');
  const caseId = String(formData.get('caseId') ?? '');
  await loadCase(actor, caseId);

  const kind = String(formData.get('kind') ?? 'SUPPORTING_EVIDENCE') as DocumentKind;
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  for (const file of files) {
    await ingestDocument({
      caseId,
      organizationId: actor.organizationId,
      filename: file.name.slice(0, 250),
      declaredMimeType: file.type || 'text/plain',
      bytes: Buffer.from(await file.arrayBuffer()),
      kind,
      uploadedByUserId: actor.userId,
    });
  }

  // Extract claims from what was just uploaded.
  await drainQueue({ caseId, maxTasks: 100 });
  revalidatePath(`/cases/${caseId}`);
}

async function runVerification(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('sourcecheck:run');
  const caseId = String(formData.get('caseId') ?? '');
  await loadCase(actor, caseId);

  await enqueueVerificationForCase({ caseId, organizationId: actor.organizationId, actorUserId: actor.userId });
  await drainQueue({ caseId, maxTasks: 500 });
  revalidatePath(`/cases/${caseId}`);
}

async function recordConsent(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('case:update');
  const caseId = String(formData.get('caseId') ?? '');
  await loadCase(actor, caseId);

  const scope = String(formData.get('scope') ?? '') as ConsentScope;
  const grantedVia = String(formData.get('grantedVia') ?? '').trim();
  if (!grantedVia) return;

  await prisma.consentRecord.create({
    data: { caseId, scope, grantedAt: new Date(), grantedVia, recordedByUserId: actor.userId },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    caseId,
    actorType: 'USER',
    actorUserId: actor.userId,
    action: 'CONSENT_RECORDED',
    entityType: 'ConsentRecord',
    metadata: { scope, grantedVia },
  });

  // Work that was parked awaiting this consent can now proceed.
  await unblockConsentTasks(caseId);
  revalidatePath(`/cases/${caseId}`);
}

const CONSENT_LABELS: Record<ConsentScope, string> = {
  INTERNAL_REVIEW_ONLY: 'Internal review of submitted materials',
  EXTERNAL_PUBLIC_SOURCES: 'Checking official and public sources',
  ISSUING_ORGANIZATION_OUTREACH: 'Contacting issuing organisations',
  REFERENCE_OUTREACH: 'Contacting named references',
};

export default async function CaseOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const record = await loadCase(actor, id);
  const workspace = await buildCaseWorkspace(id, actor.organizationId);

  const [documents, consents, pendingTasks] = await Promise.all([
    prisma.applicationDocument.findMany({
      where: { caseId: id, organizationId: actor.organizationId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { claims: true } } },
    }),
    prisma.consentRecord.findMany({ where: { caseId: id }, orderBy: { grantedAt: 'asc' } }),
    prisma.verificationTask.count({ where: { caseId: id, status: { in: ['PENDING', 'BLOCKED_AWAITING_CONSENT'] } } }),
  ]);

  const hasExternalConsent = consents.some((c) => c.scope === 'EXTERNAL_PUBLIC_SOURCES' && !c.revokedAt);
  const missingScopes = Object.values(ConsentScope).filter((s) => !consents.some((c) => c.scope === s && !c.revokedAt));
  const maxMb = Math.round(getEnv().MAX_UPLOAD_BYTES / 1_048_576);

  return (
    <>
      <DecisionSupportNotice />

      <div className="grid" style={{ marginBottom: '1rem' }}>
        <Stat value={`${workspace.progress.percentReviewed}%`} label="Claims with an outcome recorded" />
        <Stat value={workspace.progress.totalClaims} label="Claims extracted" />
        <Stat value={workspace.openDiscrepancies} label="Unresolved observations" />
        <Stat value={pendingTasks} label="Queued verification tasks" />
      </div>

      {!hasExternalConsent ? (
        <div className="notice notice-warn" role="alert">
          <strong>External verification is blocked</strong>
          No unrevoked consent record for checking official and public sources exists on this case. Source checks will
          be parked rather than run. Record the consent below once you hold documented authorisation.
        </div>
      ) : null}

      <section className="card">
        <h2>Documented applicant consent</h2>
        <p className="small muted">
          Consent is a gate in code, not a policy note: the verifier refuses to contact any external source without it.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Recorded</th>
                <th scope="col">Evidenced by</th>
              </tr>
            </thead>
            <tbody>
              {consents.map((c) => (
                <tr key={c.id}>
                  <td>{CONSENT_LABELS[c.scope]}</td>
                  <td className="small">{formatDateTime(c.grantedAt)}</td>
                  <td className="small">{c.grantedVia}</td>
                </tr>
              ))}
              {consents.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <EmptyState>No consent has been recorded for this case.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {missingScopes.length > 0 && actor.permissions.includes('case:update') ? (
          <form action={recordConsent} style={{ marginTop: '0.85rem' }}>
            <input type="hidden" name="caseId" value={id} />
            <div className="row">
              <div>
                <label htmlFor="scope">Consent scope</label>
                <select id="scope" name="scope" required>
                  {missingScopes.map((s) => (
                    <option key={s} value={s}>
                      {CONSENT_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="grantedVia">How the consent is evidenced</label>
                <input
                  id="grantedVia"
                  name="grantedVia"
                  type="text"
                  required
                  placeholder="Signed authorisation form dated 2026-03-04"
                />
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <button type="submit">Record consent</button>
              </div>
            </div>
          </form>
        ) : null}
      </section>

      <section className="card">
        <h2>Documents</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Type</th>
                <th scope="col">Pages</th>
                <th scope="col">Claims</th>
                <th scope="col">Processing</th>
                <th scope="col">Scan</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={`/cases/${id}/documents/${d.id}`}>{d.filename}</a>
                  </td>
                  <td className="small">{d.kind.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>{d.pageCount}</td>
                  <td>{d._count.claims}</td>
                  <td>
                    <Pill tone={d.status === 'PARSED' ? 'ok' : d.status === 'QUARANTINED' ? 'conflict' : 'warn'}>
                      {d.status.replace(/_/g, ' ').toLowerCase()}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={d.scanStatus === 'CLEAN' ? 'ok' : d.scanStatus === 'INFECTED' ? 'conflict' : 'neutral'}>
                      {d.scanStatus === 'UNSUPPORTED' ? 'not scanned' : d.scanStatus.toLowerCase()}
                    </Pill>
                  </td>
                </tr>
              ))}
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState>No documents uploaded yet.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {actor.permissions.includes('document:upload') ? (
          <form action={uploadDocuments} encType="multipart/form-data" style={{ marginTop: '0.85rem' }}>
            <input type="hidden" name="caseId" value={id} />
            <div className="row">
              <div>
                <label htmlFor="files">Add documents</label>
                <input id="files" name="files" type="file" multiple accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg" />
                <span className="hint">
                  PDF, plain text, or image, up to {maxMb} MiB each. Files are scanned, encrypted at rest, and
                  government identifiers are masked from the extracted text before it is stored.
                </span>
              </div>
              <div>
                <label htmlFor="kind">Document type</label>
                <select id="kind" name="kind">
                  {Object.values(DocumentKind).map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/_/g, ' ').toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: '0 0 auto' }}>
                <button type="submit">Upload and extract claims</button>
              </div>
            </div>
          </form>
        ) : null}
      </section>

      {actor.permissions.includes('sourcecheck:run') ? (
        <section className="card">
          <h2>Run verification</h2>
          <p className="small muted">
            Builds a plan for every verifiable claim from the source hierarchy, consults the sources this policy
            approves, and records what each one said. Nothing here decides anything: results that would support a
            conclusion are routed to you for a decision.
          </p>
          <form action={runVerification}>
            <input type="hidden" name="caseId" value={id} />
            <button type="submit" disabled={!hasExternalConsent}>
              {hasExternalConsent ? 'Run source checks' : 'Blocked — consent not recorded'}
            </button>
          </form>
        </section>
      ) : null}

      <section className="card">
        <h2>Claims by status</h2>
        <div className="grid">
          {Object.entries(workspace.progress.byStatus)
            .filter(([, count]) => count > 0)
            .map(([status, count]) => (
              <div key={status} className="stat">
                <div className="stat-value">{count}</div>
                <StatusPill status={status as keyof typeof STATUS_MEANINGS} />
                <p className="small muted" style={{ marginTop: '0.4rem', marginBottom: 0 }}>
                  {STATUS_MEANINGS[status as keyof typeof STATUS_MEANINGS]}
                </p>
              </div>
            ))}
        </div>
        {workspace.progress.totalClaims === 0 ? <EmptyState>No claims extracted yet.</EmptyState> : null}
      </section>

      <section className="card">
        <h2>Recommended next steps</h2>
        <p className="small muted">
          Suggested verification actions only. This list never recommends an outcome for the applicant.
        </p>
        {workspace.unresolvedQuestions.length === 0 ? (
          <EmptyState>Nothing outstanding.</EmptyState>
        ) : (
          <ul>
            {workspace.unresolvedQuestions.map((q, i) => (
              <li key={i} className="small">
                {q}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="small muted">
        Case reference {record.reference} · priority score {workspace.priority.score} (
        {workspace.priority.contributions.map((c) => c.factor).join(', ') || 'no outstanding factors'})
      </p>
    </>
  );
}
