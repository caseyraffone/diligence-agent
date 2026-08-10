import { beforeAll, describe, expect, it } from 'vitest';
import { createCase, createTenant, prisma, resetDatabase, TEST_PASSWORD, type TestTenant } from '../helpers/db';
import { createSession, resolveSession } from '@/lib/auth/session';
import { loadCase, loadClaim, loadDocument } from '@/lib/auth/tenant';
import { assertPermission } from '@/lib/auth/context';
import { NotFoundError, ForbiddenError } from '@/lib/errors';
import { verifyPassword } from '@/lib/crypto';
import { permissionsFor } from '@/lib/auth/permissions';
import type { Actor } from '@/lib/auth/session';

let alpha: TestTenant;
let beta: TestTenant;
let alphaCaseId: string;
let alphaDocId: string;
let alphaClaimId: string;

async function actorFor(tenant: TestTenant, role: keyof TestTenant['users']): Promise<Actor> {
  const session = await createSession(tenant.users[role].id);
  const actor = await resolveSession(session.token);
  if (!actor) throw new Error('session did not resolve');
  return actor;
}

beforeAll(async () => {
  await resetDatabase();
  alpha = await createTenant('alpha');
  beta = await createTenant('beta');

  const created = await createCase(alpha, { reference: 'ALPHA-1' });
  alphaCaseId = created.caseId;

  const doc = await prisma.applicationDocument.create({
    data: {
      organizationId: alpha.organizationId,
      caseId: alphaCaseId,
      filename: 'cv.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      sha256: 'abc',
      storageKey: 'k',
      kind: 'RESUME_CV',
      status: 'PARSED',
    },
  });
  alphaDocId = doc.id;

  const claim = await prisma.extractedClaim.create({
    data: {
      organizationId: alpha.organizationId,
      caseId: alphaCaseId,
      documentId: alphaDocId,
      pageNumber: 1,
      sourcePassage: 'passage',
      normalizedText: 'a claim',
      category: 'EMPLOYMENT',
    },
  });
  alphaClaimId = claim.id;
});

describe('tenant isolation', () => {
  it('lets a tenant load its own case', async () => {
    const actor = await actorFor(alpha, 'LEAD_REVIEWER');
    await expect(loadCase(actor, alphaCaseId)).resolves.toMatchObject({ reference: 'ALPHA-1' });
  });

  it('refuses another tenant’s case', async () => {
    const actor = await actorFor(beta, 'LEAD_REVIEWER');
    await expect(loadCase(actor, alphaCaseId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses another tenant’s document and claim', async () => {
    const actor = await actorFor(beta, 'LEAD_REVIEWER');
    await expect(loadDocument(actor, alphaDocId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadClaim(actor, alphaClaimId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports a cross-tenant read as "not found", never as "forbidden"', async () => {
    // Distinguishing the two would let a caller enumerate which case ids exist
    // in other organisations.
    const actor = await actorFor(beta, 'ADMIN');
    await expect(loadCase(actor, alphaCaseId)).rejects.toThrow(NotFoundError);
    try {
      await loadCase(actor, alphaCaseId);
    } catch (e) {
      expect((e as NotFoundError).publicMessage).toBe('Not found.');
      expect((e as NotFoundError).status).toBe(404);
    }
  });

  it('does not let an administrator reach across tenants', async () => {
    const admin = await actorFor(beta, 'ADMIN');
    await expect(loadCase(admin, alphaCaseId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('scopes list queries to the session organisation', async () => {
    const betaCases = await prisma.case.findMany({ where: { organizationId: beta.organizationId } });
    expect(betaCases).toHaveLength(0);
    const alphaCases = await prisma.case.findMany({ where: { organizationId: alpha.organizationId } });
    expect(alphaCases).toHaveLength(1);
  });
});

describe('role permissions', () => {
  it('gives a read-only auditor no mutating permission', async () => {
    const actor = await actorFor(alpha, 'READ_ONLY_AUDITOR');
    for (const permission of ['claim:edit', 'claim:decide', 'document:upload', 'outreach:approve'] as const) {
      expect(() => assertPermission(actor, permission)).toThrow(ForbiddenError);
    }
    expect(() => assertPermission(actor, 'case:read')).not.toThrow();
  });

  it('withholds tip access from reviewers and auditors', async () => {
    const reviewer = await actorFor(alpha, 'REVIEWER');
    const auditor = await actorFor(alpha, 'READ_ONLY_AUDITOR');
    const lead = await actorFor(alpha, 'LEAD_REVIEWER');

    expect(() => assertPermission(reviewer, 'tip:read')).toThrow(ForbiddenError);
    expect(() => assertPermission(auditor, 'tip:read')).toThrow(ForbiddenError);
    expect(() => assertPermission(lead, 'tip:read')).not.toThrow();
  });

  it('withholds outreach approval from a plain reviewer', async () => {
    const reviewer = await actorFor(alpha, 'REVIEWER');
    expect(() => assertPermission(reviewer, 'outreach:draft')).not.toThrow();
    expect(() => assertPermission(reviewer, 'outreach:approve')).toThrow(ForbiddenError);
  });

  it('grants no role any decision-making capability over a person', async () => {
    // The permission set is closed. If someone adds a permission whose name
    // implies a consequential decision, this fails.
    const consequential = /admit|reject|hire|deny|approve_applicant|score|rank_applicant|eligib/i;
    for (const role of ['ADMIN', 'LEAD_REVIEWER', 'REVIEWER', 'READ_ONLY_AUDITOR'] as const) {
      for (const permission of permissionsFor(role)) {
        expect(permission, `${role} holds ${permission}`).not.toMatch(consequential);
      }
    }
  });

  it('derives permissions from code, not from the stored column', async () => {
    // A tampered database row must not widen access.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'READ_ONLY_AUDITOR' } });
    await prisma.role.update({ where: { id: role.id }, data: { permissions: ['admin:users', 'claim:decide'] } });

    const actor = await actorFor(alpha, 'READ_ONLY_AUDITOR');
    expect(() => assertPermission(actor, 'claim:decide')).toThrow(ForbiddenError);

    await prisma.role.update({ where: { id: role.id }, data: { permissions: role.permissions } });
  });
});

describe('sessions', () => {
  it('does not resolve an unknown or tampered token', async () => {
    expect(await resolveSession('not-a-real-token')).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
  });

  it('does not resolve an expired session', async () => {
    const session = await createSession(alpha.users.REVIEWER.id);
    await prisma.session.updateMany({
      where: { userId: alpha.users.REVIEWER.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await resolveSession(session.token)).toBeNull();
  });

  it('does not resolve a session for a deactivated user', async () => {
    const session = await createSession(alpha.users.REVIEWER.id);
    await prisma.user.update({ where: { id: alpha.users.REVIEWER.id }, data: { isActive: false } });
    expect(await resolveSession(session.token)).toBeNull();
    await prisma.user.update({ where: { id: alpha.users.REVIEWER.id }, data: { isActive: true } });
  });

  it('stores only a hash of the session token', async () => {
    const session = await createSession(alpha.users.ADMIN.id);
    const rows = await prisma.session.findMany({ where: { userId: alpha.users.ADMIN.id } });
    for (const row of rows) {
      expect(row.tokenHash).not.toBe(session.token);
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe('password storage', () => {
  it('never stores a password in clear and verifies correctly', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: alpha.users.ADMIN.id } });
    expect(user.passwordHash).not.toContain(TEST_PASSWORD);
    expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, user.passwordHash)).toBe(true);
    expect(await verifyPassword('wrong-password', user.passwordHash)).toBe(false);
  });
});
