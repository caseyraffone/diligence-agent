import { revalidatePath } from 'next/cache';
import { TaskStatus } from '@prisma/client';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { prisma } from '@/lib/prisma';
import { drainQueue } from '@/queue/worker';
import { DecisionSupportNotice, EmptyState, Pill, Stat, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function runQueue(): Promise<void> {
  'use server';
  await requireServerAction('sourcecheck:run');
  await drainQueue({ maxTasks: 200 });
  revalidatePath('/queue');
}

const TASK_TONE: Record<TaskStatus, 'ok' | 'warn' | 'conflict' | 'neutral' | 'info'> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  SUCCEEDED: 'ok',
  FAILED: 'conflict',
  CANCELLED: 'neutral',
  BLOCKED_AWAITING_CONSENT: 'warn',
};

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const actor = await requireActor();
  const filters = await searchParams;

  const where = {
    organizationId: actor.organizationId,
    ...(filters.status ? { status: filters.status as TaskStatus } : {}),
  };

  const [tasks, counts] = await Promise.all([
    prisma.verificationTask.findMany({
      where,
      include: { case: { select: { id: true, reference: true } }, claim: { select: { normalizedText: true } } },
      orderBy: [{ status: 'asc' }, { priority: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    }),
    prisma.verificationTask.groupBy({
      by: ['status'],
      where: { organizationId: actor.organizationId },
      _count: true,
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>;

  return (
    <>
      <div className="page-head">
        <h1>Verification queue</h1>
        <p>
          Background verification work across your organisation’s cases. Tasks blocked on consent are parked, never
          run — they resume automatically once consent is recorded on the case.
        </p>
      </div>

      <DecisionSupportNotice />

      <div className="grid" style={{ marginBottom: '1rem' }}>
        <Stat value={byStatus['PENDING'] ?? 0} label="Pending" />
        <Stat value={byStatus['BLOCKED_AWAITING_CONSENT'] ?? 0} label="Blocked on consent" />
        <Stat value={byStatus['SUCCEEDED'] ?? 0} label="Completed" />
        <Stat value={byStatus['FAILED'] ?? 0} label="Failed after retries" />
      </div>

      <div className="card no-print">
        <form method="get" className="row" style={{ marginBottom: '0.75rem' }}>
          <div>
            <label htmlFor="status">Task status</label>
            <select id="status" name="status" defaultValue={filters.status ?? ''}>
              <option value="">Any status</option>
              {Object.values(TaskStatus).map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button type="submit" className="btn-secondary">
              Filter
            </button>
          </div>
        </form>

        {actor.permissions.includes('sourcecheck:run') ? (
          <form action={runQueue}>
            <button type="submit">Process pending tasks now</button>
            <span className="hint">
              In production this runs continuously in a separate worker process. Here it runs on demand so the
              behaviour is observable.
            </span>
          </form>
        ) : null}
      </div>

      <div className="table-wrap">
        <table>
          <caption>{tasks.length} task(s)</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Task</th>
              <th scope="col">Subject</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Updated</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="small">
                  <a href={`/cases/${t.case.id}`}>{t.case.reference}</a>
                </td>
                <td className="small">{t.type.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="small muted">{t.claim?.normalizedText.slice(0, 60) ?? '—'}</td>
                <td>
                  <Pill tone={TASK_TONE[t.status]}>{t.status.replace(/_/g, ' ').toLowerCase()}</Pill>
                </td>
                <td className="small">
                  {t.attempts}/{t.maxAttempts}
                </td>
                <td className="small">{formatDateTime(t.updatedAt)}</td>
                <td className="small muted" style={{ maxWidth: '32ch', overflowWrap: 'anywhere' }}>
                  {t.error ?? '—'}
                </td>
              </tr>
            ))}
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState>Nothing in the queue.</EmptyState>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
