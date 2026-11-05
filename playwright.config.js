import { defineConfig } from '@playwright/test';

// E2E_PORT lets two checkouts run their tests at once; each must use its own port, because a running
// server on the port is reused and would otherwise serve the other checkout's code.
const port = Number(process.env.E2E_PORT) || 4173;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node tests/static-server.mjs',
    port,
    env: { PORT: String(port) },
    reuseExistingServer: true
  }
});
