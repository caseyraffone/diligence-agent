import { notFound, redirect } from 'next/navigation';
import { ClarificationStatus, DocumentKind } from '@prisma/client';
import { resolvePortalToken } from '@/lib/auth/portalToken';
import { submitClarificationResponse } from '@/modules/clarification';
import { ingestDocument } from '@/modules/orchestrator';
import { enforceRateLimit } from '@/lib/ratelimit';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * APPLICANT CLARIFICATION PORTAL
 *
 * Reached only with a single-purpose, expiring token. It renders exactly three
 * things: the claim in question, the question being asked, and what evidence
 * would help — plus the applicant's own previous responses.
 *
 * It deliberately does NOT expose the case, other claims, reviewer notes,
 * source-check results, referee replies, or anonymous submissions. The token
 * resolves to one ClarificationRequest and the queries here never widen beyond
 * it.
 */
async function respond(formData: FormData): Promise<void> {
  'use server';

  const token = String(formData.get('token') ?? '');
  const context = await resolvePortalToken(token);
  if (!context) redirect(`/portal/${token}?state=expired`);

  try {
    // Bound how much an automated client can push through one link.
    await enforceRateLimit({
      scope: 'portal',
      identifier: context.clarificationId,
      limit: 20,
      windowSeconds: 3600,
    });

    const documentIds: string[] = [];
    const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

    for (const file of files) {
      const result = await ingestDocument({
        caseId: context.caseId,
        organizationId: context.organizationId,
        filename: file.name.slice(0, 250),
        declaredMimeType: file.type || 'text/plain',
        bytes: Buffer.from(await file.arrayBuffer()),
        kind: DocumentKind.APPLICANT_CLARIFICATION_UPLOAD,
        uploadedByUserId: null,
        uploadedVia: 'APPLICANT',
      });
      documentIds.push(result.documentId);
    }

    await submitClarificationResponse({
      clarificationId: context.clarificationId,
      organizationId: context.organizationId,
      caseId: context.caseId,
      message: String(formData.get('message') ?? ''),
      documentIds,
    });
  } catch (e) {
    if (e instanceof AppError) redirect(`/portal/${token}?state=invalid`);
    throw e;
  }

  redirect(`/portal/${token}?state=received`);
}

export default async function PortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { token } = await params;
  const { state } = await searchParams;

  const context = await resolvePortalToken(token);
  if (!context) notFound();

  const organization = await prisma.organization.findUnique({
    where: { id: context.organizationId },
    select: { name: true },
  });

  const closed = context.status === ClarificationStatus.CLOSED;

  return (
    <main className="portal">
      <div className="portal-head">
        <h1>A question about your application</h1>
        <p className="muted">
          From {organization?.name ?? 'the reviewing organisation'}
          {context.dueDate ? ` · response requested by ${formatDate(context.dueDate)}` : ''}
        </p>
      </div>

      {state === 'received' ? (
        <div className="notice" role="status">
          <strong>Thank you — your response has been recorded</strong>A reviewer will consider it alongside the other
          information on file. Your original application is unchanged; your explanation has been added to the record,
          not substituted for anything.
        </div>
      ) : null}
      {state === 'invalid' ? (
        <div className="notice notice-warn" role="alert">
          Your response could not be accepted. Please include a short explanation and try again.
        </div>
      ) : null}
      {state === 'expired' ? (
        <div className="notice notice-warn" role="alert">
          This link is no longer active. Please contact the organisation directly.
        </div>
      ) : null}

      <div className="notice">
        <strong>Why you are seeing this</strong>
        We are checking the information supplied with an application, and one item needs clarification. No conclusion
        has been drawn, and being asked about something does not mean anything is wrong. Differences of this kind
        usually have an ordinary explanation.
      </div>

      {context.claim ? (
        <section className="card">
          <h2>The item in question</h2>
          <p>
            <strong>{context.claim.normalizedText}</strong>
          </p>
          <p className="small muted">
            {context.claim.category.replace(/_/g, ' ').toLowerCase()}
            {context.claim.organizationName ? ` · ${context.claim.organizationName}` : ''}
            {context.claim.title ? ` · ${context.claim.title}` : ''}
          </p>
        </section>
      ) : null}

      <section className="card">
        <h2>{context.subject}</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{context.body}</p>
      </section>

      <section className="card">
        <h2>What would help</h2>
        <p className="small muted">Any one of these is usually enough. You do not need to provide all of them.</p>
        <ul>
          {context.acceptableEvidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </section>

      {context.responses.length > 0 ? (
        <section className="card">
          <h2>Your previous responses</h2>
          {context.responses.map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem', marginTop: '0.6rem' }}>
              <p className="small muted">{formatDateTime(r.submittedAt)}</p>
              <p style={{ whiteSpace: 'pre-wrap' }}>{r.message}</p>
              {r.documentIds.length > 0 ? <p className="small muted">{r.documentIds.length} file(s) attached</p> : null}
            </div>
          ))}
        </section>
      ) : null}

      {closed ? (
        <div className="notice">This request has been closed. Thank you for your help.</div>
      ) : (
        <form action={respond} className="card" encType="multipart/form-data">
          <input type="hidden" name="token" value={token} />
          <h2>Your response</h2>
          <div className="field">
            <label htmlFor="message">Your explanation</label>
            <textarea
              id="message"
              name="message"
              required
              placeholder="Explain the item in your own words. If you think our understanding is mistaken, please say so and we will correct our record."
            />
          </div>
          <div className="field">
            <label htmlFor="files">Attach supporting files (optional)</label>
            <input id="files" name="files" type="file" multiple accept=".pdf,.txt,.png,.jpg,.jpeg" />
            <span className="hint">PDF, plain text, or an image. Files are scanned and stored securely.</span>
          </div>
          <button type="submit">Send response</button>
          <p className="hint" style={{ marginTop: '0.6rem' }}>
            This page shows only this one question. It does not give access to your application, to anyone else’s
            comments about it, or to any other part of the review.
          </p>
        </form>
      )}
    </main>
  );
}
