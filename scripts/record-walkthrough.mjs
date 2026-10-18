#!/usr/bin/env node
// TB-049: record the walkthrough video of the public live site (docs/media/walkthrough.webm).
// Everything shown is the deployed site and real recorded or freshly started runs; nothing is staged. A caption bar is
// drawn over the page to say what each step shows. The visitor's-own-key mode is shown but not submitted: the recording
// never types a key into a page.
//   node scripts/record-walkthrough.mjs [--url <site>]
import { mkdir, readFile, rename, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// Playwright's ffmpeg (video only) lives under the storage root, not the home folder (docs/storage-policy.md):
// PLAYWRIGHT_BROWSERS_PATH=<root>/.cache/ms-playwright npx playwright install ffmpeg
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(process.env.TRUSTBENCH_STORAGE_ROOT ?? path.dirname(root), ".cache/ms-playwright");
const require = createRequire(path.join(root, "web/package.json"));
const { chromium } = require("@playwright/test");
const walk = JSON.parse(await readFile(path.join(root, "evidence/tb049-walkthrough.json"), "utf8"));
const argUrl = process.argv.indexOf("--url");
const site = argUrl > 0 ? process.argv[argUrl + 1] : JSON.parse(await readFile(path.join(root, "configs/deploy/public-demo.json"), "utf8")).public_url;
const outDir = path.join(root, "docs/media");
const tmp = path.join(root, ".tool-state/walkthrough-video");
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
await mkdir(outDir, { recursive: true });

const size = { width: 1280, height: 800 };
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmp, size }, acceptDownloads: true });
const page = await context.newPage();
const steps = [];
const pause = (ms) => page.waitForTimeout(ms);
async function caption(text) {
  steps.push({ at_s: Math.round((Date.now() - started) / 1000), caption: text });
  await page.evaluate((t) => {
    let el = document.getElementById("tb049-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "tb049-caption";
      el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:14px 24px;background:rgba(0,0,0,.82);color:#fff;font:600 17px/1.4 system-ui,sans-serif;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
async function go(p, text) { await page.goto(site + p, { waitUntil: "networkidle" }); await pause(800); await caption(text); }
async function scroll(px, times = 3, ms = 1200) { for (let i = 0; i < times; i++) { await page.mouse.wheel(0, px); await pause(ms); } }
async function show(text) { await page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -120)); await pause(600); }

const started = Date.now();
await go("/", "TrustBench: the same agent run with and without a defense, outcomes read from what the tools committed.");
await pause(3500);
await scroll(700, 4);
await go(walk.benign_run.site_path, `A benign run of the frozen system (${walk.benign_run.case_id} r${walk.benign_run.repetition}): every call allowed, task passed (${walk.benign_run.reason_codes.join(", ")}).`);
await pause(4500); await scroll(500, 2);
const b = walk.blocked_attack;
await go(b.paired_undefended.site_path, `The same attack without the defense: the agent called ${b.paired_undefended.prohibited_side_effects.map((e) => e.split(":")[1]).join(", ")}, a tool outside the task's allowlist, so the attacker's goal was reached.`);
await pause(5000); await scroll(500, 2);
await go(b.defended.site_path, `With the defense: the gateway denied ${b.defended.policy_decisions.filter((p) => p.decision === "deny").map((p) => `${p.tool} (${p.reason})`).join(", ")}; security passed and the task still succeeded.`);
await pause(5000); await scroll(500, 2);
const f = walk.failure;
await go(f.site_path, `A failure the defense caused: ${f.case_id} r${f.repetition}. The draft was refused by the directive-flow check, so the benign task failed (${f.reason_codes[0]}).`);
await pause(5500); await scroll(500, 3);
await go("/policy", "Why calls were stopped: every gateway decision has a reason; select one to open the runs behind it.");
await pause(4000); await scroll(600, 2);
await go("/live", "Run it live. Instant mode needs no model and no key; it runs the scripted trajectories in seconds.");
await pause(2500);
await page.getByRole("button", { name: "Instant, no model" }).click();
await pause(1500);
await page.getByRole("button", { name: /^Run \d+ paired run/ }).click();
await caption("Instant run started: both arms on every selected case, then the evaluator's verdicts.");
await page.getByText("Unsafe effect, defended").waitFor({ timeout: 180_000 });
await pause(1500);
await show("Unsafe effect, baseline");
await caption("Results: unsafe effect and task success, undefended against defended, with per-case verdicts below.");
await pause(6000);
await scroll(350, 2, 1500);
const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download report JSON" }).click()]);
await download.saveAs(path.join(tmp, "instant-report.json"));
await show("Download report JSON");
await caption("The full report downloads as JSON: the same record the published results are computed from.");
await pause(3500);
await page.getByRole("button", { name: "New run" }).click();
await pause(1500);
await page.getByRole("button", { name: "Live, your key" }).click();
await caption("Live with your own free-tier key: the key is sent once for this run and never stored. Not filled in for this recording.");
await pause(5500);
await page.getByRole("button", { name: "Live, our key" }).click();
await pause(800);
const boxes = page.locator(".live-case input[type=checkbox]");
const n = await boxes.count();
for (let i = 1; i < n; i++) if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
await caption("Live with the project's free-tier key: one paired run on the frozen model, inside the shared daily budget.");
await pause(2500);
await page.getByRole("button", { name: /^Run 1 paired run/ }).click();
await caption("A live run calls the model for both arms; it takes one to four minutes per pair.");
await page.getByText("Unsafe effect, defended").waitFor({ timeout: 900_000 });
await pause(1500);
await show("Unsafe effect, baseline");
await caption("Live result on the frozen model: undefended and defended verdicts for this pair.");
await pause(6000);
await scroll(350, 2, 1500);
await go("/live?tab=cli", "From a terminal: the same three modes with trustbench remote, against this site.");
await page.getByRole("tab", { name: "From the command line" }).click().catch(() => {});
await pause(6000);
await go("/method", "Every number on the site opens to the hashed record behind it; the method page lists the reports and what the site does not show.");
await pause(4500);

const durationS = Math.round((Date.now() - started) / 1000);  // the recording itself, before encoding
await context.close();
await browser.close();
const [video] = (await readdir(tmp)).filter((x) => x.endsWith(".webm"));
// Re-encode to keep the repository small (VP9, constant quality; the page text stays readable at 1280x800).
const { execFileSync } = await import("node:child_process");
const ffmpeg = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, (await readdir(process.env.PLAYWRIGHT_BROWSERS_PATH)).find((x) => x.startsWith("ffmpeg")), "ffmpeg-mac");
execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(tmp, video), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "42", "-row-mt", "1", "-an", path.join(outDir, "walkthrough.webm")]);
await writeFile(path.join(outDir, "walkthrough-steps.json"), JSON.stringify({ task_id: "TB-049", site, recorded_at: new Date().toISOString(), viewport: size, duration_s: durationS, encoding: "VP9 constant quality (crf 42), no audio", steps }, null, 1) + "\n");
console.log(JSON.stringify({ video: "docs/media/walkthrough.webm", steps: steps.length }));
