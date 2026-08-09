import { randomUUID } from 'node:crypto';
import { TaskStatus, TaskType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConsentRequiredError } from '@/lib/errors';
import { mapClaimsForDocument } from '@/modules/claimMapper';
import { runSourceCheck } from '@/modules/evidenceVerifier';
import { analyzeCase } from '@/modules/consistencyAnalyst';

/**
 * Durable background worker.
 *
 * Backed by `VerificationTask` rows rather than Redis or an external broker, so
 * the MVP has one runtime dependency (PostgreSQL) instead of two, and a restart
 * loses nothing. Claiming uses a conditional UPDATE, which is safe with several
 * workers running.
 *
 * The queue is where verification actually happens, so two behaviours matter:
 *
 *  - A task blocked by missing consent is parked as BLOCKED_AWAITING_CONSENT,
 *    not failed. It resumes when consent is recorded, and it never silently
 *    proceeds without it.
 *  - Retries are bounded and backed off. A source that is down must not be
 *    hammered, and a permanently failing task must not spin forever.
 */

const BASE_BACKOFF_MS = 5_000;

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  blocked: number;
}

/**
 * Processes queued tasks until the queue is empty or `maxTasks` is reached.
 *
 * Used by the API route that runs verification, by the seed script, and by
 * tests. A production deployment would run this on an interval in a separate
 * process.
 */
export async function drainQueue(options: { maxTasks?: number; caseId?: string } = {}): Promise<DrainResult> {
  const maxTasks = options.maxTasks ?? 200;
  const workerId = randomUUID();

  const result: DrainResult = { processed: 0, succeeded: 0, failed: 0, blocked: 0 };

  for (let i = 0; i < maxTasks; i++) {
    const task = await claimNextTask(workerId, options.caseId);
    if (!task) break;

    result.processed++;

    try {
      await execute(task);
      await prisma.verificationTask.update({
        where: { id: task.id },
        data: { status: TaskStatus.SUCCEEDED, lockedAt: null, lockedBy: null, error: null },
      });
      result.succeeded++;
    } catch (e) {
      if (e instanceof ConsentRequiredError) {
        // Parked, not failed. This is a workflow state, not an error.
        await prisma.verificationTask.update({
          where: { id: task.id },
          data: {
            status: TaskStatus.BLOCKED_AWAITING_CONSENT,
            lockedAt: null,
            lockedBy: null,
            error: e.publicMessage,
          },
        });
        result.blocked++;
        continue;
      }

      const message = e instanceof Error ? e.message : String(e);
      const exhausted = task.attempts + 1 >= task.maxAttempts;

      await prisma.verificationTask.update({
        where: { id: task.id },
        data: {
          status: exhausted ? TaskStatus.FAILED : TaskStatus.PENDING,
          lockedAt: null,
          lockedBy: null,
          error: message.slice(0, 2000),
          // Exponential backoff so a struggling source gets room to recover.
          runAfter: new Date(Date.now() + BASE_BACKOFF_MS * Math.pow(2, task.attempts)),
        },
      });
      if (exhausted) result.failed++;
    }
  }

  return result;
}

interface ClaimedTask {
  id: string;
  organizationId: string;
  caseId: string;
  claimId: string | null;
  type: TaskType;
  attempts: number;
  maxAttempts: number;
  payload: unknown;
}

/**
 * Atomically claims one task.
 *
 * `updateMany` with the id AND the expected status in the predicate means two
 * workers racing for the same row produce exactly one winner — the loser
 * updates zero rows and moves on.
 */
async function claimNextTask(workerId: string, caseId?: string): Promise<ClaimedTask | null> {
  const candidate = await prisma.verificationTask.findFirst({
    where: {
      status: TaskStatus.PENDING,
      runAfter: { lte: new Date() },
      ...(caseId ? { caseId } : {}),
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });

  if (!candidate) return null;

  const claimed = await prisma.verificationTask.updateMany({
    where: { id: candidate.id, status: TaskStatus.PENDING },
    data: {
      status: TaskStatus.RUNNING,
      lockedAt: new Date(),
      lockedBy: workerId,
      attempts: { increment: 1 },
    },
  });

  if (claimed.count === 0) return null;

  return {
    id: candidate.id,
    organizationId: candidate.organizationId,
    caseId: candidate.caseId,
    claimId: candidate.claimId,
    type: candidate.type,
    attempts: candidate.attempts,
    maxAttempts: candidate.maxAttempts,
    payload: candidate.payload,
  };
}

async function execute(task: ClaimedTask): Promise<void> {
  const payload = (task.payload ?? {}) as Record<string, unknown>;

  switch (task.type) {
    case TaskType.EXTRACT_CLAIMS: {
      const documentId = String(payload['documentId'] ?? '');
      if (!documentId) throw new Error('EXTRACT_CLAIMS task is missing documentId');
      await mapClaimsForDocument({
        caseId: task.caseId,
        documentId,
        organizationId: task.organizationId,
        actorUserId: null,
      });
      return;
    }

    case TaskType.RUN_SOURCE_CHECK: {
      const adapterKey = String(payload['adapterKey'] ?? '');
      if (!adapterKey || !task.claimId) throw new Error('RUN_SOURCE_CHECK task is missing adapterKey or claimId');
      await runSourceCheck({
        claimId: task.claimId,
        organizationId: task.organizationId,
        adapterKey,
        actorUserId: null,
        actorType: 'SYSTEM',
      });
      return;
    }

    case TaskType.ANALYZE_CONSISTENCY: {
      await analyzeCase({
        caseId: task.caseId,
        organizationId: task.organizationId,
        actorUserId: null,
      });
      return;
    }

    case TaskType.PARSE_DOCUMENT:
    case TaskType.PLAN_VERIFICATION:
    case TaskType.GENERATE_INTERVIEW_QUESTIONS:
    case TaskType.RECOMPUTE_CASE_SUMMARY:
    case TaskType.APPLY_RETENTION:
      // These are reachable only when explicitly enqueued by an operator
      // action; the MVP performs them inline instead.
      return;
  }
}

/** Requeues consent-blocked tasks once consent has been recorded. */
export async function unblockConsentTasks(caseId: string): Promise<number> {
  const { count } = await prisma.verificationTask.updateMany({
    where: { caseId, status: TaskStatus.BLOCKED_AWAITING_CONSENT },
    data: { status: TaskStatus.PENDING, runAfter: new Date(), error: null },
  });
  return count;
}
