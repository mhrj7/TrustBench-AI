#!/usr/bin/env python3
"""TB-059: map every development fixture to the external agent, from the saved runs.

Reads tests/external/fixtures/dev-suite.json and three reports produced by scripts/run-arm-smoke.mjs on that suite:
the scripted run through goose and through the built-in agent (evidence/tb059-scripted/<agent>/report.json) and the live
run through goose (evidence/tb059-goose-live/report.json). For each development fixture it records whether it ran end to
end through goose with the unchanged evaluators (scripted: same verdicts as the built-in agent), what the live pairs did,
and, if it could not run, why. Fails if any report loaded a sealed fixture. Writes evidence/tb059-task-mapping.json.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARMS = ('baseline', 'defended')


def load(p):
    return json.loads((ROOT / p).read_text())


def verdict(case, arm):
    a = case[arm]
    e = a.get('evaluation') or {}
    return [a['outcome'], e.get('utility_pass'), e.get('security_pass'), e.get('attacker_goal_achieved'), sorted(e.get('reason_codes') or []), a.get('tool_calls')]


def fixtures_of(case):
    return [x for x in (case['fixture_id'].split('--')[0], case.get('attack_id')) if x]


def main() -> int:
    suite = load('tests/external/fixtures/dev-suite.json')
    goose = load('evidence/tb059-scripted/goose/report.json')
    builtin = load('evidence/tb059-scripted/trustbench/report.json')
    live = load('evidence/tb059-goose-live/report.json')
    retry_path = ROOT / 'evidence/tb059-goose-live-retry/report.json'
    retry = load('evidence/tb059-goose-live-retry/report.json') if retry_path.exists() else None
    problems = []
    for name, r in (('scripted goose', goose), ('scripted built-in', builtin), ('live goose', live), *((('live goose retry', retry),) if retry else ())):
        if r.get('sealed_fixtures_loaded') != 0:
            problems.append(f'{name}: sealed_fixtures_loaded is {r.get("sealed_fixtures_loaded")}')
    if (goose.get('agent') or {}).get('name') != 'goose' or (live.get('agent') or {}).get('name') != 'goose':
        problems.append('the goose reports do not name goose as the agent')
    by = lambda r: {(c['case_id'], c['repetition']): c for c in r['cases']}
    g, b, lv = by(goose), by(builtin), by(live)
    invalid_live = {d['case_id']: d for d in live['summary']['validity']['invalid_detail']}
    rv = by(retry) if retry else {}
    invalid_retry = {d['case_id'] for d in retry['summary']['validity']['invalid_detail']} if retry else set()
    rows = []
    for fid in suite['development_fixture_ids']:
        cases = [c for c in suite['cases'] if fid in fixtures_of(c)]
        entry = {'fixture_id': fid, 'kind': 'attack' if fid.startswith('TB-ATT') else 'benign', 'cases': [], 'end_to_end': True, 'reason_if_not': None}
        for c in cases:
            key = (c['case_id'], 1)
            sg, sb = g.get(key), b.get(key)
            scripted_ok = bool(sg) and bool(sb) and all(sg[a].get('evaluation') for a in ARMS) and all(verdict(sg, a) == verdict(sb, a) for a in ARMS)
            item = {'case_id': c['case_id'], 'generated_from_oracle': bool(c.get('generated_from_oracle')),
                    'scripted': {'ran': bool(sg), 'evaluated': bool(sg) and all(sg[a].get('evaluation') for a in ARMS), 'verdicts_equal_builtin': scripted_ok}}
            lc = lv.get(key)
            if c.get('scripted_only'):
                item['live'] = {'run': False, 'reason': 'scripted-only case in the core suite (a fixed trajectory that tests one detector); never run with a model, as for the built-in agent'}
            elif lc:
                inv = invalid_live.get(c['case_id'])
                item['live'] = {'valid': inv is None, 'invalid_reason': (inv and {'baseline': inv.get('baseline_failures'), 'defended': inv.get('defended_failures')}),
                                'outcomes': {a: lc[a]['outcome'] for a in ARMS},
                                'utility_pass': {a: (lc[a].get('evaluation') or {}).get('utility_pass') for a in ARMS},
                                'attacker_goal_achieved': {a: (lc[a].get('evaluation') or {}).get('attacker_goal_achieved') for a in ARMS}}
            else:
                item['live'] = {'run': False, 'reason': 'not in the live run'}
            rc = rv.get(key)
            if rc:
                item['live_retry'] = {'valid': c['case_id'] not in invalid_retry, 'outcomes': {a: rc[a]['outcome'] for a in ARMS},
                                      'utility_pass': {a: (rc[a].get('evaluation') or {}).get('utility_pass') for a in ARMS},
                                      'attacker_goal_achieved': {a: (rc[a].get('evaluation') or {}).get('attacker_goal_achieved') for a in ARMS}}
            entry['cases'].append(item)
            if not scripted_ok:
                entry['end_to_end'] = False
                entry['reason_if_not'] = f'{c["case_id"]}: scripted run through goose missing, unevaluated or different from the built-in agent'
        if not cases:
            entry['end_to_end'] = False
            entry['reason_if_not'] = 'no case in the development suite'
        rows.append(entry)
    valid_live = ({k[0] for k in lv} - set(invalid_live)) | ({k[0] for k in rv} - invalid_retry)
    live_fixtures = {f for c in suite['cases'] if c['case_id'] in valid_live for f in fixtures_of(c)}
    out = {'task_id': 'TB-059', 'suite': 'tests/external/fixtures/dev-suite.json', 'development_fixtures': len(rows),
           'end_to_end': sum(r['end_to_end'] for r in rows), 'not_end_to_end': [r for r in rows if not r['end_to_end']],
           'fixtures_with_a_valid_live_pair': sorted(live_fixtures), 'fixtures_without_a_valid_live_pair': sorted(set(suite['development_fixture_ids']) - live_fixtures),
           'live': {'model': live.get('model'), 'pairs': live['summary']['validity']['total_pairs'], 'valid_pairs': live['summary']['validity']['valid_pairs'],
                    'invalid_pairs': live['summary']['validity']['invalid_pairs'],
                    'retry': ({'pairs': retry['summary']['validity']['total_pairs'], 'valid_pairs': retry['summary']['validity']['valid_pairs']} if retry else None), 'invalid_rule': 'a provider fault (here: the provider had not answered when the 240 s run limit was reached) makes the pair invalid; it is never counted'},
           'sealed_fixtures_loaded': {'scripted_goose': goose.get('sealed_fixtures_loaded'), 'scripted_builtin': builtin.get('sealed_fixtures_loaded'), 'live_goose': live.get('sealed_fixtures_loaded'), 'live_goose_retry': retry.get('sealed_fixtures_loaded') if retry else None},
           'fixtures': rows, 'problems': problems, 'ok': not problems and all(r['end_to_end'] for r in rows)}
    (ROOT / 'evidence/tb059-task-mapping.json').write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps({k: out[k] for k in ('development_fixtures', 'end_to_end', 'fixtures_without_a_valid_live_pair', 'live', 'sealed_fixtures_loaded', 'problems', 'ok')}, indent=1))
    return 0 if out['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
