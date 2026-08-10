import { test as setup, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { mkdirSync } from 'node:fs';

/**
 * Signs in once per role and saves the session cookie for the specs to reuse.
 *
 * This exists because the login endpoint is rate limited (ten attempts per
 * email per fifteen minutes) — which is correct behaviour, and which a suite
 * that signed in on every test would trip. Reusing storage state also keeps the
 * specs focused on what they are actually verifying.
 */

const prisma = new PrismaClient();
const PASSWORD = 'DemoReviewer!2026';

export const ROLES = {
  lead: { email: 'lead@redwood.example', state: '.playwright/lead.json' },
  auditor: { email: 'auditor@redwood.example', state: '.playwright/auditor.json' },
  admin: { email: 'admin@redwood.example', state: '.playwright/admin.json' },
  otherTenant: { email: 'lead@aurora.example', state: '.playwright/other-tenant.json' },
} as const;

setup('authenticate every role', async ({ browser }) => {
  mkdirSync('.playwright', { recursive: true });

  // Clear rate-limit counters left by earlier runs. The limits themselves are
  // real and tested elsewhere; here they would only make a repeat run flaky.
  await prisma.rateLimitCounter.deleteMany({});

  for (const { email, state } of Object.values(ROLES)) {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Case queue' })).toBeVisible();

    await context.storageState({ path: state });
    await context.close();
  }

  await prisma.$disconnect();
});
