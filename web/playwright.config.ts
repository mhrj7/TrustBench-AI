import { defineConfig, devices } from '@playwright/test';

// Uses the installed Google Chrome (channel: 'chrome'), so no browser download is needed.
const chrome = { channel: 'chrome' as const };
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off', ...chrome },
  // The Live and Account pages need the live-test service: the tests start their own, with a fresh data directory, on a port
  // of their own, so they never depend on (or disturb) a service someone left running.
  webServer: [
    { command: 'cd .. && TRUSTBENCH_SERVICE_DATA="$(mktemp -d)" TRUSTBENCH_NO_DOTENV=1 .venv-tools/bin/python -m uvicorn src.service.app:app --host 127.0.0.1 --port 8099',
      url: 'http://127.0.0.1:8099/api/health', reuseExistingServer: false, timeout: 120_000 },
    { command: 'npm run build && npm run preview', url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 180_000,
      env: { TRUSTBENCH_API_PROXY: 'http://127.0.0.1:8099' } },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chrome, viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...chrome, viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: false } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...chrome } },
  ],
});
