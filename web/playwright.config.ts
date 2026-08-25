import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const testDbPath = path.join(os.tmpdir(), `frameflow-playwright-${process.pid}-${Date.now()}.db`);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8791',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python -m uvicorn server:app --host 127.0.0.1 --port 8791 --log-level warning',
    cwd: repoRoot,
    url: 'http://127.0.0.1:8791/api/health',
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      FRAMEFLOW_DB_PATH: testDbPath,
      JIMENG_CLI_HOME: path.join(os.tmpdir(), `frameflow-playwright-home-${process.pid}`),
    },
  },
});
