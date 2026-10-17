#!/usr/bin/env python3
"""TB-043: build research/related-work.csv from research/related-work-rows.py and check the acceptance criterion: every
comparison has a source and a specific limitation. Also checks that limitation bases are valid (a later-work basis must name an
existing row), evidence paths exist, and every number quoted in trustbench_measurement appears verbatim in its evidence file.

  build-related-work.py           write the CSV (exit 1, writing nothing, if any check fails)
  build-related-work.py --check   check only"""
import csv, io, re, runpy, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = runpy.run_path(str(ROOT / 'research/related-work-rows.py'))
ROWS, CHECKED_ON = SRC['ROWS'], SRC['CHECKED_ON']
OUT = ROOT / 'research/related-work.csv'
FIELDS = ['id', 'system', 'kind', 'authors', 'year', 'venue', 'source_url', 'checked_on', 'threat_model', 'enforcement_boundary', 'evaluation_suite',
          'claimed_guarantee', 'guarantee_type', 'reported_result', 'specific_limitation', 'limitation_basis', 'trustbench_relation',
          'trustbench_measurement', 'trustbench_evidence']
REQUIRED = ['id', 'system', 'kind', 'authors', 'year', 'venue', 'source_url', 'threat_model', 'enforcement_boundary', 'evaluation_suite', 'claimed_guarantee',
            'specific_limitation', 'limitation_basis', 'trustbench_relation']
SOURCE_HOSTS = ('https://arxiv.org/abs/', 'https://github.com/')
BASES = ('stated_by_authors', 'trustbench_measurement', 'our_analysis')


def problems() -> list[str]:
    out, ids = [], [r['id'] for r in ROWS]
    if len(set(ids)) != len(ids):
        out.append('duplicate row ids')
    for r in ROWS:
        rid = r.get('id', '?')
        for f in REQUIRED:
            if not str(r.get(f, '')).strip():
                out.append(f'{rid}: missing {f}')
        if not str(r.get('source_url', '')).startswith(SOURCE_HOSTS):
            out.append(f'{rid}: source is not a primary listing ({r.get("source_url")})')
        if len(str(r.get('specific_limitation', ''))) < 40:
            out.append(f'{rid}: limitation is not specific')
        basis = str(r.get('limitation_basis', ''))
        if basis.startswith('reported_by_later_work:'):
            ref = basis.split(':', 1)[1]
            if ref not in ids or ref == rid:
                out.append(f'{rid}: limitation basis names an unknown row {ref}')
        elif basis not in BASES:
            out.append(f'{rid}: invalid limitation basis {basis}')
        ev = str(r.get('trustbench_evidence', ''))
        if ev and not (ROOT / ev).exists():
            out.append(f'{rid}: evidence path missing: {ev}')
        m = str(r.get('trustbench_measurement', ''))
        if basis == 'trustbench_measurement' and not m:
            out.append(f'{rid}: measurement basis without a quoted measurement')
        if m:
            text = (ROOT / ev).read_text() if ev and (ROOT / ev).exists() else ''
            lines = text.splitlines()
            # quoted statistics must appear verbatim: rates with Wilson intervals, percentage-point differences, intervals
            groups = re.findall(r'\d+/\d+ \(\d+%; \d+%–\d+%\)|[-+]?\d+\.\d pp|\[[-+]?\d+\.\d, [-+]?\d+\.\d\]', m)
            if not groups:
                out.append(f'{rid}: measurement quotes no checkable statistic')
            system = m.split()[0]
            table_key = any(l.startswith(f'| {system} |') for l in lines)
            for g in groups:
                hits = [l for l in lines if g in l]
                if not hits:
                    out.append(f'{rid}: quoted statistic {g} not found in {ev}')
                elif table_key and g.count('/') and not any(l.startswith(f'| {system} |') or l.startswith(f'| {system.split()[0]} ') or 'baseline (pooled' in l for l in hits):
                    out.append(f'{rid}: {g} is not on the {system} row of {ev}')
    return out


def main():
    found = problems()
    for p in found:
        print('PROBLEM', p)
    if found:
        sys.exit(1)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=FIELDS, lineterminator='\n')
    w.writeheader()
    for r in ROWS:
        w.writerow({**{f: r.get(f, '') for f in FIELDS}, 'checked_on': CHECKED_ON})
    if '--check' in sys.argv:
        if not OUT.exists() or OUT.read_text() != buf.getvalue():
            print('research/related-work.csv is out of date: run scripts/build-related-work.py'); sys.exit(1)
    else:
        OUT.write_text(buf.getvalue())
    kinds = {}
    for r in ROWS:
        kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
    print({'rows': len(ROWS), 'kinds': kinds, 'sources_checked_on': CHECKED_ON, 'problems': 0})


if __name__ == '__main__':
    main()
