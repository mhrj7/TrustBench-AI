import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The catalog comes from the real service configuration (src/service/app.py), not a hand-written fixture; the run result is
// the committed scripted arm report, so the page is tested against the shapes the service really returns.
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = JSON.parse(execFileSync(`${root}.venv-tools/bin/python`, ['-c', 'import json; from src.service.app import Service; import tempfile; print(json.dumps(Service(data_dir=tempfile.mkdtemp(), start_workers=False).catalog()))'],
  { cwd: root, env: { ...process.env, TRUSTBENCH_SERVICE_NO_AUTOSTART: '1' } }).toString());
const report = JSON.parse(readFileSync(`${root}reports/tests/tb024-scripted-as_authored-plain-gateway_capability-report.json`, 'utf8'));
const s = report.summary;
const job = (status: string, extra = {}) => ({ id: 'testrun0001', status, mode: 'scripted', system: 'gateway_capability', rendering: 'as_authored', model: null, cases: report.cases.map((c: any) => c.case_id),
  repetitions: 1, pairs: report.cases.length, key_source: null, created_at: '', started_at: '', finished_at: '', progress: { done: report.cases.length, total: report.cases.length }, error: null, ...extra });

async function mockService(page: Page) {
  let polls = 0;
  let posted: any = null;
  await page.route('**/api/catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/runs', async (r) => { posted = r.request().postDataJSON(); await r.fulfill({ status: 202, json: job('queued', { queue_position: 1 }) }); });
  await page.route('**/api/runs/testrun0001', (r) => r.fulfill({ json: ++polls < 2 ? job('running', { progress: { done: 3, total: report.cases.length } }) : job('done', { summary: {
    valid_pairs: s.validity.valid_pairs, invalid_pairs: s.validity.invalid_pairs, invalid_reasons: [], unsafe_committed_effect: s.unsafe_committed_effect,
    benign_utility_pass: s.benign_utility_pass, attacker_goal_achieved: s.attacker_goal_achieved, observed_response_models: null } }) }));
  await page.route('**/api/runs/testrun0001/report', (r) => r.fulfill({ json: report }));
  return () => posted;
}

test('live page: every mode, a scripted run from form to results, and no overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const posted = await mockService(page);
  await page.goto('/live');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Run TrustBench live');
  for (const label of ['Live, our key', 'Live, your key', 'Instant, no model']) await expect(page.getByRole('button', { name: label })).toBeVisible();
  await page.getByRole('button', { name: 'Live, your key' }).click();
  await expect(page.getByPlaceholder('used for this run only, never stored')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Instant, no model' }).click();
  await expect(page.getByPlaceholder('used for this run only, never stored')).toHaveCount(0);
  await page.getByRole('button', { name: /^Run \d+ paired run/ }).click();
  await expect(page).toHaveURL(/run=testrun0001/);
  await expect(page.getByText('Unsafe effect, defended')).toBeVisible();
  await expect(page.getByRole('cell', { name: report.cases[0].case_id + ' r1' })).toBeVisible();
  expect(posted().mode).toBe('scripted');
  expect(posted().api_key).toBeUndefined();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('live page: the command-line tab gives runnable commands for this site', async ({ page }) => {
  await mockService(page);
  await page.goto('/live');
  await page.getByRole('tab', { name: 'From the command line' }).click();
  const text = await page.locator('main').innerText();
  expect(text).toContain('bin/trustbench remote run --url');
  const keyEnv = catalog.modes.own_key.models.find((m: any) => m.id === catalog.frozen.model).key_env;
  expect(text).toContain(`--key-env ${keyEnv}`);
  expect(text).toContain(catalog.frozen.system);
});

test('live page: without a reachable service it says so and points to the published results', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (r) => r.abort());
  await page.goto('/live');
  await expect(page.getByRole('status')).toContainText('not reachable');
  await expect(page.getByRole('link', { name: 'the overview' })).toBeVisible();
  expect(errors).toEqual([]);
});
