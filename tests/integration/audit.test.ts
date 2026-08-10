import { beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createCase, createTenant, prisma, resetDatabase, type TestTenant } from '../helpers/db';
import { recordAudit, verifyAuditChain, GENESIS_HASH, stableStringify } from '@/lib/audit/audit';

let tenant: TestTenant;
let caseId: string;

beforeAll(async () => {
  await resetDatabase();
  tenant = await createTenant('audit');
  caseId = (await createCase(tenant, { reference: 'AUD-1' })).caseId;
});

describe('audit chain', () => {
  it('starts from a genesis hash and increments sequence', async () => {
    const first = await recordAudit({
      organizationId: tenant.organizationId,
      caseId,
      actorType: 'USER',
      actorUserId: tenant.users.LEAD_REVIEWER.id,
      action: 'CASE_VIEWED',
      entityType: 'Case',
      entityId: caseId,
    });
    expect(first.sequence).toBe(1);

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { sequence: 1, organizationId: tenant.organizationId },
    });
    expect(row.prevHash).toBe(GENESIS_HASH);

    const second = await recordAudit({
      organizationId: tenant.organizationId,
      caseId,
      actorType: 'USER',
      actorUserId: tenant.users.LEAD_REVIEWER.id,
      action: 'CLAIM_EDITED',
      entityType: 'ExtractedClaim',
    });
    expect(second.sequence).toBe(2);
  });

  it('verifies an untouched chain', async () => {
    const result = await verifyAuditChain(tenant.organizationId);
    expect(result.valid).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.brokenAtSequence).toBeNull();
  });

  it('links each event to the one before it', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { sequence: 'asc' },
    });
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.prevHash).toBe(events[i - 1]!.hash);
    }
  });

  it('detects a modified event', async () => {
    const target = await prisma.auditEvent.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
      orderBy: { sequence: 'asc' },
    });
    const original = target.action;

    // Simulate someone editing the log directly in the database.
    await prisma.auditEvent.update({ where: { id: target.id }, data: { action: 'NOTHING_HAPPENED' } });

    const result = await verifyAuditChain(tenant.organizationId);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(target.sequence);
    expect(result.reason).toMatch(/does not match its recorded hash/i);

    await prisma.auditEvent.update({ where: { id: target.id }, data: { action: original } });
    expect((await verifyAuditChain(tenant.organizationId)).valid).toBe(true);
  });

  it('detects a deleted event', async () => {
    const before = await verifyAuditChain(tenant.organizationId);
    expect(before.valid).toBe(true);

    const target = await prisma.auditEvent.findFirstOrThrow({
      where: { organizationId: tenant.organizationId },
      orderBy: { sequence: 'asc' },
    });
    // `metadata` comes back as JsonValue, which is wider than the create input,
    // so the row is restored field by field rather than spread.
    const snapshot = {
      id: target.id,
      organizationId: target.organizationId,
      caseId: target.caseId,
      actorType: target.actorType,
      actorUserId: target.actorUserId,
      action: target.action,
      entityType: target.entityType,
      entityId: target.entityId,
      metadata: target.metadata ?? {},
      createdAt: target.createdAt,
      sequence: target.sequence,
      prevHash: target.prevHash,
      hash: target.hash,
    } satisfies Prisma.AuditEventUncheckedCreateInput;

    await prisma.auditEvent.delete({ where: { id: target.id } });

    const result = await verifyAuditChain(tenant.organizationId);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/sequence gap/i);

    await prisma.auditEvent.create({ data: snapshot });
    expect((await verifyAuditChain(tenant.organizationId)).valid).toBe(true);
  });

  it('keeps chains separate per organisation', async () => {
    const other = await createTenant('audit-two');
    const event = await recordAudit({
      organizationId: other.organizationId,
      actorType: 'SYSTEM',
      action: 'CASE_CREATED',
      entityType: 'Case',
    });
    // A fresh tenant starts its own chain at 1.
    expect(event.sequence).toBe(1);
    expect((await verifyAuditChain(other.organizationId)).valid).toBe(true);
  });
});

describe('canonical serialization', () => {
  it('produces the same string regardless of key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('is stable for nested structures', () => {
    expect(stableStringify({ x: { z: 1, y: [3, { b: 1, a: 2 }] } })).toBe(
      stableStringify({ x: { y: [3, { a: 2, b: 1 }], z: 1 } }),
    );
  });
});

describe('what gets logged', () => {
  it('records consequential actions with their context', async () => {
    await recordAudit({
      organizationId: tenant.organizationId,
      caseId,
      actorType: 'USER',
      actorUserId: tenant.users.LEAD_REVIEWER.id,
      action: 'REPORT_EXPORTED',
      entityType: 'Case',
      entityId: caseId,
      metadata: { format: 'pdf' },
    });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'REPORT_EXPORTED', organizationId: tenant.organizationId },
    });
    expect(event.actorUserId).toBe(tenant.users.LEAD_REVIEWER.id);
    expect(event.metadata).toMatchObject({ format: 'pdf' });
  });

  it('never records a secret or a raw token in metadata', async () => {
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenant.organizationId } });
    for (const event of events) {
      const serialized = JSON.stringify(event.metadata);
      expect(serialized).not.toMatch(/api[_-]?key|password|passwordHash|Bearer |tokenHash/i);
    }
  });
});
