import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4517);

// Runs the real app against a test mint whose Lightning invoices pay themselves.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, browserName: 'chromium' },
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: 'tablet', use: { viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_MINT_URL: process.env.BEEPOS_TEST_MINT ?? 'https://testnut.cashu.space' },
  },
});
