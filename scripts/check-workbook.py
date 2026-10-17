#!/usr/bin/env python3
"""Completion-gate check 6 (AGENTS.md): the saved planning workbook reopens with computed formulas and no evidence gap.

Fails when a formula cell has no cached value (the file was saved by a tool that does not calculate, such as openpyxl;
recalculate it in Excel), when a cached value is a spreadsheet error, or when a Completed row has no evidence paths or
lists a path that does not exist on disk.
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "planning" / "TrustBench-AI_Plan.xlsx"
ERRORS = ("#REF!", "#VALUE!", "#NAME?", "#DIV/0!", "#N/A", "#NUM!", "#NULL!")
ID_COL, STATUS_COL, EVIDENCE_COL = 1, 4, 19  # A, D, S


def resolve(path: str) -> Path:
    """Evidence paths are recorded relative to the repository or as absolute paths of the original checkout; both are
    checked inside this checkout, so the check works in any clone (CI included)."""
    marker = f"/{ROOT.name}/"
    if path.startswith("/") and marker in path:
        return ROOT / path.split(marker, 1)[1]
    return Path(path) if path.startswith("/") else ROOT / path


def main() -> int:
    formulas = openpyxl.load_workbook(WORKBOOK)
    values = openpyxl.load_workbook(WORKBOOK, data_only=True)
    problems: list[str] = []
    formula_cells = 0
    # openpyxl reports both "no cached value" and an empty-string result as None, so the cached value is read from the sheet XML.
    computed: dict[str, set[str]] = {}
    with zipfile.ZipFile(WORKBOOK) as z:
        for ws, part in zip(formulas.worksheets, sorted((n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=lambda n: int(re.findall(r"\d+", n)[-1]))):
            ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            cells = ET.fromstring(z.read(part)).iterfind(".//m:sheetData/m:row/m:c", ns)
            # Computed = a non-empty <v>, or a typed result (t="str", "b", "e"), which is how Excel stores an empty-string
            # result. openpyxl writes an untyped empty <v/> for every formula, which is not a computed value.
            computed[ws.title] = {c.get("r") for c in cells if (v := c.find("m:v", ns)) is not None and ((v.text or "") != "" or c.get("t") in ("str", "b", "e"))}
    for ws in formulas:
        cached = values[ws.title]
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    formula_cells += 1
                    value = cached[cell.coordinate].value
                    if cell.coordinate not in computed[ws.title]:
                        problems.append(f"{ws.title}!{cell.coordinate}: formula has no cached value (recalculate in Excel)")
                    elif isinstance(value, str) and value in ERRORS:
                        problems.append(f"{ws.title}!{cell.coordinate}: {value}")
        for r in range(1, ws.max_row + 1):
            task, status = ws.cell(r, ID_COL).value, ws.cell(r, STATUS_COL).value
            if not (isinstance(task, str) and task.startswith("TB-")) or status != "Completed":
                continue
            evidence = [p.strip() for p in str(ws.cell(r, EVIDENCE_COL).value or "").split(";") if p.strip()]
            if not evidence:
                problems.append(f"{task}: Completed without evidence paths")
            for p in evidence:
                if not resolve(p).exists():
                    problems.append(f"{task}: evidence path missing on disk: {p}")
    print(f"{WORKBOOK.name}: {formula_cells} formula cells checked, {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
