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
 * Guards state-changing API routes (fetch-driven).
 *
 * Requires the permission, a valid double-submit CSRF token, and — when the
 * browser supplies one — a same-origin `Origin` header.
 */
export async function requireMutation(permission: Permission): Promise<Actor> {
  const actor = await requirePermission(permission);
  const headerList = await headers();

  const submitted = headerList.get(CSRF_HEADER);
  if (!(await verifyCsrf(actor.sessionId, submitted))) {
    throw new ForbiddenError('CSRF token missing or invalid');
  }

  await assertSameOrigin(headerList);
  return actor;
}

/**
 * Guards state-changing Server Actions.
 *
 * Server Actions cannot carry a custom header, so the double-submit token does
 * not apply. Next.js already refuses an action whose `Origin` does not match
 * the `Host`; this adds our own explicit check against the configured base URL
 * and the permission check, so the guarantee does not rest solely on framework
 * behaviour.
 */
export async function requireServerAction(permission: Permission): Promise<Actor> {
  const actor = await requirePermission(permission);
  await assertSameOrigin(await headers());
  return actor;
}

async function assertSameOrigin(headerList: Headers): Promise<void> {
  const origin = headerList.get('origin');
  // Same-origin non-fetch form posts may omit Origin; SameSite=Lax on the
  // session cookie covers that case.
  if (!origin) return;

  const expected = process.env.APP_BASE_URL ?? 'http://localhost:3200';
  let submitted: string;
  try {
    submitted = new URL(origin).origin;
  } catch {
    throw new ForbiddenError(`Unparseable Origin header: ${origin}`);
  }
  if (submitted !== new URL(expected).origin) {
    throw new ForbiddenError(`Cross-origin mutation refused from ${origin}`);
  }
}
