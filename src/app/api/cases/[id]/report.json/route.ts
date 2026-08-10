import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/context';
import { loadCase } from '@/lib/auth/tenant';
import { buildCaseReport } from '@/modules/caseReviewer';
import { recordAudit } from '@/lib/audit/audit';
import { isAppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requirePermission('report:export');
    const { id } = await context.params;
    const record = await loadCase(actor, id);

    const report = await buildCaseReport(id, actor.organizationId);

    // Exports leave the system. Logging them is not optional.
    await recordAudit({
      organizationId: actor.organizationId,
      caseId: id,
      actorType: 'USER',
      actorUserId: actor.userId,
      action: 'REPORT_EXPORTED',
      entityType: 'Case',
      entityId: id,
      metadata: { format: 'json' },
    });

    return new NextResponse(JSON.stringify(report, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${record.reference}-verification-report.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    if (isAppError(e)) {
      return NextResponse.json({ error: e.publicMessage }, { status: e.status });
    }
    throw e;
  }
}
