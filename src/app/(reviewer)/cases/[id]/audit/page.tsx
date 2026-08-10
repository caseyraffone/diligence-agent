import { requireActor } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { verifyAuditChain } from '@/lib/audit/audit';
import { EmptyState, Pill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  await loadCase(actor, id);

  const [events, chain] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { caseId: id, organizationId: actor.organizationId },
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { sequence: 'desc' },
      take: 500,
    }),
    verifyAuditChain(actor.organizationId),
  ]);

  return (
    <>
      <section className="card">
        <h2>Audit integrity</h2>
        <p className="small muted">
          Each event is hashed together with the hash of the event before it. Re-deriving the whole chain detects any
          row that was altered or removed after it was written. This makes tampering <em>detectable</em>; it does not
          make it impossible — an append-only store or external anchoring would be needed for that.
        </p>
        {chain.valid ? (
          <p>
            <Pill tone="ok">Chain intact</Pill> {chain.checked} events verified for this organisation.
          </p>
        ) : (
          <div className="notice notice-conflict" role="alert">
            <strong>Chain verification failed at sequence {chain.brokenAtSequence}</strong>
            {chain.reason}
          </div>
        )}
      </section>

      <section className="card">
        <h2>History for this case</h2>
        <p className="small muted">
          Every view, edit, export, outreach action, and status change. {events.length} most recent shown.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="mono small">{e.sequence}</td>
                  <td className="small">{formatDateTime(e.createdAt)}</td>
                  <td className="small">
                    {e.actor ? e.actor.name : e.actorType.toLowerCase()}
                    <div className="muted">{e.actorType.toLowerCase()}</div>
                  </td>
                  <td className="small">{e.action.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="small muted">{e.entityType}</td>
                  <td className="small mono" style={{ maxWidth: '28ch', overflowWrap: 'anywhere' }}>
                    {JSON.stringify(e.metadata)}
                  </td>
                </tr>
              ))}
              {events.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState>No audit events for this case.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
