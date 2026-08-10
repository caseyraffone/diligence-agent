import { requireActor } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { buildCaseReport, type ReportEvidenceLine } from '@/modules/caseReviewer';
import { recordAudit } from '@/lib/audit/audit';
import { EmptyState, Pill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

function EvidenceSection({
  title,
  explanation,
  lines,
}: {
  title: string;
  explanation: string;
  lines: ReportEvidenceLine[];
}) {
  return (
    <section className="card">
      <h2>
        {title} <span className="muted small">({lines.length})</span>
      </h2>
      <p className="small muted">{explanation}</p>
      {lines.length === 0 ? (
        <EmptyState>Nothing in this category.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">What the source says</th>
                <th scope="col">Authority</th>
                <th scope="col">Retrieved</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="small">{l.claim}</td>
                  <td className="small">
                    <div>{l.summary}</div>
                    {l.detail ? <div className="muted">{l.detail}</div> : null}
                    {l.source ? <div className="mono muted">{l.source}</div> : null}
                  </td>
                  <td className="small">{l.authority}</td>
                  <td className="small">{l.retrievedAt ? formatDateTime(l.retrievedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  await loadCase(actor, id);

  const report = await buildCaseReport(id, actor.organizationId);

  await recordAudit({
    organizationId: actor.organizationId,
    caseId: id,
    actorType: 'USER',
    actorUserId: actor.userId,
    action: 'REPORT_VIEWED',
    entityType: 'Case',
    entityId: id,
  });

  return (
    <>
      <div className="notice">
        <strong>About this report</strong>
        {report.notice}
      </div>

      <div className="inline-actions no-print" style={{ marginBottom: '1rem' }}>
        <a className="btn btn-secondary btn-small" href={`/api/cases/${id}/report.json`}>
          Download JSON
        </a>
        <a className="btn btn-secondary btn-small" href={`/api/cases/${id}/report.pdf`}>
          Download PDF
        </a>
      </div>

      <section className="card">
        <h2>Summary</h2>
        <p className="small">
          Case {report.case.reference} — {report.case.title}. Applicant: {report.case.applicantName}. Policy:{' '}
          {report.case.policy}. Reviewer: {report.case.assignedReviewer ?? 'unassigned'}. Generated{' '}
          {formatDateTime(report.generatedAt)}.
        </p>
        <div className="grid">
          <div className="stat">
            <div className="stat-value">{report.summary.totalClaims}</div>
            <div className="stat-label">Claims</div>
          </div>
          <div className="stat">
            <div className="stat-value">{report.summary.percentReviewed}%</div>
            <div className="stat-label">With an outcome recorded</div>
          </div>
          <div className="stat">
            <div className="stat-value">{report.summary.openDiscrepancies}</div>
            <div className="stat-label">Unresolved observations</div>
          </div>
          <div className="stat">
            <div className="stat-value">
              {report.auditIntegrity.valid ? (
                <Pill tone="ok">intact</Pill>
              ) : (
                <Pill tone="conflict">broken</Pill>
              )}
            </div>
            <div className="stat-label">Audit chain ({report.auditIntegrity.eventsChecked} events)</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Claims and recorded outcomes</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Citation</th>
                <th scope="col">Dates</th>
                <th scope="col">Status</th>
                <th scope="col">Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {report.claims.map((c, i) => (
                <tr key={i}>
                  <td className="small">{c.claim}</td>
                  <td className="small muted">{c.citation}</td>
                  <td className="small">{c.dates}</td>
                  <td className="small">
                    <strong>{c.status.replace(/_/g, ' ').toLowerCase()}</strong>
                    <div className="muted">{c.statusMeaning}</div>
                  </td>
                  <td className="small">
                    {c.humanDecision ? (
                      <>
                        <div>{c.humanDecision.by}</div>
                        <div className="muted">{formatDateTime(c.humanDecision.at)}</div>
                        <div className="muted">{c.humanDecision.rationale}</div>
                      </>
                    ) : (
                      <span className="muted">No human decision recorded yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* The five categories are presented separately and never merged. */}
      <EvidenceSection
        title="Confirmed facts"
        explanation="Statements confirmed by an issuing authority, an official record, or an authorised representative."
        lines={report.confirmedFacts}
      />
      <EvidenceSection
        title="Applicant statements"
        explanation="What the applicant told us, including responses to clarification requests. Recorded as their account, not as established fact."
        lines={report.applicantStatements}
      />
      <EvidenceSection
        title="Third-party statements"
        explanation="What referees, employers, and other outside parties said. Their accounts, attributed to them."
        lines={report.thirdPartyStatements}
      />
      <EvidenceSection
        title="System observations"
        explanation="Things the software noticed, including searches that returned no record. An observation is not a finding, and a search returning nothing is not evidence about the claim."
        lines={report.systemObservations}
      />
      <EvidenceSection
        title="Inferences"
        explanation="Reasoning drawn from the material above rather than stated by any source. Weigh accordingly."
        lines={report.inferences}
      />

      <section className="card">
        <h2>Unresolved differences ({report.unresolvedDiscrepancies.length})</h2>
        <p className="small muted">
          Differences between sources that remain open. The report records what differs, not why — the cause has not
          been established.
        </p>
        {report.unresolvedDiscrepancies.length === 0 ? (
          <EmptyState>None outstanding.</EmptyState>
        ) : (
          report.unresolvedDiscrepancies.map((d, i) => (
            <div key={i} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem', marginTop: '0.6rem' }}>
              <strong className="small">{d.title}</strong>
              <p className="small">{d.description}</p>
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>Applicant clarification history</h2>
        {report.clarifications.length === 0 ? (
          <EmptyState>No clarification requests were sent.</EmptyState>
        ) : (
          <ul className="small">
            {report.clarifications.map((c, i) => (
              <li key={i}>
                {c.subject} — {c.status.toLowerCase()}, {c.responses} response(s)
                {c.sentAt ? `, sent ${formatDateTime(c.sentAt)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Timeline</h2>
        <ul className="small">
          {report.timeline.map((t, i) => (
            <li key={i}>
              {t.dates} — {t.label}
              {t.organization ? `, ${t.organization}` : ''} ({t.status.replace(/_/g, ' ').toLowerCase()})
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
