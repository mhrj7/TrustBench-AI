"""TrustBench review dashboard (TB-030). Start with `npm run dashboard` (binds to 127.0.0.1).

Reads only the versioned run store (app/store.py). Every number shown keeps the run IDs behind it, and every run opens to
its raw record (report file, SHA-256, JSON pointer). Payloads are redacted unless the host sets the variable named in
configs/dashboard.yaml (redaction.unredacted_env)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402
import plotly.express as px  # noqa: E402
import plotly.graph_objects as go  # noqa: E402
import streamlit as st  # noqa: E402

from app import views  # noqa: E402
from app.redact import Redactor  # noqa: E402
from app.store import load_config, load_runs, raw_record, run_spans, verify_index  # noqa: E402
from src.analysis.localize import Contracts  # noqa: E402

st.set_page_config(page_title='TrustBench review', layout='wide', initial_sidebar_state='expanded')
CFG = load_config()
METRICS = {k: v for k, v in CFG['metrics'].items() if isinstance(v, dict)}
VIEWS = {'comparison': 'Comparison by configuration', 'trace': 'Run trace', 'policy': 'Policy reasons', 'outcomes': 'Task outcomes'}


@st.cache_data(show_spinner='Loading the run store…')
def load_store(index_text: str):
    index = json.loads(index_text)
    return index, load_runs(index, CFG), verify_index(index, CFG)


@st.cache_resource
def redactor() -> Redactor:
    return Redactor.for_dashboard(CFG)


@st.cache_resource
def denial_check():
    return Contracts().is_defense_denial


index_path = ROOT / CFG['index_file']
if not index_path.exists():
    st.error(f"No run-store index at {CFG['index_file']}. Build it with `npm run dashboard:index`.")
    st.stop()
INDEX, RUNS, PROBLEMS = load_store(index_path.read_text())
BY_ID = {r['run_id']: r for r in RUNS}
UNREDACTED_ALLOWED = os.environ.get(CFG['redaction']['unredacted_env']) == '1'

# ---- sidebar: view, redaction, filters -------------------------------------------------------------------------------
if 'view' not in st.session_state:
    st.session_state.view = st.query_params.get('view', 'comparison') if st.query_params.get('view') in VIEWS else 'comparison'
view = st.sidebar.radio('View', list(VIEWS), format_func=VIEWS.get, key='view')
st.query_params['view'] = view
if UNREDACTED_ALLOWED:
    unredacted = st.sidebar.toggle('Show unredacted payloads (local review only)', value=False)
else:
    unredacted = False
    st.sidebar.caption('Payloads are redacted (shared-demo mode). Unredacted view needs the host variable '
                       f"`{CFG['redaction']['unredacted_env']}=1`.")


def show(obj):
    return obj if unredacted else redactor().value(obj)


st.sidebar.markdown('**Filters**')
selected = {}
for dim in CFG['filters']:
    options = sorted({r[dim] for r in RUNS}, key=str)
    selected[dim] = st.sidebar.multiselect(dim, options, key=f'f_{dim}')
include_invalid = st.sidebar.checkbox('Include invalid runs', value=False, help='Runs the report marked invalid never count toward a metric.')
FILTERED = views.apply_filters(RUNS, selected, include_invalid)

# ---- header -------------------------------------------------------------------------------------------------------------
st.title('TrustBench review dashboard')
reports = sum(e['kind'] == 'report' for e in INDEX['entries'])
att = next((e for e in INDEX['entries'] if e['kind'] == 'attribution'), None)
st.caption(f"Run store `{INDEX['store_version'][:12]}` · {reports} live reports · {len(RUNS)} runs "
           f"({sum(r['invalid'] for r in RUNS)} invalid) · indexed at commit `{(INDEX.get('git_commit') or 'unknown')[:10]}`"
           + (f" · attribution from localizer {att['localizer_version']}" if att else '') + f" · showing {len(FILTERED)} runs")
if PROBLEMS:
    st.error('The evidence on disk no longer matches the indexed run store; raw records of changed files cannot be opened. '
             'Rebuild with `npm run dashboard:index`.\n\n' + '\n'.join(f'- {p}' for p in PROBLEMS))


def pct(v):
    return '—' if v is None else f'{v:.0%}'


def raw_viewer(run_ids: list[str], key: str) -> None:
    """Pick one of the given runs and show its raw record exactly as stored (redacted in shared-demo mode)."""
    if not run_ids:
        st.info('No runs behind this selection.')
        return
    rid = st.selectbox('Open the raw record of run', run_ids, key=f'raw_{key}')
    run = BY_ID[rid]
    try:
        record = raw_record(run)
    except ValueError as err:
        st.error(str(err))
        return
    shown = show(record)
    c1, c2 = st.columns([3, 1])
    c1.markdown(f"Source: `{run['report']}` · SHA-256 `{run['report_sha256']}` · JSON pointer `{run['pointer']}`")
    c2.download_button('Download this record', json.dumps(shown, indent=1), file_name=rid.replace('|', '__') + '.json',
                       mime='application/json', key=f'dl_{key}')
    if st.button('Open in the trace view', key=f'tr_{key}', on_click=lambda: st.session_state.update(view='trace', trace_run=rid)):
        pass
    st.json(shown, expanded=2)


def evidence_for_group(group: dict, key: str) -> None:
    label = ', '.join(f'{k}={v}' for k, v in group['key'].items())
    st.markdown(f'**Evidence behind: {label}**')
    parts = [f"{spec['label']}: {group['metrics'][m]['k']}/{group['metrics'][m]['n']}" for m, spec in METRICS.items()]
    st.caption(' · '.join(parts) + f" · {len(group['invalid_ids'])} invalid runs (never counted). Each run below shows whether it counted for each metric.")
    st.dataframe(pd.DataFrame(views.evidence_rows(group, BY_ID, group['metrics'])), hide_index=True, width='stretch')
    raw_viewer(group['run_ids'], key)


# ---- views --------------------------------------------------------------------------------------------------------------
if view == 'comparison':
    st.header('Comparison by configuration')
    dims = st.multiselect('Group by', CFG['group_dimensions'], default=CFG['default_group'], key='dims')
    if not dims:
        st.stop()
    groups = views.aggregate(FILTERED, dims, METRICS, CFG['wilson_z'])
    table = []
    for g in groups:
        row = dict(g['key'], runs=g['runs'])
        for m, spec in METRICS.items():
            x = g['metrics'][m]
            row[spec['label']] = f"{x['k']}/{x['n']} ({pct(x['rate'])})" if x['n'] else '—'
            row[f"{spec['label']} 95% CI"] = f"{pct(x['ci'][0])}–{pct(x['ci'][1])}" if x['ci'] else '—'
        table.append(row)
    st.dataframe(pd.DataFrame(table), hide_index=True, width='stretch')
    st.caption('Wilson 95% intervals per cell; pilot evidence on the development split, not confirmatory estimates. '
               'The attacker-goal rate counts attack cases only.')
    for tab, (m, spec) in zip(st.tabs([spec['label'] for spec in METRICS.values()]), METRICS.items()):
        cells = [g for g in groups if g['metrics'][m]['n']]
        if not cells:
            tab.info('No runs count toward this metric in the selection.')
            continue
        if len(dims) == 1:
            df = pd.DataFrame([{dims[0]: str(g['key'][dims[0]]), 'rate': 100 * g['metrics'][m]['rate'], 'n': g['metrics'][m]['n'],
                                'lo': 100 * (g['metrics'][m]['rate'] - g['metrics'][m]['ci'][0]), 'hi': 100 * (g['metrics'][m]['ci'][1] - g['metrics'][m]['rate'])}
                               for g in cells])
            fig = px.bar(df, x=dims[0], y='rate', error_y='hi', error_y_minus='lo', hover_data=['n'], labels={'rate': f"{spec['label']} (%)"}, height=420)
        else:
            rows_ = sorted({str(g['key'][dims[0]]) for g in cells})
            cols = sorted({' · '.join(str(g['key'][d]) for d in dims[1:]) for g in cells})
            z = [[None] * len(cols) for _ in rows_]
            text = [[''] * len(cols) for _ in rows_]
            for g in cells:
                x = g['metrics'][m]
                i, j = rows_.index(str(g['key'][dims[0]])), cols.index(' · '.join(str(g['key'][d]) for d in dims[1:]))
                z[i][j], text[i][j] = 100 * x['rate'], f"{x['rate']:.0%}<br>{x['k']}/{x['n']}"
            fig = go.Figure(go.Heatmap(z=z, x=cols, y=rows_, text=text, texttemplate='%{text}', zmin=0, zmax=100, colorscale='Viridis',
                                       colorbar={'title': '%'}, hovertemplate='%{y} · %{x}<br>%{text}<extra></extra>'))
            fig.update_layout(height=max(320, 34 * len(rows_) + 140), yaxis={'autorange': 'reversed'}, xaxis={'side': 'top'})
        tab.plotly_chart(fig, width='stretch', key=f'chart_{m}')
    labels = [f"{i}: " + ', '.join(f'{k}={v}' for k, v in g['key'].items()) + f" ({g['runs']} runs)" for i, g in enumerate(groups)]
    if labels:
        default = int(st.query_params.get('group', 0)) if str(st.query_params.get('group', '0')).isdigit() else 0
        pick = st.selectbox('Open the evidence behind a row', range(len(labels)), format_func=lambda i: labels[i],
                            index=min(default, len(labels) - 1), key='group_pick')
        evidence_for_group(groups[pick], 'cmp')

elif view == 'trace':
    st.header('Run trace')
    if not FILTERED:
        st.info('No runs match the filters.')
        st.stop()
    ids = [r['run_id'] for r in FILTERED]
    if 'trace_run' not in st.session_state or st.session_state.trace_run not in ids:
        wanted = st.query_params.get('run')
        timed = st.query_params.get('timed')
        if wanted in ids:
            st.session_state.trace_run = wanted
        elif timed in ('0', '1'):
            st.session_state.trace_run = next((r['run_id'] for r in FILTERED if bool(r['spans_file']) == (timed == '1')), ids[0])
        else:
            st.session_state.trace_run = ids[0]
    rid = st.selectbox('Run', ids, key='trace_run')
    run = BY_ID[rid]
    record = raw_record(run)
    side = record['run']
    c = st.columns(6)
    c[0].metric('Outcome', run['outcome'])
    c[1].metric('Utility', 'pass' if run['utility_pass'] else 'fail')
    c[2].metric('Security', 'pass' if run['security_pass'] else 'fail')
    c[3].metric('Attacker goal', 'reached' if run['attacker_goal'] else 'no')
    c[4].metric('Elapsed', f"{(run['elapsed_ms'] or 0) / 1000:.1f} s")
    c[5].metric('Tokens in/out', f"{run['tokens_in']}/{run['tokens_out']}")
    st.markdown(f"`{run['model']}` · system `{run['system']}` · rendering `{run['rendering']}` · profile `{run['profile']}` · "
                f"case `{run['case_id']}` ({run['kind']}) r{run['repetition']} · evaluator: {', '.join(run['reason_codes'])}")
    if run['utility_rule'] or run['security_rule']:
        st.markdown('TB-029 attribution (localizer, names where the run first left its contract, not proven cause): '
                    + ' · '.join(f"{c_}: `{run[c_ + '_rule']}` at step {run[c_ + '_step']}" for c_ in ('utility', 'security') if run[c_ + '_rule']))
    spans = run_spans(run)
    if spans:
        bars = views.waterfall_spans(spans)
        fig = go.Figure()
        colors = {'agent.run': '#9aa5b1', 'model.call': '#3b82f6', 'tool.call': '#10b981', 'policy.decision': '#f59e0b'}
        for kind in colors:
            sub = [b for b in bars if b['span'] == kind]
            if sub:
                fig.add_trace(go.Bar(name=kind, orientation='h', y=[f"{i:02d} {b['label']}" for i, b in enumerate(bars) if b['span'] == kind],
                                     x=[b['duration_ms'] for b in sub], base=[b['start_ms'] for b in sub], marker_color=colors[kind],
                                     hovertemplate='%{y}<br>start %{base:.0f} ms, %{x:.1f} ms<extra></extra>'))
        rows_ = [f"{i:02d} {b['label']}" for i, b in enumerate(bars)]
        fig.update_layout(barmode='overlay', height=max(320, 30 * len(bars) + 120), xaxis_title='ms since run start',
                          yaxis={'autorange': 'reversed', 'categoryorder': 'array', 'categoryarray': rows_, 'tickmode': 'array', 'tickvals': rows_})
        st.subheader('Trace waterfall (TB-027 spans)')
        st.plotly_chart(fig, width='stretch')
    else:
        st.subheader('Trace waterfall (step order, untimed)')
        st.caption('No spans were recorded for this run (spans exist only for runs since TB-027), so the bars show the order of '
                   'tool calls, not their timing.')
    steps = views.step_rows(record, run, denial_check())
    if steps:
        if not spans:
            fig = go.Figure(go.Bar(orientation='h', y=[f"{s['step']:02d} {s['tool']}" for s in steps], x=[1] * len(steps), base=[s['step'] for s in steps],
                                   marker_color=['#10b981' if s['status'] == 'succeeded' else '#ef4444' if s['defense denial'] else '#f59e0b' for s in steps],
                                   text=[(s['error / policy reason'] or s['status']) + (f"  ◀ {s['attribution']}" if s['attribution'] else '') for s in steps],
                                   textposition='inside', insidetextanchor='middle', textfont={'size': 13}, hoverinfo='text'))
            labels_ = [f"{s['step']:02d} {s['tool']}" for s in steps]
            fig.update_layout(height=max(280, 48 * len(steps) + 120), xaxis_title='step', showlegend=False,
                              yaxis={'autorange': 'reversed', 'tickmode': 'array', 'tickvals': labels_, 'categoryorder': 'array', 'categoryarray': labels_})
            st.plotly_chart(fig, width='stretch')
        st.subheader('Steps and policy reasons')
        st.dataframe(pd.DataFrame([dict(s, args=json.dumps(show(s['args']), sort_keys=True)) for s in steps]), hide_index=True, width='stretch')
    else:
        st.info('The run made no tool call.')
    gw = views.gateway_rows(record)
    st.subheader('Gateway audit')
    if gw:
        st.dataframe(pd.DataFrame(gw), hide_index=True, width='stretch')
    else:
        st.caption('No gateway decisions for this run (baseline arm or a defense outside the gateway).')
    st.subheader('Final text')
    st.code(show(side.get('final_text') or '') or '(empty)', language=None)
    with st.expander('Raw record'):
        raw_viewer([rid], 'trace')

elif view == 'policy':
    st.header('Policy reasons')
    source = st.radio('Source', ['gateway', 'agent'], horizontal=True,
                      format_func={'gateway': "Gateway audit (the gateway's decisions)", 'agent': 'Denials the agent received (any defense)'}.get)
    dims = st.multiselect('Group by', CFG['group_dimensions'], default=['system'], key='pdims')
    rows = views.policy_reasons(FILTERED, dims, source, denial_check())
    if not rows:
        st.info('No policy decisions in the selected runs.')
        st.stop()
    st.dataframe(pd.DataFrame([dict(r['key'], count=r['count'], runs=len(r['run_ids'])) for r in rows]), hide_index=True, width='stretch')
    top = pd.DataFrame([dict({k: str(v) for k, v in r['key'].items()}, count=r['count'],
                             label=f"{r['key']['decision']}: {r['key']['reason']}" if r['key']['reason'] else r['key']['decision'])
                        for r in rows if r['key']['decision'] != 'allow'])
    if not top.empty:
        fig = px.bar(top, x='count', y='label', color=dims[0] if dims else None, orientation='h',
                     height=max(320, 30 * top['label'].nunique() + 120), labels={'label': 'decision: reason'})
        fig.update_layout(yaxis={'categoryorder': 'total ascending'})
        st.plotly_chart(fig, width='stretch')
    labels = [', '.join(f'{k}={v}' for k, v in r['key'].items()) + f" ({r['count']} in {len(r['run_ids'])} runs)" for r in rows]
    pick = st.selectbox('Open the evidence behind a row', range(len(rows)), format_func=lambda i: labels[i], key='ppick')
    st.dataframe(pd.DataFrame([{'run_id': i, 'report': BY_ID[i]['report'], 'pointer': BY_ID[i]['pointer']} for i in rows[pick]['run_ids']]),
                 hide_index=True, width='stretch')
    raw_viewer(rows[pick]['run_ids'], 'policy')

elif view == 'outcomes':
    st.header('Task outcomes')
    dims = st.multiselect('Group by', CFG['group_dimensions'], default=['system'], key='odims')
    rows = views.outcome_counts(FILTERED, dims)
    if not rows:
        st.info('No runs match the filters.')
        st.stop()
    df = pd.DataFrame([dict({k: str(v) for k, v in r['key'].items()}, runs=r['runs']) for r in rows])
    st.plotly_chart(px.bar(df, x=dims[0] if dims else 'outcome', y='runs', color='outcome', barmode='stack', height=420), width='stretch')
    codes: dict[str, list[str]] = {}
    for r in FILTERED:
        for code in r['reason_codes']:
            codes.setdefault(code, []).append(r['run_id'])
    st.subheader('Evaluator reason codes')
    st.dataframe(pd.DataFrame([{'reason_code': k, 'runs': len(v)} for k, v in sorted(codes.items(), key=lambda kv: -len(kv[1]))]),
                 hide_index=True, width='stretch')
    options = [('outcome', i) for i in range(len(rows))] + [('code', k) for k in sorted(codes)]
    fmt = lambda o: (', '.join(f'{k}={v}' for k, v in rows[o[1]]['key'].items()) + f" ({rows[o[1]]['runs']} runs)") if o[0] == 'outcome' else f'reason code {o[1]} ({len(codes[o[1]])} runs)'
    pick = st.selectbox('Open the evidence behind a row', options, format_func=fmt, key='opick')
    ids = rows[pick[1]]['run_ids'] if pick[0] == 'outcome' else codes[pick[1]]
    st.dataframe(pd.DataFrame([{'run_id': i, 'outcome': BY_ID[i]['outcome'], 'report': BY_ID[i]['report'], 'pointer': BY_ID[i]['pointer']} for i in ids]),
                 hide_index=True, width='stretch')
    raw_viewer(ids, 'outcomes')
