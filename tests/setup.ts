/**
 * Test environment.
 *
 * Two guarantees the suite depends on, asserted rather than assumed:
 *  - NODE_ENV=test forces the deterministic mock LLM provider and hard-disables
 *    live source calls, so no test can be billable or flaky on a third party.
 *  - DATABASE_URL points at TEST_DATABASE_URL, which the integration helpers
 *    truncate. Running against the development database would destroy seeded
 *    demonstration cases.
 */
// `NODE_ENV` is typed read-only by @types/node; assign through the object.
Object.assign(process.env, { NODE_ENV: 'test' });

if (process.env['TEST_DATABASE_URL']) {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'];
}

process.env['LLM_PROVIDER'] = 'mock';
process.env['ENABLE_LIVE_SOURCES'] = 'false';
process.env['APP_SECRET'] ??= 'test-only-secret-value-padded-to-length-000000';
process.env['DOCUMENT_ENCRYPTION_KEY'] ??= 'test-only-encryption-key-000000';
process.env['APP_BASE_URL'] ??= 'http://localhost:3200';
process.env['OBJECT_STORE_LOCAL_PATH'] ??= './storage/test';
process.env['MALWARE_SCANNER'] ??= 'noop';

if (!process.env['DATABASE_URL']) {
  throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) before running the suite.');
}
