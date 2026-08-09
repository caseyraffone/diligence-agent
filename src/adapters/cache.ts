import { getEnv } from '@/lib/env';
import { sha256 } from '@/lib/crypto';

/**
 * In-process cache for live source responses.
 *
 * Open APIs like Crossref and PubMed ask callers to be considerate. Caching by
 * TTL means a re-run of a case does not re-query for the same DOI, and a
 * reviewer refreshing a page costs nothing upstream.
 *
 * Deliberately in-memory: cached third-party responses about an applicant are
 * personal data, and keeping them out of durable storage limits how long they
 * persist. The excerpt that matters is copied into the SourceCheck row, which
 * is the record subject to retention rules.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 500;

export function cacheKey(adapterKey: string, query: unknown): string {
  return `${adapterKey}:${sha256(JSON.stringify(query))}`;
}

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T): void {
  if (store.size >= MAX_ENTRIES) {
    // Simple FIFO eviction; insertion order is preserved by Map.
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: Date.now() + getEnv().LIVE_SOURCE_CACHE_TTL_SECONDS * 1000 });
}

export function cacheClear(): void {
  store.clear();
}

/** Identifying User-Agent, required by the open APIs' access policies. */
export function liveUserAgent(): string {
  const env = getEnv();
  return `CredentialIntegrityAgent/0.1 (mailto:${env.LIVE_SOURCE_CONTACT_EMAIL ?? 'unknown'})`;
}
