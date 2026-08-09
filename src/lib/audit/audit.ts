import type { ActorType, Prisma } from '@prisma/client';
import { prisma, type TransactionClient } from '@/lib/prisma';
import { sha256 } from '@/lib/crypto';

/**
 * Append-only audit log with a per-organization hash chain.
 *
 * Each event hashes its own content together with the previous event's hash.
 * Deleting or editing a row breaks every subsequent link, so tampering is
 * detectable even by someone with database write access. This does not *prevent*
 * tampering — see LIMITATIONS.md — it makes silent tampering detectable.
 *
 * The sequence number is allocated inside the same transaction as the insert and
 * guarded by a unique constraint on (organizationId, sequence), so two
 * concurrent writers cannot produce a forked chain: the loser fails and retries.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  organizationId: string;
  caseId?: string | null;
  actorType: ActorType;
  actorUserId?: string | null;
  /** Stable verb, e.g. CASE_VIEWED, CLAIM_STATUS_CHANGED, REPORT_EXPORTED. */
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

interface ChainRow {
  organizationId: string;
  sequence: number;
  actorType: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  prevHash: string;
}

/**
 * Canonical serialization for hashing. Key order is fixed explicitly rather
 * than relying on JSON.stringify's insertion order, so a re-verification years
 * later produces the same digest.
 */
export function computeAuditHash(row: ChainRow): string {
  const canonical = JSON.stringify([
    row.organizationId,
    row.sequence,
    row.actorType,
    row.actorUserId ?? '',
    row.action,
    row.entityType,
    row.entityId ?? '',
    stableStringify(row.metadata),
    row.createdAt.toISOString(),
    row.prevHash,
  ]);
  return sha256(canonical);
}

/** Deterministic JSON with sorted object keys at every depth. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const MAX_ATTEMPTS = 5;

/**
 * Appends one audit event. Safe to call inside an existing transaction by
 * passing `tx`; otherwise it manages its own and retries on sequence contention.
 */
export async function recordAudit(input: AuditInput, tx?: TransactionClient): Promise<{ id: string; sequence: number }> {
  if (tx) return appendWithin(tx, input);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction((client) => appendWithin(client, input));
    } catch (e) {
      // Unique violation on (organizationId, sequence) means a concurrent
      // writer took our slot. Re-read the tip and try again.
      if (isUniqueViolation(e)) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to append audit event after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`);
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

async function appendWithin(client: TransactionClient, input: AuditInput): Promise<{ id: string; sequence: number }> {
  const previous = await client.auditEvent.findFirst({
    where: { organizationId: input.organizationId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true, hash: true },
  });

  const sequence = (previous?.sequence ?? 0) + 1;
  const prevHash = previous?.hash ?? GENESIS_HASH;
  const createdAt = new Date();
  const metadata = (input.metadata ?? {}) as Prisma.InputJsonValue;

  const hash = computeAuditHash({
    organizationId: input.organizationId,
    sequence,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata,
    createdAt,
    prevHash,
  });

  const created = await client.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId ?? null,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata,
      createdAt,
      sequence,
      prevHash,
      hash,
    },
    select: { id: true, sequence: true },
  });

  return created;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** Sequence number of the first event that failed verification. */
  brokenAtSequence: number | null;
  reason: string | null;
}

/**
 * Re-derives every hash in an organization's chain and reports the first break.
 * Exposed to auditors in the UI so integrity can be checked on demand.
 */
export async function verifyAuditChain(organizationId: string): Promise<ChainVerification> {
  const events = await prisma.auditEvent.findMany({
    where: { organizationId },
    orderBy: { sequence: 'asc' },
  });

  let expectedPrev = GENESIS_HASH;
  let expectedSequence = 1;

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      return {
        valid: false,
        checked: expectedSequence - 1,
        brokenAtSequence: event.sequence,
        reason: `Sequence gap: expected ${expectedSequence}, found ${event.sequence}. An event may have been deleted.`,
      };
    }
    if (event.prevHash !== expectedPrev) {
      return {
        valid: false,
        checked: expectedSequence - 1,
        brokenAtSequence: event.sequence,
        reason: 'Previous-hash pointer does not match the prior event.',
      };
    }
    const recomputed = computeAuditHash({
      organizationId: event.organizationId,
      sequence: event.sequence,
      actorType: event.actorType,
      actorUserId: event.actorUserId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
      createdAt: event.createdAt,
      prevHash: event.prevHash,
    });
    if (recomputed !== event.hash) {
      return {
        valid: false,
        checked: expectedSequence - 1,
        brokenAtSequence: event.sequence,
        reason: 'Event content does not match its recorded hash. The row was modified after it was written.',
      };
    }
    expectedPrev = event.hash;
    expectedSequence += 1;
  }

  return { valid: true, checked: events.length, brokenAtSequence: null, reason: null };
}
