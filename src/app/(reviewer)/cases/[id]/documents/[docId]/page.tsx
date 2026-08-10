import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/context';
import { loadCase, loadDocument } from '@/lib/auth/tenant';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { NotFoundError } from '@/lib/errors';
import { EmptyState, Pill, StatusPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Parsed-document preview.
 *
 * Renders the EXTRACTED, REDACTED text as escaped React text — never the
 * original bytes, and never as HTML. A malicious upload therefore has no path
 * to executing anything in the reviewer's session. The original is available
 * only through a download route that forces an attachment disposition.
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const actor = await requireActor();
  const { id, docId } = await params;
  await loadCase(actor, id);

  let document;
  try {
    document = await loadDocument(actor, docId);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  if (document.caseId !== id) notFound();

  const [pages, claims] = await Promise.all([
    prisma.documentPage.findMany({ where: { documentId: docId }, orderBy: { pageNumber: 'asc' } }),
    prisma.extractedClaim.findMany({ where: { documentId: docId }, orderBy: { pageNumber: 'asc' } }),
  ]);

  await recordAudit({
    organizationId: actor.organizationId,
    caseId: id,
    actorType: 'USER',
    actorUserId: actor.userId,
    action: 'DOCUMENT_VIEWED',
    entityType: 'ApplicationDocument',
    entityId: docId,
  });

  const signals = Array.isArray(document.integritySignals) ? document.integritySignals : [];

  return (
    <>
      <section className="card">
        <h2>{document.filename}</h2>
        <p className="small muted">
          {document.kind.replace(/_/g, ' ').toLowerCase()} · {document.pageCount} page(s) ·{' '}
          {(document.sizeBytes / 1024).toFixed(1)} KiB · SHA-256{' '}
          <span className="mono">{document.sha256.slice(0, 24)}…</span>
        </p>
        <div className="inline-actions">
          <Pill tone={document.status === 'PARSED' ? 'ok' : 'warn'}>{document.status.toLowerCase()}</Pill>
          <Pill tone={document.scanStatus === 'CLEAN' ? 'ok' : 'neutral'}>
            {document.scanStatus === 'UNSUPPORTED' ? 'not scanned' : document.scanStatus.toLowerCase()}
          </Pill>
          {actor.permissions.includes('document:download_original') ? (
            <a className="btn btn-secondary btn-small" href={`/api/documents/${docId}/original`}>
              Download original
            </a>
          ) : null}
        </div>
        {document.scanDetail ? <p className="small muted">{document.scanDetail}</p> : null}
      </section>

      {signals.length > 0 ? (
        <section className="card">
          <h2>File observations</h2>
          <p className="small muted">
            Properties of the file and of the extraction. None of these establishes anything about the document’s
            contents or its author.
          </p>
          <ul className="small">
            {signals.map((s, i) => {
              const record = s as Record<string, unknown>;
              if (record['kind'] === 'FILE_METADATA') {
                return (
                  <li key={i}>
                    <strong>File metadata:</strong> <span className="mono">{JSON.stringify(record['values'])}</span>
                  </li>
                );
              }
              return (
                <li key={i}>
                  <strong>{String(record['observation'] ?? '')}</strong>
                  <div className="muted">{String(record['whyItMayMatter'] ?? '')}</div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <h2>Extracted text</h2>
        <p className="small muted">
          This is the redacted text the system read, not the original file. Government identifiers are masked before
          storage. Compare it against the original if a claim looks misread.
        </p>
        {pages.length === 0 ? <EmptyState>No text was extracted from this document.</EmptyState> : null}
        {pages.map((page) => (
          <div key={page.id} id={`page-${page.pageNumber}`} style={{ marginTop: '1rem' }}>
            <h3>Page {page.pageNumber}</h3>
            <pre
              className="small"
              style={{
                whiteSpace: 'pre-wrap',
                background: 'var(--surface-alt)',
                padding: '0.75rem',
                borderRadius: 'var(--radius-sm)',
                overflowX: 'auto',
                fontFamily: 'var(--mono)',
              }}
            >
              {page.text}
            </pre>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Claims extracted from this document ({claims.length})</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Claim</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id}>
                  <td>{c.pageNumber}</td>
                  <td className="small">
                    <a href={`/cases/${id}/claims#${c.id}`}>{c.normalizedText}</a>
                  </td>
                  <td className="small muted">{c.category.replace(/_/g, ' ').toLowerCase()}</td>
                  <td>
                    <StatusPill status={c.status} />
                  </td>
                </tr>
              ))}
              {claims.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState>No claims were extracted from this document.</EmptyState>
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
