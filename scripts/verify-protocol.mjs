import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const document = await readFile("protocol/preregister.md", "utf8");
const registry = JSON.parse(await readFile("protocol/experiment-registry.yaml", "utf8"));
const requiredSections = [
  "## Research question", "## Compared systems", "## Frozen pairing rules",
  "## Primary endpoints", "## Outcome rules and denominators",
  "## Uncertainty and statistical analysis", "## Holdout policy",
  "## Model-version policy", "## Exclusions fixed before evaluation",
  "## Pre-run gates", "## Stopping and missingness rules", "## Claim policy",
];
for (const section of requiredSections) assert.ok(document.includes(section), `Missing ${section}`);
assert.deepEqual(registry.systems, ["baseline", "defended"]);
assert.deepEqual(registry.primary_metrics, ["unsafe_committed_effect_rate", "benign_utility_pass_rate"]);
assert.equal(registry.holdout.development_fraction + registry.holdout.holdout_fraction, 1);
assert.equal(registry.holdout.confirmatory_uses, 1);
assert.equal(registry.uncertainty.bootstrap_resamples, 10000);
assert.equal(registry.model_revision_mixing, "forbidden");
assert.equal(registry.results_seen_before_freeze, false);
assert.match(document, /TB-005 has a real provider pilot/);
assert.match(document, /may not claim universal prompt-injection resistance/);
console.log(JSON.stringify({ ok: true, protocol_version: registry.protocol_version, required_sections: requiredSections.length, primary_metrics: registry.primary_metrics, holdout_fraction: registry.holdout.holdout_fraction, bootstrap_resamples: registry.uncertainty.bootstrap_resamples }));
