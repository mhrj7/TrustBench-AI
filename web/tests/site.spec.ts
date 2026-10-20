import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

// The run store export the site reads; tests pick their subjects from it, never by typed IDs.
const store = JSON.parse(readFileSync(new URL('../public/data/store.json', import.meta.url), 'utf8'));
const runsTable = JSON.parse(readFileSync(new URL('../public/data/runs.json', import.meta.url), 'utf8'));
const runs = runsTable.rows.map((r: unknown[]) => Object.fromEntries(runsTable.fields.map((f: string, i: number) => [f, r[i]])));
const heroRun: string = store.hero_run;
const heroCase = runs.find((r: { run_id: string }) => r.run_id === heroRun).case_id;
const untimedRun = runs.find((r: { timed: boolean; utility_rule: string | null; invalid: boolean }) => !r.timed && r.utility_rule === 'call_denied_by_defense' && !r.invalid);
const untimed = runs.find((r: { timed: boolean; utility_rule: string | null; invalid: boolean }) => !r.timed && r.utility_rule === 'call_denied_by_defense' && !r.invalid)?.run_id;

const PAGES: [string, string, RegExp][] = [
  ['overview', '/', /Can a guard stop a tricked AI/],
  ['how', '/how', /How it works/],
  ['compare', '/compare', /Compare defenses/],
  ['runs', '/runs', /Every run in the store/],
  ['run-timed', `/runs/${encodeURIComponent(heroRun)}`, new RegExp(heroCase)],
  ['run-untimed', `/runs/${encodeURIComponent(untimed)}`, new RegExp(untimedRun.case_id)],
  ['policy', '/policy', /Why calls were stopped/],
  ['outcomes', '/outcomes', /How runs ended/],
  ['attribution', '/attribution', /audited round by round/],
  ['method', '/method', /The evidence index/],
];

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  return errors;
}

/** Scroll the page through once, so every on-view reveal and chart has played before measuring or capturing. */
async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.6)) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
}

for (const [name, path, heading] of PAGES) {
  test(`${name}: renders, no console errors, no horizontal overflow`, async ({ page }, info) => {
    const errors = watchConsole(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await scrollThrough(page);
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const offenders = [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).position === 'fixed') return false;
        let p = el.parentElement;
        while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; p = p.parentElement; }
        return r.right > w + 1 || r.left < -1;
      }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
      return { scroll: document.documentElement.scrollWidth - w, offenders };
    });
    expect(overflow.scroll, `page wider than viewport: ${overflow.offenders.join(', ')}`).toBeLessThanOrEqual(1);
    expect(overflow.offenders).toEqual([]);
    // Headings never exceed two lines (house rule), measured from the rendered line boxes.
    const tall = await page.evaluate(() => [...document.querySelectorAll('h1, h2')].map((h) => {
      const lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize);
      // offsetHeight is the laid-out height: scroll-driven transforms (the barrel tilt) do not inflate it.
      return { text: h.textContent?.slice(0, 40), lines: Math.round((h as HTMLElement).offsetHeight / lh) };
    }).filter((h) => h.lines > 2));
    expect(tall, 'headings over two lines').toEqual([]);
    // Body copy is at least 14px everywhere and 16px for paragraphs.
    const small = await page.evaluate(() => [...document.querySelectorAll('p.body, p.statement')].filter((p) => parseFloat(getComputedStyle(p).fontSize) < 16).length);
    expect(small).toBe(0);
    mkdirSync('screenshots', { recursive: true });
    await page.screenshot({ path: `screenshots/${info.project.name}-${name}.jpg`, fullPage: true, type: "jpeg", quality: 82 });
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('navigation: every nav link reaches its page', async ({ page }) => {
  await page.goto('/');
  for (const [label, heading] of [['Compare', /Compare defenses/], ['Runs', /Every run/], ['Policy', /Why calls/], ['Outcomes', /How runs ended/], ['Attribution', /audited/]] as const) {
    const toggle = page.getByRole('button', { name: 'Menu' });
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole('navigation', { name: /Main/ }).last().getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
});

test('evidence: a heatmap cell opens the runs behind it and a run opens its raw record', async ({ page }) => {
  await page.goto('/compare');
  const cell = page.getByRole('gridcell', { name: /Open the evidence/ }).first();
  await cell.scrollIntoViewIfNeeded();
  const label = await cell.getAttribute('aria-label');
  const [, k, n] = label!.match(/(\d+) of (\d+) runs/)!;
  await cell.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(`${k} of ${n} counted runs`);
  await drawer.getByRole('listitem').first().click();
  await expect(page.getByText(/Repetition \d+/)).toBeVisible();
  await expect(page.getByText('SHA-256', { exact: true })).toBeVisible();
  await expect(page.locator('pre.json')).toContainText('"source"');
});

test('drawer closes with Escape and the Close button', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('gridcell', { name: /Open the evidence/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('gridcell', { name: /Open the evidence/ }).first().click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('film: Flip it yourself opens the launch film; Escape closes it and returns focus', async ({ page }) => {
  await page.goto('/');
  const open = page.getByRole('button', { name: /Flip it yourself/ });
  await open.scrollIntoViewIfNeeded();
  await open.click();
  const film = page.getByRole('dialog', { name: 'TrustBench launch film' });
  await expect(film).toBeVisible();
  await expect(film.getByRole('button', { name: /^(Pause|Play)$/ })).toBeVisible();
  await expect(film.getByRole('button', { name: /^(Mute|Unmute)$/ })).toBeVisible();
  await expect(film.getByRole('slider', { name: 'Seek' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(film).toBeHidden();
  await expect(open).toBeFocused();
});

test('controls: filters and verdict live in the URL and change the view', async ({ page }) => {
  await page.goto('/compare');
  await page.getByRole('button', { name: 'Utility pass' }).click();
  await expect(page).toHaveURL(/metric=utility_pass/);
  await page.getByLabel('Columns').selectOption('none');
  await expect(page.locator('.ratebar').first()).toBeVisible();
  await page.goto('/runs');
  await page.getByLabel('Outcome').selectOption('timeout');
  await expect(page).toHaveURL(/outcome=timeout/);
  const count = runs.filter((r: { outcome: string; invalid: boolean }) => r.outcome === 'timeout' && !r.invalid).length;
  await expect(page.getByText(`${count.toLocaleString('en')} runs`, { exact: true })).toBeVisible();
});

test('buttons: replay, JSON depth and download work', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Replay the trace' }).click();
  await page.goto(`/runs/${encodeURIComponent(heroRun)}`);
  await page.getByRole('button', { name: 'Everything' }).click();
  await expect(page.locator('pre.json')).toContainText('tool_trace');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
});

test('links: every internal link resolves to a page with a heading', async ({ page }) => {
  await page.goto('/method');
  const hrefs = [...new Set(await page.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!)))];
  for (const href of hrefs) {
    await page.goto(href);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Nothing at this address/);
  }
});

test('keyboard: skip link and visible focus', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'no hardware keyboard');
  await page.goto('/');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.waitFor({ state: 'attached' }); // the app renders client-side: press Tab only once the link exists (slow CI runners)
  await page.bringToFront();
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
});

test('reduced motion: content is present without travel', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.morph-bars li').first()).toBeVisible();
  await ctx.close();
});

test('menu: on narrow screens it opens one list on an opaque sheet that fits the screen', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'the menu button only exists below the collapse breakpoint');
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  const visibleLists = await page.locator('header .nav-links').evaluateAll((ns) => ns.filter((n) => getComputedStyle(n).display !== 'none').length);
  expect(visibleLists).toBe(1); // the desktop list stays hidden: no duplicated links
  const sheet = await page.locator('header.nav').boundingBox();
  expect(sheet!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1); // fits the screen, scrolls inside if needed
  await expect(page.getByRole('button', { name: 'Close' })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mobile-nav')).toHaveCount(0);
});
