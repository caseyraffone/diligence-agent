import { prisma } from '@/lib/prisma';
import { hmac } from '@/lib/crypto';
import { RateLimitedError } from '@/lib/errors';

/**
 * Durable, database-backed fixed-window rate limiting.
 *
 * Chosen over an in-memory counter because the limits that matter here (login,
 * anonymous tips, applicant portal submissions) must survive a process restart
 * and hold across multiple app instances. Fixed windows allow a burst at a
 * boundary; that is acceptable for these endpoints and is documented in
 * LIMITATIONS.md.
 */

export interface RateLimitOptions {
  /** Logical bucket, e.g. 'login' or 'tip'. */
  scope: string;
  /** Caller identity within the scope: email, org id, or a coarse fingerprint. */
  identifier: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimit(options: RateLimitOptions): Promise<RateLimitOutcome> {
  const { scope, identifier, limit, windowSeconds } = options;
  const now = new Date();

  // The identifier is HMAC'd so the counter table never stores a raw email
  // address or an IP-derived value in plaintext.
  const bucketKey = `${scope}:${hmac(identifier, `ratelimit:${scope}`)}`;

  const existing = await prisma.rateLimitCounter.findUnique({ where: { bucketKey } });

  if (!existing || existing.windowEndsAt <= now) {
    const windowEndsAt = new Date(now.getTime() + windowSeconds * 1000);
    await prisma.rateLimitCounter.upsert({
      where: { bucketKey },
      create: { bucketKey, count: 1, windowEndsAt },
      update: { count: 1, windowEndsAt },
    });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.windowEndsAt.getTime() - now.getTime()) / 1000)),
    };
  }

  const updated = await prisma.rateLimitCounter.update({
    where: { bucketKey },
    data: { count: { increment: 1 } },
  });

  return { allowed: true, remaining: Math.max(0, limit - updated.count), retryAfterSeconds: 0 };
}

/** Consumes a slot and throws RateLimitedError when the bucket is exhausted. */
export async function enforceRateLimit(options: RateLimitOptions): Promise<void> {
  const outcome = await consumeRateLimit(options);
  if (!outcome.allowed) {
    throw new RateLimitedError(`Rate limit exceeded for ${options.scope}`, outcome.retryAfterSeconds);
  }
}

/** Removes expired counters. Called by the maintenance task. */
export async function pruneRateLimitCounters(): Promise<number> {
  const { count } = await prisma.rateLimitCounter.deleteMany({ where: { windowEndsAt: { lte: new Date() } } });
  return count;
}
