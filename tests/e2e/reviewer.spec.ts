import { expect, test } from '@playwright/test';

/**
 * Browser verification of the principal reviewer flows against the seeded
 * demonstration cases. Sessions come from the auth setup project, so these
 * specs exercise the journey rather than repeatedly hitting the login endpoint.
 */

test.describe('lead reviewer', () => {
  test.use({ storageState: '.playwright/lead.json' });

  test('sees only their own tenant’s cases', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Case queue' })).toBeVisible();

    await expect(page.getByRole('link', { name: 'RU-2026-0142' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'RU-2026-0207' })).toBeVisible();
    // Aurora is a separate tenant.
    await expect(page.getByRole('link', { name: 'AT-2026-0088' })).toHaveCount(0);

    await expect(page.getByText('Decision-support only')).toBeVisible();
  });

  test('the fully corroborated case shows recorded outcomes with page citations', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0142' }).click();

    await expect(page.getByRole('heading', { name: /Undergraduate application/ })).toBeVisible();
    await expect(page.getByText('Documented applicant consent')).toBeVisible();

    await page.getByRole('link', { name: 'Claims & evidence' }).click();

    // Status pills, not the hidden <option>s in the decision form.
    await expect(page.locator('.pill', { hasText: 'Verified' }).first()).toBeVisible();

    // Every claim cites the document and page it came from.
    await expect(page.getByRole('link', { name: /okonkwo-cv\.txt, page \d/ }).first()).toBeVisible();

    // And the reviewer who recorded each outcome is named.
    await expect(page.getByText(/Outcome recorded by/).first()).toBeVisible();
  });

  test('the conflicting case documents the difference without accusing anyone', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0207' }).click();
    await page.getByRole('link', { name: 'Observations' }).click();

    await expect(page.getByText('These are observations, not findings')).toBeVisible();
    await expect(page.getByText(/A source record differs from the claim/).first()).toBeVisible();

    const body = await page.locator('body').innerText();
    // Word boundaries: "supplied" legitimately contains "lied".
    for (const word of ['fraud', 'fraudulent', 'lied', 'dishonest', 'fabricated', 'forged']) {
      expect(body, `page must not use "${word}"`).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
    }
  });

  test('a prompt injection in an uploaded document is surfaced but ineffective', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0207' }).click();
    await page.getByRole('link', { name: 'raman-supporting-note.txt' }).click();

    await expect(page.getByText(/appears to address an automated reader/).first()).toBeVisible();
    await expect(page.getByText(/did not affect extraction/).first()).toBeVisible();

    // Nothing extracted from that document reached a verified state.
    await expect(page.locator('table').last().locator('.pill', { hasText: 'Verified' })).toHaveCount(0);
  });

  test('the report separates the categories of information', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0142' }).click();
    await page.getByRole('link', { name: 'Report' }).click();

    await expect(page.getByText(/does not determine whether any statement is true/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Confirmed facts/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Applicant statements/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Third-party statements/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /System observations/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Inferences/ })).toBeVisible();
  });

  test('JSON and PDF reports download', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0142' }).click();
    await page.getByRole('link', { name: 'Report' }).click();

    const jsonUrl = await page.getByRole('link', { name: 'Download JSON' }).getAttribute('href');
    const pdfUrl = await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href');

    const jsonResponse = await page.request.get(jsonUrl!);
    expect(jsonResponse.status()).toBe(200);
    const report = await jsonResponse.json();
    expect(report.notice).toContain('does not determine whether any statement is true');
    expect(report.claims.length).toBeGreaterThan(0);
    expect(report.auditIntegrity.valid).toBe(true);

    const pdfResponse = await page.request.get(pdfUrl!);
    expect(pdfResponse.status()).toBe(200);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
    expect((await pdfResponse.body()).subarray(0, 4).toString()).toBe('%PDF');
  });

  test('the audit history verifies its own chain', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0142' }).click();
    await page.getByRole('link', { name: 'Audit history' }).click();

    await expect(page.getByText('Chain intact')).toBeVisible();
    await expect(page.getByText(/case viewed/i).first()).toBeVisible();
  });

  test('the outreach queue holds a draft awaiting approval and sends nothing', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'RU-2026-0207' }).click();
    await page.getByRole('link', { name: 'Outreach & clarifications' }).click();

    await expect(page.getByText('This system never sends anything')).toBeVisible();
    await expect(page.locator('.pill', { hasText: 'pending approval' }).first()).toBeVisible();
  });
});

test.describe('read-only auditor', () => {
  test.use({ storageState: '.playwright/auditor.json' });

  test('cannot reach tips or administration, by navigation or by URL', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Anonymous submissions' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);

    await page.goto('/tips');
    await expect(page.getByText(/404|not found|could not be found/i).first()).toBeVisible();

    await page.goto('/admin');
    await expect(page.getByText(/404|not found|could not be found/i).first()).toBeVisible();
  });
});

test.describe('cross-tenant access', () => {
  test.use({ storageState: '.playwright/other-tenant.json' });

  test('a different tenant cannot open a case by its id', async ({ page }) => {
    // Aurora sees only its own case.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'AT-2026-0088' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'RU-2026-0142' })).toHaveCount(0);

    // And a direct URL to a Redwood case is indistinguishable from a missing one.
    const redwoodCase = await page.request.get('/api/health');
    expect(redwoodCase.status()).toBe(200);

    await page.goto('/cases/does-not-exist-or-belongs-to-another-tenant');
    await expect(page.getByText(/404|not found|could not be found/i).first()).toBeVisible();
  });
});

test.describe('administrator', () => {
  test.use({ storageState: '.playwright/admin.json' });

  test('sees provider posture and which sources are real', async ({ page }) => {
    await page.goto('/admin');

    await expect(page.getByText('No API cost', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/deterministic mock provider is active/i)).toBeVisible();
    await expect(page.locator('.pill', { hasText: 'no API cost' }).first()).toBeVisible();

    await expect(page.locator('.pill', { hasText: 'live capable' }).first()).toBeVisible();
    await expect(page.locator('.pill', { hasText: 'fixture only' }).first()).toBeVisible();

    // No key material is rendered anywhere.
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(body).toContain('key material is never displayed or logged');
  });
});

test.describe('public tip intake', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sets expectations before accepting a submission', async ({ page }) => {
    await page.goto('/tips/new');

    await expect(page.getByText(/unverified allegation/i).first()).toBeVisible();
    await expect(page.getByText(/cannot change any assessment by itself/i)).toBeVisible();
    await expect(page.getByText(/out of scope/i).first()).toBeVisible();

    // Unique text per run so duplicate suppression — which is correct behaviour
    // and tested directly elsewhere — does not interfere here.
    await page
      .getByLabel('What is your concern?')
      .fill(
        `A concern submitted through the public form during an automated browser check, run ${Date.now()}-${Math.random()}.`,
      );
    await page.getByRole('button', { name: 'Submit confidentially' }).click();

    await expect(page.getByText(/recorded as an unverified allegation/i)).toBeVisible();
  });
});
