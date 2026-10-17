// TB-041: the browser path of a deployment, as a reviewer uses it: an instant run and a live run on the project key from the
// Live page, in the installed Chrome. Usage: node scripts/check-deployment-gui.mjs <url> <out-dir> [relay-ip]
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
  await page.screenshot({ path: `${outDir}/public-gui-${mode}.png`, fullPage: false });
}
await run('instant', 'Instant, no model');
await run('live_project_key', 'Live, our key');
await browser.close();
const ok = Object.values(result).every((r) => Number(r.valid) > 0);
console.log(JSON.stringify({ url, vantage: process.env.TRUSTBENCH_CHECK_VANTAGE ?? 'unspecified', ok, runs: result }));
process.exit(ok ? 0 : 1);
