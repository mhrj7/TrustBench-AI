"""TB-029 review UI: a local page where a human reviews localized failures. Labels are appended to
data/reviews/attribution-reviews.jsonl, each bound to the exact prediction it reviewed (prediction_sha256)."""
from __future__ import annotations

import html
import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

ROOT = Path(__file__).resolve().parents[2]
CFG = json.loads((ROOT / 'configs/localization.yaml').read_text())
RULES = {r['id']: r['description'] for r in CFG['step_rules'] + CFG['terminal_rules']}
LABELS = {'correct': 'Correct: this step and rule are where the failure is', 'wrong_step': 'Wrong step', 'wrong_rule': 'Right step, wrong rule', 'unclear': 'Unclear / cannot judge'}
app = FastAPI()


def sample() -> list[dict]:
    return json.loads((ROOT / CFG['sample_file']).read_text())['cases']


def reviews() -> dict[tuple[str, str], dict]:
    path = ROOT / CFG['review_file']
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                rv = json.loads(line); out[(rv['run_id'], rv['prediction_sha256'])] = rv
    return out


def attribution(case: dict) -> tuple[str, list | None]:
    """The failure-explaining attribution under review: utility first, then security."""
    p = case['prediction']
    return ('utility', p['utility']) if p.get('utility') else ('security', p['security']) if p.get('security') else ('first', p.get('first'))


E = html.escape


@app.get('/', response_class=HTMLResponse)
def page(i: int | None = None) -> str:
    cases, done = sample(), reviews()
    reviewed = [(c['row']['run_id'], c['row']['prediction_sha256']) in done for c in cases]
    if i is None:
        i = next((k for k, r in enumerate(reviewed) if not r), 0)
    i = max(0, min(i, len(cases) - 1))
    c, row = cases[i], cases[i]['row']
    check, att = attribution(c)
    prior = done.get((row['run_id'], row['prediction_sha256']))
    steps = ''.join(
        f"<tr class='{'hit' if att and k == att[1] else ''}'><td>{k}</td><td>{E(s['tool'])}</td><td>{E(s['status'])}</td><td>{E(str(s.get('error') or ''))}</td>"
        f"<td><code>{E(json.dumps(s.get('args'), sort_keys=True)[:400])}</code></td></tr>" for k, s in enumerate(c['trace']))
    end_row = f"<tr class='{'hit' if att and att[1] == len(c['trace']) else ''}'><td>{len(c['trace'])}</td><td colspan=4><i>end of run</i> (outcome {E(row['outcome'])})</td></tr>"
    violations = ''.join(f"<li>step {v['step']}: <b>{E(v['rule'])}</b> on {E(v['tool'])} ({'executed' if v['executed'] else 'blocked/failed'}): {E(str(v['detail']))}</li>" for v in c['violations']) or '<li>none</li>'
    contract = c['contract']
    rule_opts = ''.join(f"<option value='{k}'>{k}: {E(d)}</option>" for k, d in RULES.items())
    label_opts = ''.join(f"<label><input type=radio name=label value='{k}' {'checked' if prior and prior['label'] == k else ''}> {E(v)}</label><br>" for k, v in LABELS.items())
    nav = ' '.join(f"<a href='/?i={k}' class='{'cur' if k == i else ''} {'ok' if r else ''}'>{k + 1}</a>" for k, r in enumerate(reviewed))
    return f"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Attribution review</title>
<style>:root{{--bg:#fff;--fg:#1d1d1f;--mut:#666;--hit:#fff4c2;--ok:#d8f5dc;--bd:#ddd}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151515;--fg:#eee;--mut:#aaa;--hit:#4a3f12;--ok:#1f4a28;--bd:#333}}}}
body{{background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:16px;max-width:1100px}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid var(--bd);padding:4px 6px;text-align:left;vertical-align:top}}
tr.hit{{background:var(--hit)}}code{{font-size:12px;word-break:break-all}}.mut{{color:var(--mut)}}nav a{{display:inline-block;padding:2px 6px;margin:2px;border:1px solid var(--bd);border-radius:4px;text-decoration:none;color:var(--fg)}}
nav a.ok{{background:var(--ok)}}nav a.cur{{outline:2px solid var(--fg)}}.box{{border:1px solid var(--bd);border-radius:8px;padding:10px 14px;margin:12px 0}}
button{{font-size:14px;padding:6px 14px}}</style></head><body>
<h2>Failure attribution review <span class=mut>({sum(reviewed)}/{len(cases)} reviewed)</span></h2><nav>{nav}</nav>
<div class=box><b>Case {i + 1}</b> · {E(row['model'])} · {E(row['system'])} ({E(row['arm'])}) · {E(row['rendering'])} / {E(row['profile'])} · <code>{E(row['case_id'])}</code> r{row['repetition']}<br>
Utility {'passed' if row['utility_pass'] else '<b>failed</b>'} · Security {'passed' if row['security_pass'] else '<b>failed</b>'} · attacker goal {'reached' if row['attacker_goal'] else 'not reached'} · stratum {E(c['stratum'])}</div>
<div class=box><b>Task contract</b><br>{E(contract.get('request', ''))}<br><span class=mut>allowed tools: {E(', '.join(contract.get('allowed_tools', [])))}</span><br>
<code>{E(json.dumps({k: v for k, v in contract.items() if k not in ('request', 'allowed_tools', 'user_id')}, sort_keys=True))}</code></div>
<div class=box><b>Trajectory</b> (highlighted: the attributed step)<table><tr><th>#</th><th>tool</th><th>status</th><th>error</th><th>arguments</th></tr>{steps}{end_row}</table>
<p class=mut>Run failures: {E(', '.join(c['failures']) or 'none')} · final text: {E((c['final_text'] or '')[:300])}</p></div>
<div class=box><b>Localizer attribution for the failed {E(check)} check:</b> {'<b>' + E(att[0]) + '</b> at step ' + str(att[1]) + ' — ' + E(RULES.get(att[0], '')) if att else 'none'}
<p class=mut>All rule hits:</p><ul>{violations}</ul></div>
<form class=box id=f><input type=hidden name=run_id value='{E(row['run_id'])}'><input type=hidden name=prediction_sha256 value='{E(row['prediction_sha256'])}'><input type=hidden name=i value={i}>
<b>Is the attribution right?</b><br>{label_opts}
<p>If not: correct step <input name=correct_step size=4 value='{E(str(prior.get('correct_step', '')) if prior else '')}'> correct rule <select name=correct_rule><option value=''>—</option>{rule_opts}</select></p>
<p>Note <input name=note size=60 value='{E(prior.get('note', '') if prior else '')}'> · Reviewer <input name=reviewer id=rv size=14 required></p>
<button type=submit>Save and next</button> <span id=msg class=mut></span></form>
<script>
const rv=document.getElementById('rv'); try{{rv.value=localStorage.getItem('reviewer')||''}}catch(e){{}}
document.getElementById('f').onsubmit=async(e)=>{{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
if(!d.label){{document.getElementById('msg').textContent='choose a label';return}} try{{localStorage.setItem('reviewer',d.reviewer)}}catch(e){{}}
const r=await fetch('/label',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify(d)}});
if(r.ok) location.href='/?i='+(Number(d.i)+1); else document.getElementById('msg').textContent='not saved: '+(await r.text());}};
</script></body></html>"""


@app.post('/label')
async def label(request: Request) -> JSONResponse:
    body = await request.json()
    cases = {c['row']['run_id']: c for c in sample()}
    case = cases.get(body.get('run_id'))
    if case is None or body.get('prediction_sha256') != case['row']['prediction_sha256']:
        raise HTTPException(400, 'unknown run or stale prediction')
    if body.get('label') not in LABELS or not str(body.get('reviewer', '')).strip():
        raise HTTPException(400, 'label and reviewer are required')
    check, att = attribution(case)
    record = {'run_id': case['row']['run_id'], 'prediction_sha256': case['row']['prediction_sha256'], 'reviewed_check': check, 'reviewed_attribution': att,
              'label': body['label'], 'correct_step': int(body['correct_step']) if str(body.get('correct_step', '')).strip().lstrip('-').isdigit() else None,
              'correct_rule': body.get('correct_rule') or None, 'note': str(body.get('note', ''))[:500], 'reviewer': str(body['reviewer'])[:60],
              'reviewed_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    path = ROOT / CFG['review_file']
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as fh:
        fh.write(json.dumps(record, sort_keys=True) + '\n')
    return JSONResponse({'saved': True})
