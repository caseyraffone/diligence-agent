import { cookies, headers } from 'next/headers';
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors';
import { resolveSession, verifyCsrf, SESSION_COOKIE, CSRF_HEADER, type Actor } from './session';
import type { Permission } from './permissions';

export type { Actor };

/** Resolves the current reviewer from the request cookie, or null. */
export async function getActor(): Promise<Actor | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new UnauthenticatedError();
  return actor;
}

/**
 * Requires an authenticated actor holding `permission`.
 *
 * Missing permission raises ForbiddenError, which renders as 404 so an
 * unauthorized caller cannot use error codes to enumerate what exists.
 */
export async function requirePermission(permission: Permission): Promise<Actor> {
  const actor = await requireActor();
  assertPermission(actor, permission);
  return actor;
}

export function assertPermission(actor: Actor, permission: Permission): void {
  if (!actor.permissions.includes(permission)) {
    throw new ForbiddenError(`Role ${actor.roleKey} lacks ${permission}`);
  }
}

export function hasPermission(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

/**
 * Guards every state-changing request. Must be called by all mutating API
 * routes before they touch the database.
 */
export async function requireMutation(permission: Permission): Promise<Actor> {
  const actor = await requirePermission(permission);
  const headerList = await headers();

  const submitted = headerList.get(CSRF_HEADER);
  if (!(await verifyCsrf(actor.sessionId, submitted))) {
    throw new ForbiddenError('CSRF token missing or invalid');
  }

  // Defence in depth alongside SameSite=Lax: reject cross-origin mutations
  // outright when the browser tells us where the request came from.
  const origin = headerList.get('origin');
  if (origin) {
    const expected = process.env.APP_BASE_URL ?? 'http://localhost:3200';
    if (new URL(origin).origin !== new URL(expected).origin) {
      throw new ForbiddenError(`Cross-origin mutation refused from ${origin}`);
    }
  }

  return actor;
}
