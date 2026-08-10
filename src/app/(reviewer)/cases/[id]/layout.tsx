import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { recordAudit } from '@/lib/audit/audit';
import { NotFoundError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/claims', label: 'Claims & evidence' },
  { href: '/discrepancies', label: 'Observations' },
  { href: '/timeline', label: 'Timeline & links' },
  { href: '/outreach', label: 'Outreach & clarifications' },
  { href: '/report', label: 'Report' },
  { href: '/audit', label: 'Audit history' },
];

export default async function CaseLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;

  let record;
  try {
    record = await loadCase(actor, id);
  } catch (e) {
    // A case in another tenant is indistinguishable from one that does not exist.
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  // Every view of a case file is logged. Who looked at whose application, and
  // when, is exactly the kind of question an audit needs to answer.
  await recordAudit({
    organizationId: actor.organizationId,
    caseId: record.id,
    actorType: 'USER',
    actorUserId: actor.userId,
    action: 'CASE_VIEWED',
    entityType: 'Case',
    entityId: record.id,
  });

  return (
    <>
      <div className="page-head">
        <div className="small muted">
          <a href="/">Case queue</a> / {record.reference}
        </div>
        <h1>{record.title}</h1>
        <p>
          Applicant: <strong>{record.applicant.displayName}</strong> · Policy: {record.policyTemplate.name} · Reviewer:{' '}
          {record.assignedReviewer?.name ?? 'Unassigned'}
        </p>
      </div>

      <nav aria-label="Case sections" className="card no-print" style={{ padding: '0.4rem' }}>
        <div className="inline-actions">
          {TABS.map((tab) => (
            <a key={tab.href} className="btn btn-secondary btn-small" href={`/cases/${record.id}${tab.href}`}>
              {tab.label}
            </a>
          ))}
        </div>
      </nav>

      {children}
    </>
  );
}
