// TB-041: the browser path of a deployment, as a reviewer uses it: an instant run and a live run on the project key from the
// Live page, in the installed Chrome; each run's report download, and the own-key form (shown, not filled). Usage: node scripts/check-deployment-gui.mjs <url> <out-dir> [relay-ip]
// (relay-ip pins the host's DNS, for checking a Funnel URL over its public route from the machine that serves it).
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../web/package.json', import.meta.url))('playwright');
const [url, outDir, relay] = process.argv.slice(2);
const host = new URL(url).hostname;
const browser = await chromium.launch({ channel: 'chrome', args: relay ? [`--host-resolver-rules=MAP ${host} ${relay}`] : [] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const result = {};
async function run(mode, label, pairsText) {
  await page.goto(`${url}/live`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: label, exact: true }).click();
  // keep only the first two cases selected (one benign, one attack) for a small run
  const boxes = page.locator('input[type=checkbox]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) { const want = i < 2; if ((await boxes.nth(i).isChecked()) !== want) await boxes.nth(i).click(); }
  const t = Date.now();
  await page.getByRole('button', { name: /^Run \d+ paired runs?$/ }).click();
  await page.getByText(/^Done ·/).waitFor({ timeout: 900_000 });
  const text = await page.locator('main').innerText();
  result[mode] = { seconds: Math.round((Date.now() - t) / 1000), header: text.split('\n').find((l) => l.startsWith('Done ·')),
                   valid: /Valid pairs\s*\n\s*(\d+)/.exec(text)?.[1], invalid: /(\d+) invalid/.exec(text)?.[1] };
  // TB-051: the visitor's report download works and is the run's full record
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report JSON' }).click()]);
  const report = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  result[mode].report_download = { cases: report.cases?.length ?? 0, has_summary: Boolean(report.summary) };
  await page.screenshot({ path: `${outDir}/public-gui-${mode}.png`, fullPage: false });
}
// the own-key form is offered (a password field), never filled by this check
await page.goto(`${url}/live`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Live, your key', exact: true }).click();
result.own_key_form = { password_field: (await page.getByPlaceholder('used for this run only, never stored').getAttribute('type')) === 'password',
                        run_disabled_without_key: await page.getByRole('button', { name: /^Run \d+ paired runs?$/ }).isDisabled() };
await run('instant', 'Instant, no model');
await run('live_project_key', 'Live, our key');
await browser.close();
const runs = ['instant', 'live_project_key'].map((m) => result[m]);
const ok = runs.every((r) => Number(r.valid) > 0 && r.report_download.cases > 0 && r.report_download.has_summary)
  && result.own_key_form.password_field && result.own_key_form.run_disabled_without_key;
console.log(JSON.stringify({ url, vantage: process.env.TRUSTBENCH_CHECK_VANTAGE ?? 'unspecified', ok, runs: result }));
process.exit(ok ? 0 : 1);
