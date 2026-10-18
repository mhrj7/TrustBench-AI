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
  await page.route('**/api/session', (r) => r.fulfill({ status: 201, json: { token: 'guest-session-token-for-tests', expires_at: '' } }));
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { kind: 'guest', retention_hours: 24 } }));
  await page.route('**/api/runs', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: [] });
    expect(r.request().headers().authorization).toBe('Bearer guest-session-token-for-tests');  // every run request carries the session
    posted = r.request().postDataJSON(); await r.fulfill({ status: 202, json: job('queued', { queue_position: 1 }) });
  });
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
  // TB-050: the HTTP example must create a session first (runs need one), and the local path needs the storage root.
  expect(text).toContain('/api/session');
  expect(text).toContain('authorization: Bearer $TOKEN');
  expect(text).toContain('export TRUSTBENCH_STORAGE_ROOT=');
  expect(text).toContain('sh scripts/setup-python.sh');
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


test('account page: a guest sees sign-in, sign-up and reset; the sign-up answer is the same generic message', async ({ page }) => {
  await page.route('**/api/catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/session', (r) => r.fulfill({ status: 201, json: { token: 'guest-session-token-for-tests', expires_at: '' } }));
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { kind: 'guest', retention_hours: 24 } }));
  await page.route('**/api/auth/signup', (r) => r.fulfill({ status: 201, json: { message: catalog.auth ? 'If this address can be registered, a verification link has been sent to it.' : '' } }));
  await page.goto('/account');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in or create an account');
  for (const tab of ['Sign in', 'Create account', 'Forgot password']) await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill('someone@example.invalid');
  await page.getByLabel(/Password/).fill('a long enough passphrase 1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('verification link');
  await expect(page.getByLabel(/Password/)).toHaveValue('');  // the password does not linger in the form
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('account page: a signed-in user sees their runs, password change and account deletion', async ({ page }) => {
  await page.route('**/api/catalog', (r) => r.fulfill({ json: catalog }));
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { kind: 'account', email: 'alice@example.invalid', verified: true, retention_days: 30, quota_multiplier: 3 } }));
  await page.route('**/api/runs', (r) => r.fulfill({ json: [job('done')] }));
  await page.addInitScript(() => localStorage.setItem('trustbench.session', 'account-session-token-for-tests'));
  await page.goto('/account');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your account');
  await expect(page.getByText('alice@example.invalid')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/live?run=testrun0001');
  for (const b of ['Change password', 'Sign out', 'Delete my account']) await expect(page.getByRole('button', { name: b })).toBeVisible();
});
