import { defineConfig, devices } from '@playwright/test';

/**
 * Browser verification against a built app with seeded demonstration data.
 *
 * Runs serially: the specs share one database and one seeded dataset, and the
 * portal spec mints a token against a seeded clarification request.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 45_000,
  reporter: process.env['CI'] ? [['html'], ['list']] : [['list']],

  use: {
    baseURL: process.env['APP_BASE_URL'] ?? 'http://localhost:3200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Some environments ship a preinstalled Chromium whose build number differs
    // from the one this Playwright version downloads. Point at it explicitly
    // rather than fetching another copy. Unset in CI, which installs its own.
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_PATH']
      ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] }
      : {},
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: undefined }, dependencies: ['setup'] },
    // The interface is required to work on tablets as well as desktops.
    // Chromium at a tablet viewport rather than the iPad descriptor, which
    // implies WebKit — this keeps the suite runnable wherever only Chromium is
    // available, at the cost of not exercising Safari specifically.
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
      },
      dependencies: ['setup'],
    },
  ],

  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3200/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
