import { expect, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

/**
 * Applicant portal.
 *
 * Verifies both that the applicant can respond, and — more importantly — that
 * the link exposes nothing beyond the single clarification request.
 */

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an applicant can answer a clarification, and sees nothing else', async ({ page }) => {
  // The seed sends a clarification on the job-application case. Mint a fresh
  // link for it so the browser test has a usable token.
  const request = await prisma.clarificationRequest.findFirstOrThrow({
    where: { status: { in: ['SENT', 'RESPONDED'] } },
    include: { claim: true, case: { include: { applicant: true } } },
  });

  const { createHash, randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  await prisma.clarificationRequest.update({
    where: { id: request.id },
    data: {
      status: 'SENT',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  await page.goto(`/portal/${token}`);

  await expect(page.getByRole('heading', { name: 'A question about your application' })).toBeVisible();
  await expect(page.getByText(/No conclusion has been drawn/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What would help' })).toBeVisible();

  const body = await page.locator('body').innerText();

  // The portal must not leak the rest of the case.
  expect(body).not.toContain(request.case.reference);
  expect(body.toLowerCase()).not.toContain('reviewer note');
  expect(body.toLowerCase()).not.toContain('anonymous');
  expect(body.toLowerCase()).not.toContain('audit');
  expect(body.toLowerCase()).not.toContain('priority score');

  // And never characterises the applicant. Word boundaries matter here:
  // "supplied" legitimately contains "lied".
  for (const word of ['fraud', 'lied', 'dishonest', 'suspicious', 'discrepancy']) {
    expect(body, `portal must not use "${word}"`).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
  }

  await page
    .getByLabel('Your explanation')
    .fill(
      'Thank you for asking. The two documents describe different points in the same period; I can supply the offer letter if that helps.',
    );
  await page.getByRole('button', { name: 'Send response' }).click();

  await expect(page.getByText(/your response has been recorded/i)).toBeVisible();
  await expect(page.getByText(/your original application is unchanged/i)).toBeVisible();
});

test('an invalid or expired portal link reveals nothing', async ({ page }) => {
  await page.goto('/portal/this-token-does-not-exist-at-all-1234567890');
  const body = await page.locator('body').innerText();
  expect(body.toLowerCase()).toMatch(/404|not found/);
  // No case, applicant, or organisation detail may leak from a bad token.
  expect(body).not.toMatch(/RU-2026|AT-2026/);
});
