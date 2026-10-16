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
  webServer: { command: 'npm run build && npm run preview', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 180_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chrome, viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...chrome, viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: false } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...chrome } },
  ],
});
