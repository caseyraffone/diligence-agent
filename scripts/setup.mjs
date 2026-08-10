#!/usr/bin/env node
/**
 * One-command development setup.
 *
 *   npm run setup
 *
 * Waits for PostgreSQL, applies migrations, generates the Prisma client, and
 * seeds the three demonstration cases. Safe to re-run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log('▸ Corroborate Agent — setup\n');

// 1. Ensure a .env exists. The example defaults need no API keys.
if (!existsSync(join(root, '.env'))) {
  copyFileSync(join(root, '.env.example'), join(root, '.env'));
  console.log('  Created .env from .env.example');
  console.log('  NOTE: replace APP_SECRET and DOCUMENT_ENCRYPTION_KEY before any non-local use.\n');
}

// 2. Wait for the database. Docker Compose reports healthy before Postgres is
//    always ready to accept our first connection, so we poll.
process.stdout.write('  Waiting for PostgreSQL');
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    capture('npx', ['prisma', 'db', 'execute', '--stdin']);
    ready = true;
    break;
  } catch {
    process.stdout.write('.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}
console.log(ready ? ' ok' : ' not reachable');

if (!ready) {
  console.error(
    [
      '',
      '  Could not reach the database using DATABASE_URL in .env.',
      '',
      '  Docker:      docker compose up -d db',
      '  Without Docker: see "PostgreSQL without Docker" in README.md',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// 3. Schema, client, data.
console.log('\n▸ Applying migrations');
run('npx', ['prisma', 'migrate', 'deploy']);

console.log('\n▸ Generating Prisma client');
run('npx', ['prisma', 'generate']);

console.log('\n▸ Seeding demonstration data');
run('npx', ['tsx', 'prisma/seed.ts']);

console.log(
  [
    '',
    '▸ Ready.',
    '',
    '  Start the app:  npm run dev     →  http://localhost:3200',
    '  Run the tests:  npm test',
    '',
    '  Demo sign-ins are printed by the seed above. LLM_PROVIDER=mock, so',
    '  nothing here makes a paid API call.',
    '',
  ].join('\n'),
);
