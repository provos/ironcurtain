import { defineConfig, devices } from '@playwright/test';

const webUiPort = parseInt(process.env.WEB_UI_PORT ?? '5173', 10);
const mockWsPort = parseInt(process.env.MOCK_WS_PORT ?? '7400', 10);
const mockResetPort = parseInt(process.env.MOCK_RESET_PORT ?? '7401', 10);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  outputDir: 'e2e-results',
  use: {
    baseURL: `http://localhost:${webUiPort}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `PORT=${mockWsPort} RESET_PORT=${mockResetPort} npx tsx scripts/mock-ws-server.ts`,
      port: mockWsPort,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite dev',
      port: webUiPort,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
