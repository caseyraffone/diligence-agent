import { requireActor } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { buildTimeline, buildRelationshipGraph } from '@/modules/caseReviewer';
import { EmptyState, StatusPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function TimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  await loadCase(actor, id);

  const [timeline, graph] = await Promise.all([
    buildTimeline(id, actor.organizationId),
    buildRelationshipGraph(id, actor.organizationId),
  ]);

  const byType = {
    CLAIM: graph.nodes.filter((n) => n.type === 'CLAIM'),
    DOCUMENT: graph.nodes.filter((n) => n.type === 'DOCUMENT'),
    ORGANIZATION: graph.nodes.filter((n) => n.type === 'ORGANIZATION'),
    SOURCE: graph.nodes.filter((n) => n.type === 'SOURCE'),
  };

  return (
    <>
      <section className="card">
        <h2>Timeline</h2>
        <p className="small muted">
          Education, employment, research, and activities as stated in the documents, ordered by start date. Overlaps
          are shown as they were declared — many overlaps are entirely ordinary.
        </p>
        {timeline.length === 0 ? (
          <EmptyState>No dated claims to place on a timeline.</EmptyState>
        ) : (
          <ul className="timeline">
            {timeline.map((entry) => (
              <li key={entry.claimId}>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <strong>{entry.label}</strong>
                  <StatusPill status={entry.status} />
                </div>
                <div className="small muted">
                  {entry.organizationName ?? 'Organisation not stated'} · {entry.dateLabel} ·{' '}
                  {entry.category.replace(/_/g, ' ').toLowerCase()}
                </div>
                <a className="small" href={`/cases/${id}/claims#${entry.claimId}`}>
                  view claim
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Relationship map</h2>
        <p className="small muted">
          How claims connect to the documents they came from, the organisations they name, and the sources consulted.
          Rendered as a list so it is readable with a screen reader and on a tablet.
        </p>

        <div className="grid">
          {(['CLAIM', 'DOCUMENT', 'ORGANIZATION', 'SOURCE'] as const).map((type) => (
            <div key={type}>
              <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {type.toLowerCase()}s ({byType[type].length})
              </h3>
              <ul className="small">
                {byType[type].slice(0, 40).map((n) => (
                  <li key={n.id}>{n.label}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <h3>Connections</h3>
        <div className="table-wrap">
          <table>
            <caption>{graph.edges.length} connections</caption>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">Relationship</th>
                <th scope="col">To</th>
              </tr>
            </thead>
            <tbody>
              {graph.edges.slice(0, 200).map((e, i) => {
                const from = graph.nodes.find((n) => n.id === e.from);
                const to = graph.nodes.find((n) => n.id === e.to);
                return (
                  <tr key={i}>
                    <td className="small">{from?.label ?? e.from}</td>
                    <td className="small muted">{e.label}</td>
                    <td className="small">{to?.label ?? e.to}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
