#!/usr/bin/env python3
"""TB-029: write docs/attribution-audit.md, every AI-audited case with its trajectory, the localizer's attribution per failed
check, the verdict and the reason. Built from data/reviews/attribution-ai-audit.jsonl and the archived round samples."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
labels = [json.loads(l) for l in (ROOT / 'data/reviews/attribution-ai-audit.jsonl').read_text().splitlines() if l.strip()]
acc = json.loads((ROOT / 'evidence/tb029-attribution-accuracy.json').read_text())
VERDICT = {'correct': 'Correct', 'wrong_step': 'WRONG STEP', 'wrong_rule': 'WRONG RULE', 'missed': 'MISSED', 'unclear': 'Unclear'}
pct = lambda v: '—' if v is None else f'{v:.0%}'
L = ['# TB-029 attribution audit: every case', '',
     '> **Reviewer: AI auditor (an LLM), not a human.** This is an AI audit of the deterministic failure localizer. It is not human calibration and can share the localizer author\'s blind spots. No human has reviewed these cases; the project owner accepted this AI audit as the reviewed cases for TB-029 (A-020). The human review UI remains (`npm run review:attribution`).', '',
     f"**Criterion.** {acc['ai_audit']['criterion']}.", '',
     '**Labels.** Correct · WRONG STEP (the failure is at another step) · WRONG RULE (right step, wrong rule) · MISSED (the check failed and no attribution was given) · Unclear (cannot defend either answer).', '',
     '## Results', '', '| Round | Localizer | Cases | Check | Correct / judged | Accuracy | 95% Wilson |', '| --- | --- | --- | --- | --- | --- | --- |']
for r, v in acc['ai_audit']['rounds'].items():
    for check in ('utility', 'security', 'all'):
        s = v['summary'][check]
        L.append(f"| {r} ({v['note']}) | {v['localizer_version']} | {v['cases']} | {check} | {s['correct']} / {s['judged']} | {pct(s['accuracy'])} | {'—' if not s['wilson95'] else pct(s['wilson95'][0]) + '–' + pct(s['wilson95'][1])} |")
defects = json.loads((ROOT / 'data/reviews/attribution-audit-defects.json').read_text())
L += ['', f"Measured accuracy (final round {acc['measured_accuracy']['round']}, localizer {acc['measured_accuracy']['localizer_version']}): "
      f"**{acc['measured_accuracy']['all']['correct']}/{acc['measured_accuracy']['all']['judged']}** failed checks. "
      f"{acc['ai_audit']['consistency_corrections']['count']} earlier labels were corrected for consistency ({acc['ai_audit']['consistency_corrections']['note']}); "
      'each corrected verdict below shows its original label.', '', '## Defects found', '']
for rnd, d in defects['rounds'].items():
    head = (f"**Round {rnd} (localizer {d['audited_version']}) → fixed in {d['fixed_in']}, then evaluated only on a later fresh round:**" if d['fixed_in']
            else f"**Round {rnd} (localizer {d['audited_version']}) → {d['status']}:**")
    L += [head, '']
    for i, x in enumerate(d['defects'], 1):
        L.append(f"{i}. {x['text']} ({', '.join(x['cases'])})" + (f" Proposed fix: {x['proposed_fix']}" if x.get('proposed_fix') else ''))
    for x in d.get('notes', []):
        L.append(f'- Note: {x}')
    if not d['defects']:
        L.append('No defect found.')
    for x in d.get('also_fixed_before_round_4', []):
        L.append(f"- Also fixed in {d['fixed_in']}: {x['text']}")
    L.append('')
L += ['## Findings beyond the localizer', '', *[f"- {x['text']} ({', '.join(x['cases'])})" for x in defects['findings']], '']
for rnd in sorted({l['round'] for l in labels}):
    sample = json.loads((ROOT / f'reports/attribution-audit/round{rnd}-sample.json').read_text())['cases']
    L += [f'## Round {rnd} cases ({len(sample)})', '']
    by_case = {}
    for l in labels:
        if l['round'] == rnd:
            by_case.setdefault(l['case_number'], []).append(l)
    for n, c in enumerate(sample, 1):
        r = c['row']
        L.append(f"### R{rnd}-{n} · {r['case_id']} r{r['repetition']} · {r['model']} · {r['system']} ({r['arm']}) · {r['rendering']}/{r['profile']}")
        L.append('')
        L.append(f"Outcome `{r['outcome']}` · utility {'passed' if r['utility_pass'] else '**failed**'} · security {'passed' if r['security_pass'] else '**failed**'} · attacker goal {'reached' if r['attacker_goal'] else 'not reached'} · evaluator: {', '.join(c['evaluation']['reason_codes'])}")
        L.append('')
        L.append('| # | Tool | Status | Arguments (truncated) |'); L.append('| --- | --- | --- | --- |')
        for i, t in enumerate(c['trace']):
            args = json.dumps(t.get('args'), sort_keys=True).replace('|', '\\|')
            L.append(f"| {i} | `{t['tool']}` | {t['status']}{' (' + t['error'] + ')' if t.get('error') else ''} | `{args[:150]}{'…' if len(args) > 150 else ''}` |")
        L.append(f"| end | — | run failures: {', '.join(c['failures']) or 'none'} | |")
        L.append('')
        for l in sorted(by_case.get(n, []), key=lambda x: x['check']):
            pred = f"`{l['predicted'][0]}` at step {l['predicted'][1]}" if l['predicted'] else 'no attribution'
            fix = f" → should be step {l['correct_step']}" + (f", `{l['correct_rule']}`" if l['correct_rule'] else '') if l['label'] not in ('correct', 'unclear') else ''
            L.append(f"- **{l['check'].capitalize()}**: localizer said {pred}. **{VERDICT[l['label']]}**{fix}. {l['reason']}"
                     + (f" *(Originally labelled {VERDICT[l['original_label']]}. {l['correction']})*" if l.get('original_label') else ''))
        L.append('')
(ROOT / 'docs/attribution-audit.md').write_text('\n'.join(L) + '\n')
print(f"wrote docs/attribution-audit.md: {sum(1 for _ in labels)} verdicts")
