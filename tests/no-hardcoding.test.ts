import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Guard for the project rule "never hardcode": runtime code must take fixture identifiers, provider endpoints, key
 * names, model identifiers and seeds from registered config/data files. Tests and verification scripts may name the
 * fixtures they exercise. Frozen artifacts are listed explicitly with the reason they cannot change.
 */
const root = path.resolve(import.meta.dirname, "..");
const scanned = ["src", "runtime", "agent", "app", "scripts/run-arm-smoke.mjs", "scripts/run-live-matrix.mjs", "scripts/summarize-live-results.mjs"];
const exempt = new Map([
  ["src/evaluators/outcomes.py", "frozen tb016.1.0.0 evaluator; its hash is pinned by the TB-017 pilot manifest"],
  ["src/tools/tests", "test inputs"],
  ["agent/agent.ts", "eve pilot agent definition; hash pinned by the TB-017 pilot manifest and its model is preserved per AGENTS.md"],
  ["src/policy/README.md", "documentation"], ["src/gateway/README.md", "documentation"], ["src/tools/README.md", "documentation"], ["src/arms/README.md", "documentation"],
]);
const forbidden: Array<[string, RegExp]> = [
  ["fixture or attack identifier", /TB-(ATT|BEN)-[A-Z]+-\d+/],
  ["synthetic resource identifier", /\b(contact|customer|approval|draft|note)-[a-z]+-[a-z0-9-]*\d/],
  ["hosted provider endpoint", /https?:\/\/[a-z.]*(googleapis|nvidia|openai)\./],
  ["API key variable name", /\b(GEMINI|NVIDIA|OPENAI)_API_KEY\b/],
  ["model identifier", /\b(gpt-oss|qwen3|llama3|gemini-\d|gpt-\d)/],
  ["registered seed", /\b20261014\b/],
];

async function files(entry: string): Promise<string[]> {
  const full = path.join(root, entry);
  const stat = await import("node:fs/promises").then((fs) => fs.stat(full));
  if (stat.isFile()) return [entry];
  const out: string[] = [];
  for (const name of await readdir(full)) {
    if (name === "__pycache__" || name === "node_modules") continue;
    out.push(...(await files(path.join(entry, name))));
  }
  return out;
}

test("runtime code contains no hardcoded fixtures, endpoints, keys, models or seeds", async () => {
  const violations: string[] = [];
  for (const entry of scanned) {
    for (const file of await files(entry)) {
      if ([...exempt.keys()].some((e) => file === e || file.startsWith(e + "/"))) continue;
      if (!/\.(ts|mjs|py)$/.test(file)) continue;
      const lines = (await readFile(path.join(root, file), "utf8")).split("\n");
      lines.forEach((line, i) => { for (const [what, re] of forbidden) if (re.test(line)) violations.push(`${file}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`); });
    }
  }
  assert.deepEqual(violations, [], `hardcoded values found:\n${violations.join("\n")}`);
});
