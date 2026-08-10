import { prisma } from '@/lib/prisma';
import { randomToken, sha256, hmac, safeEqual } from '@/lib/crypto';
import { permissionsFor, type Permission, type RoleKey } from './permissions';

export const SESSION_COOKIE = 'corroborate_session';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const IDLE_REFRESH_MS = 15 * 60 * 1000;

export interface Actor {
  sessionId: string;
  userId: string;
  organizationId: string;
  email: string;
  name: string;
  roleKey: RoleKey;
  permissions: Permission[];
  csrfToken: string;
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(userId: string, userAgent?: string | null): Promise<IssuedSession> {
  const token = randomToken(32);
  const csrfSecret = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfSecret,
      expiresAt,
      userAgentHash: userAgent ? sha256(userAgent) : null,
    },
  });

  return { token, csrfToken: hmac(csrfSecret, 'csrf'), expiresAt };
}

/**
 * Resolves a raw session token to an actor. Returns null for any failure —
 * expired, revoked, unknown, or belonging to a deactivated user — without
 * distinguishing between them to the caller.
 */
export async function resolveSession(token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { role: true } } },
  });

  if (!session || session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user.isActive) return null;

  const roleKey = session.user.role.key as RoleKey;

  // Permissions are derived from the role definition in code, not from the
  // denormalized column, so a stale database row cannot widen access.
  const permissions = permissionsFor(roleKey);

  if (Date.now() - session.lastSeenAt.getTime() > IDLE_REFRESH_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    organizationId: session.user.organizationId,
    email: session.user.email,
    name: session.user.name,
    roleKey,
    permissions,
    csrfToken: hmac(session.csrfSecret, 'csrf'),
  };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session
    .update({ where: { tokenHash: sha256(token) }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Verifies a submitted CSRF token against the session's stored secret.
 * Uses the double-submit pattern: the token is an HMAC of a per-session secret,
 * so it cannot be forged by a cross-origin page that cannot read it.
 */
export async function verifyCsrf(sessionId: string, submitted: string | null | undefined): Promise<boolean> {
  if (!submitted) return false;
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { csrfSecret: true } });
  if (!session) return false;
  return safeEqual(hmac(session.csrfSecret, 'csrf'), submitted);
}

export function sessionCookieOptions(expiresAt: Date): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  expires: Date;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Secure is required in production; omitted locally so http://localhost works.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}
