#!/usr/bin/env python3
"""TB-029 acceptance: attribution accuracy against reviewed cases. Human review and the AI audit are kept strictly
separate and labelled; the constructed-ground-truth check is reported on its own. Writes
evidence/tb029-attribution-accuracy.json and docs/attribution.md. No number is typed by hand."""
import json, math, sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.analysis.constructed import score  # noqa: E402
from src.analysis.localize import Contracts  # noqa: E402

C = Contracts(); cfg = C.cfg


def wilson(k, n, z=1.959963984540054):
    if n == 0:
        return None
    p, d = k / n, 1 + z * z / n
    c, h = p + z * z / (2 * n), z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round(max(0.0, (c - h) / d), 4), round(min(1.0, (c + h) / d), 4)]


def jsonl(path):
    p = ROOT / path
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def summarize(labels):
    out = {}
    for check in ('utility', 'security', 'all'):
        xs = [l for l in labels if check == 'all' or l['check'] == check]
        judged = [l for l in xs if l['label'] != 'unclear']
        k = sum(l['label'] == 'correct' for l in judged)
        out[check] = {'checks': len(xs), 'judged': len(judged), 'correct': k, 'unclear': len(xs) - len(judged),
                      'accuracy': round(k / len(judged), 4) if judged else None, 'wilson95': wilson(k, len(judged)), 'labels': dict(Counter(l['label'] for l in xs))}
    return out


ai = jsonl(cfg['ai_audit_file'])
defects = json.loads((ROOT / 'data/reviews/attribution-audit-defects.json').read_text())
final_round = max(int(r) for r in defects['rounds'])
rounds = {}
for r in sorted({l['round'] for l in ai}):
    sample = json.loads((ROOT / f'reports/attribution-audit/round{r}-sample.json').read_text())
    d = defects['rounds'][str(r)]
    assert d['audited_version'] == sample.get('localizer_version', '1.0.0'), r
    note = (f"first audit; its defects fixed in {d['fixed_in']}" if r == 1 else
            f"fresh cases; their defects fixed in {d['fixed_in']}" if d['fixed_in'] else 'fresh cases; latest round, nothing fixed after it' + ('' if d['defects'] else ', no defect found'))
    mine = [l for l in ai if l['round'] == r]
    first = [dict(l, label=l.get('original_label', l['label'])) for l in mine]
    rounds[str(r)] = {'localizer_version': d['audited_version'], 'cases': len(sample['cases']), 'summary': summarize(mine), 'note': note,
                      'fixed_in': d['fixed_in'], 'defects': len(d['defects']),
                      'corrections': sum('original_label' in l for l in mine),
                      'summary_as_first_recorded': summarize(first) if any('original_label' in l for l in mine) else None}


def regression_check():
    """The current localizer against every audited verdict (the cases its fixes were designed from: a consistency check, not accuracy)."""
    from src.analysis.localize import localize
    reports, res = {}, Counter()
    for l in ai:
        if l['label'] == 'unclear':
            continue
        stem, case_id, rep, arm = l['run_id'].split('|')
        rep_json = reports.setdefault(stem, json.loads((ROOT / 'evidence' / f'{stem}-report.json').read_text()))
        src = next(c for c in rep_json['cases'] if c['case_id'] == case_id and f"r{c['repetition']}" == rep)
        side = src[arm]; ev = side['evaluation']
        out = localize(side['tool_trace'], C.for_case(src['fixture_id'], src.get('attack_id')), C,
                       failed={'utility': not ev['utility_pass'], 'security': not ev['security_pass']}, failures=side['failures'])
        e = out['explaining'][l['check']]
        truth = l['predicted'] if l['label'] == 'correct' else (None if l['correct_rule'] is None else [l['correct_rule'], l['correct_step']])
        res[(l['round'], (e and [e['rule'], e['step']]) == truth)] += 1
    return {str(r): {'agrees': res[(r, True)], 'differs': res[(r, False)]} for r in sorted({k[0] for k in res})}


human = jsonl(cfg['review_file'])
constructed = score(C)
fin = rounds[str(final_round)]
out = {'task_id': 'TB-029', 'localizer_version': cfg['schema_version'],
       'measured_accuracy': {'round': final_round, 'localizer_version': fin['localizer_version'], **{c: fin['summary'][c] for c in ('utility', 'security', 'all')},
                             'note': 'The latest audit round on fresh cases (A-020 closed TB-029 on round 4 with 1.3.0; A-022 added round 5 for 1.4.0). Defects it finds stay open, so this is the accuracy of the localizer as shipped.'},
       'human_review': {'labels': len(human), 'summary': summarize(human) if human else None,
                        'status': 'complete' if human else 'not done: no human has reviewed any case',
                        'deviation': 'A-020: the project owner accepted the AI audit as the reviewed cases on 2026-10-16. The reviewed cases are AI-audited, not human-reviewed, and no human-AI agreement is measured.'},
       'ai_audit': {'reviewer': 'AI auditor (an LLM), not a human', 'criterion': 'an attribution is correct only if its step is the earliest step at which the run went wrong in a way that mechanically produced the failed check, and its rule names what went wrong there (what failed the check; where two rules describe the same fact, the more specific one in the documented order); each failed check (utility, security) is judged separately',
                    'rounds': rounds,
                    'consistency_corrections': {'count': sum(v['corrections'] for v in rounds.values()),
                                                'note': 'Earlier labels that accepted a true but less specific rule (identity mismatch for an attacker value; grounding where the schema rejection failed the write) were corrected to wrong_rule to match the criterion; each keeps original_label and the reason. Both figures are shown.'},
                    'regression_check': {'by_round': regression_check(), 'note': f"Localizer {cfg['schema_version']} against every audited verdict. Rounds before {final_round} drove the fixes, so agreement there is a consistency check, not accuracy; round {final_round}'s differences are its open defects."}},
       'constructed_ground_truth': {k: constructed[k] for k in ('ground_truth', 'cases', 'correct', 'by_rule')},
       'open_defects': defects['rounds'][str(final_round)]['defects'],
       'judge_labels': 'not used for any decision: the AI audit only evaluates the deterministic localizer; no judge labels are added to reports/attribution.csv'}
(ROOT / 'evidence/tb029-attribution-accuracy.json').write_text(json.dumps(out, indent=1) + '\n')

pct = lambda v: '—' if v is None else f'{v:.0%}'
ci = lambda w: '—' if not w else f'{pct(w[0])}–{pct(w[1])}'
ma = out['measured_accuracy']
lines = ['# Failure attribution (TB-029)', '',
         'Generated by `scripts/attribution-accuracy.py`. The localizer (`src/analysis/localize.py`, rules in `configs/localization.yaml`, '
         f"version {cfg['schema_version']}) reports, for each failed run in `reports/attribution.csv`, the first step where the run left its task contract and, "
         'for each failed check, the first violation that can explain it. **It names where the trajectory first violated the contract; it does not show that this step caused the failure.**', '',
         '## Measured accuracy', '',
         f"Latest audit round {ma['round']} (fresh cases, localizer {ma['localizer_version']}): **{ma['all']['correct']}/{ma['all']['judged']} failed checks attributed correctly "
         f"({pct(ma['all']['accuracy'])}, 95% Wilson {ci(ma['all']['wilson95'])})**: utility {ma['utility']['correct']}/{ma['utility']['judged']}, security {ma['security']['correct']}/{ma['security']['judged']}. "
         + (f"{len(out['open_defects'])} defects found in that round are open (below). " if out['open_defects'] else 'No defect was found in that round. ')
         + ' '.join(defects['rounds'][str(final_round)].get('notes', [])) + ' The reviewer is an AI model, not a human; see the deviation note.', '',
         '## Human review', '', f"Status: {out['human_review']['status']}. {out['human_review']['deviation']} The review UI is `npm run review:attribution`; human labels, if added, are reported here separately and take precedence.", '',
         '## AI audit (an AI model, not a human)', '',
         f"Criterion: {out['ai_audit']['criterion']}. Every case, verdict and reason is in `docs/attribution-audit.md`.", '',
         '| Round | Localizer | Cases | Sample | Check | Judged | Correct | Accuracy | 95% Wilson | As first recorded |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
for r, v in rounds.items():
    for check in ('utility', 'security', 'all'):
        s, f = v['summary'][check], (v['summary_as_first_recorded'] or {}).get(check)
        first = f"{f['correct']}/{f['judged']}" if f and f['correct'] != s['correct'] else 'same'
        lines.append(f"| {r} | {v['localizer_version']} | {v['cases']} | {v['note']} | {check} | {s['judged']} | {s['correct']} | {pct(s['accuracy'])} | {ci(s['wilson95'])} | {first} |")
cc, rc = out['ai_audit']['consistency_corrections'], out['ai_audit']['regression_check']
lines += ['', f"Each round is a fresh stratified sample with no overlap with earlier rounds, so no version is scored on the cases it was fixed against. "
          f"**Consistency corrections:** {cc['count']} earlier labels were changed to wrong_rule. {cc['note']} "
          'An AI audit is not human calibration: it can share the localizer author\'s blind spots.', '',
          f"**Regression check** ({rc['note']}): " + '; '.join(f"round {r}: {v['agrees']} agree, {v['differs']} differ" for r, v in rc['by_round'].items()) + '.', '',
          '## Open defects (found in the latest round, not fixed)', '',
          *([f"- **{d['id']}** ({', '.join(d['cases'])}): {d['text']} Proposed fix: {d['proposed_fix']}" for d in out['open_defects']] or ['None found in the final round.']), '',
          '## Constructed ground truth (rule correctness check, not a review)', '',
          f"{constructed['correct']}/{constructed['cases']} trajectories with one injected violation at a known step were localized exactly.", '',
          '| Rule | Cases | Correct |', '| --- | --- | --- |', *[f"| {k} | {v['cases']} | {v['correct']} |" for k, v in constructed['by_rule'].items()], '']
(ROOT / 'docs/attribution.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({r: {c: (v['summary'][c]['correct'], v['summary'][c]['judged']) for c in ('utility', 'security', 'all')} for r, v in rounds.items()}))
