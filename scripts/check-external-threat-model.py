#!/usr/bin/env python3
"""TB-056 acceptance check for docs/external/threat-model.md and docs/external/integration-contract.md.

Every entry point in the inventory must be classified (trusted, untrusted, disabled, possibly qualified), name a control
and the TB-002 surfaces it maps to, and carry an evidence label; an entry point whose evidence is only planned must be
named in the uncovered table or name the task that tests it. Every TB-002 attack surface (AS-01..AS-16 in
docs/threat-model.md) must be mapped. The contract must keep its required sections. Writes
evidence/tb056-threat-model-check.json.
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
TRUST = re.compile(r"^(trusted|untrusted|disabled)\b")
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
        if len(r) != 7:
            problems.append(f"{r[0]}: expected 7 columns, got {len(r)}")
            continue
        eid, _, _, trust, control, surfaces, evidence = r
        if not TRUST.match(trust):
            problems.append(f"{eid}: trust must be trusted, untrusted or disabled, got {trust!r}")
        if len(control) < 10:
            problems.append(f"{eid}: no control named")
        found = re.findall(r"AS-\d\d", surfaces)
        if not found:
            problems.append(f"{eid}: no TB-002 surface mapped")
        mapped.update(found)
        if not re.search(r"observed|documented|planned|design", evidence):
            problems.append(f"{eid}: evidence must say observed, documented, planned or design")
        if evidence.startswith("planned") and not (eid in uncovered_text or re.search(r"TB-0\d\d", evidence)):
            problems.append(f"{eid}: planned only, but neither listed as uncovered nor assigned to a task")
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
    if pinned["agents_md_marker_in_prompt"] or pinned["goosehints_marker_in_prompt"] or pinned["model_requests_per_turn"] != 1:
        problems.append("observations: the pinned invocation does not hold (context files reached the prompt or extra requests)")
    result = {
        "task_id": "TB-056", "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entry_points": len(inventory),
        "by_trust": {k: sum(r[3].startswith(k) for r in inventory if len(r) == 7) for k in ("trusted", "untrusted", "disabled")},
        "planned_evidence": [r[0] for r in inventory if len(r) == 7 and r[6].startswith("planned")],
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
