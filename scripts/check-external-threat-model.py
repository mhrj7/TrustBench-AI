#!/usr/bin/env python3
"""TB-056 acceptance check for docs/external/threat-model.md and docs/external/integration-contract.md.

Every entry point in the inventory must be classified trusted or untrusted (the TB-056 acceptance wording), state whether it
is active or disabled, name a control and the TB-002 surfaces it maps to, and carry an evidence label; an entry point whose
evidence is only planned must be named in the uncovered table or name the task that tests it. The inventory must cover the
channels the TB-056 steps name (prompts, tool outputs, memory, plugins). Every TB-002 attack surface (AS-01..AS-16) must be
mapped and every TB-002 boundary rule reviewed. The contract must keep its required sections, and the observed facts it
relies on must hold. Writes evidence/tb056-threat-model-check.json.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TM = ROOT / "docs" / "external" / "threat-model.md"
CONTRACT = ROOT / "docs" / "external" / "integration-contract.md"
CORE = ROOT / "docs" / "threat-model.md"
OBS = ROOT / "evidence" / "tb056-goose-observations" / "observations.json"
OUT = ROOT / "evidence" / "tb056-threat-model-check.json"
TRUST = re.compile(r"^(trusted|untrusted)$")
STEP_CHANNELS = {"prompts": r"prompt", "tool outputs": r"tool results?", "memory": r"memory", "plugins": r"plugin"}
CONTRACT_SECTIONS = ["## Process model", "## goose invocation", "## Tool surface", "## Calls and results", "## Trace (TB-004)",
                     "## Limits", "## Acceptance tests"]


def table_rows(text: str, heading: str) -> list[list[str]]:
    part = text.split(heading, 1)[1].split("\n## ", 1)[0]
    rows = [[c.strip() for c in l.strip().strip("|").split("|")] for l in part.splitlines() if l.startswith("|")]
    return [r for r in rows[2:] if r and r[0]]


def main() -> int:
    tm, contract, core = TM.read_text(), CONTRACT.read_text(), CORE.read_text()
    problems: list[str] = []
    core_surfaces = sorted(set(re.findall(r"\| (AS-\d\d) \|", core)))
    inventory = table_rows(tm, "## Entry-point inventory")
    uncovered = table_rows(tm, "## Uncovered and out of scope")
    uncovered_text = " ".join(" ".join(r) for r in uncovered)
    mapped: set[str] = set()
    for r in inventory:
        if len(r) != 8:
            problems.append(f"{r[0]}: expected 8 columns, got {len(r)}")
            continue
        eid, _, _, trust, state, control, surfaces, evidence = r
        if not TRUST.match(trust):
            problems.append(f"{eid}: trust must be exactly trusted or untrusted, got {trust!r}")
        if not re.match(r"^(active|disabled)", state):
            problems.append(f"{eid}: state must say active or disabled, got {state!r}")
        if len(control) < 10:
            problems.append(f"{eid}: no control named")
        found = re.findall(r"AS-\d\d", surfaces)
        if not found:
            problems.append(f"{eid}: no TB-002 surface mapped")
        mapped.update(found)
        if not re.search(r"observed|documented|planned|design|tested", evidence):
            problems.append(f"{eid}: evidence must say observed, tested, documented, planned or design")
        if evidence.startswith("planned") and not (eid in uncovered_text or re.search(r"TB-0\d\d", evidence)):
            problems.append(f"{eid}: planned only, but neither listed as uncovered nor assigned to a task")
    inv_text = " ".join(" ".join(r) for r in inventory).lower()
    for name, rx in STEP_CHANNELS.items():
        if not re.search(rx, inv_text):
            problems.append(f"inventory does not cover {name} (named in the TB-056 steps)")
    core_boundaries = [r[0] for r in table_rows(core, "## Trust boundaries and enforcement points")]
    reviewed = [r[0] for r in table_rows(tm, "## Review against TB-002 boundaries")]
    for b in core_boundaries:
        if b not in reviewed:
            problems.append(f"TB-002 boundary not reviewed: {b}")
    surface_table = table_rows(tm, "## TB-002 surfaces covered")
    mapped.update(r[0].split()[0] for r in surface_table if r[0].startswith("AS-") and len(r) > 1 and r[1])
    missing = [s for s in core_surfaces if s not in mapped]
    if missing:
        problems.append(f"TB-002 surfaces not mapped: {', '.join(missing)}")
    if not uncovered:
        problems.append("no uncovered / out-of-scope table")
    for s in CONTRACT_SECTIONS:
        if s not in contract:
            problems.append(f"contract: missing section {s!r}")
    obs = json.loads(OBS.read_text())
    pinned = obs["runs"]["pinned"]
    cc = obs.get("contract_checks", {})
    if not any(t.startswith("trustbench__") for t in cc.get("stdio_command_named_trustbench", {}).get("tools_sent_to_model", [])):
        problems.append("observations: the stdio command named trustbench did not give trustbench__ tool names")
    if pinned["agents_md_marker_in_prompt"] or pinned["goosehints_marker_in_prompt"] or pinned["model_requests_per_turn"] != 1:
        problems.append("observations: the pinned invocation does not hold (context files reached the prompt or extra requests)")
    result = {
        "task_id": "TB-056", "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entry_points": len(inventory),
        "by_trust": {k: sum(r[3] == k for r in inventory if len(r) == 8) for k in ("trusted", "untrusted")},
        "disabled": [r[0] for r in inventory if len(r) == 8 and r[4].startswith("disabled")],
        "planned_evidence": [r[0] for r in inventory if len(r) == 8 and r[7].startswith("planned")],
        "tb002_boundaries_reviewed": f"{len([b for b in core_boundaries if b in reviewed])}/{len(core_boundaries)}",
        "tb002_surfaces": len(core_surfaces), "tb002_surfaces_mapped": len([s for s in core_surfaces if s in mapped]),
        "uncovered_items": len(uncovered), "pinned_tools_sent_to_model": pinned["tools_sent_to_model"],
        "problems": problems, "ok": not problems,
    }
    OUT.write_text(json.dumps(result, indent=1) + "\n")
    print(f"{len(inventory)} entry points; TB-002 surfaces mapped {result['tb002_surfaces_mapped']}/{len(core_surfaces)}; "
          f"{len(uncovered)} uncovered items; {len(problems)} problem(s)")
    for p in problems:
        print("  -", p)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
