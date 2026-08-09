#!/usr/bin/env node
/**
 * Test runner.
 *
 *   npm test
 *
 * Points Prisma at TEST_DATABASE_URL, applies migrations to it, then runs
 * Vitest. Keeping this in one place means a contributor cannot accidentally run
 * the suite — which truncates tables — against the development database.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env without a dependency: Node 22 supports --env-file, but we also want
// this to work when the file is absent (CI supplies real environment vars).
const envFile = join(root, '.env');
const nodeOptions = existsSync(envFile) ? ['--env-file', envFile] : [];

const preload = execFileSync(
  process.execPath,
  [...nodeOptions, '-e', 'process.stdout.write(JSON.stringify({t:process.env.TEST_DATABASE_URL||"",d:process.env.DATABASE_URL||""}))'],
  { cwd: root, encoding: 'utf8' },
);

const { t: testUrl, d: devUrl } = JSON.parse(preload);

if (!testUrl) {
  console.error('TEST_DATABASE_URL is not set. Point it at a throwaway database — the suite truncates it.');
  process.exit(1);
}
if (testUrl === devUrl) {
  console.error('TEST_DATABASE_URL must differ from DATABASE_URL. The suite truncates its database.');
  process.exit(1);
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: testUrl,
  // Belt and braces: the env module also hard-disables these under NODE_ENV=test.
  LLM_PROVIDER: 'mock',
  ENABLE_LIVE_SOURCES: 'false',
};

console.log('▸ Applying migrations to the test database');
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: root, stdio: 'inherit', env });

console.log('\n▸ Running tests\n');
execFileSync('npx', ['vitest', 'run', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });
