import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/context';
import { loadDocument } from '@/lib/auth/tenant';
import { getObjectStore } from '@/providers/storage';
import { recordAudit } from '@/lib/audit/audit';
import { isAppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Serves an original uploaded file.
 *
 * Uploads are attacker-controlled bytes. This route never lets the browser
 * treat them as active content in the application's origin:
 *
 *  - `Content-Disposition: attachment` forces a download rather than a render;
 *  - the content type is forced to `application/octet-stream`, so an uploaded
 *    HTML or SVG file cannot be rendered as a document;
 *  - `X-Content-Type-Options: nosniff` stops the browser second-guessing that;
 *  - a sandboxed CSP applies even if a browser ignores the above.
 */
export async function GET(_request: Request, context: { params: Promise<{ docId: string }> }) {
  try {
    const actor = await requirePermission('document:download_original');
    const { docId } = await context.params;
    const document = await loadDocument(actor, docId);

    if (!document.storageKey || document.originalDeletedAt) {
      return NextResponse.json(
        { error: 'The original file is no longer stored. It may have been removed under a retention rule.' },
        { status: 410 },
      );
    }

    const bytes = await getObjectStore().get(document.storageKey);

    await recordAudit({
      organizationId: actor.organizationId,
      caseId: document.caseId,
      actorType: 'USER',
      actorUserId: actor.userId,
      action: 'DOCUMENT_ORIGINAL_DOWNLOADED',
      entityType: 'ApplicationDocument',
      entityId: docId,
      metadata: { filename: document.filename },
    });

    // Strip anything that could steer a downstream parser via the filename.
    const safeName = document.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${safeName}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store, private',
      },
    });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json({ error: e.publicMessage }, { status: e.status });
    throw e;
  }
}
