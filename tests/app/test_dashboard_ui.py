"""TB-030 dashboard UI, driven headlessly with Streamlit's AppTest: every view renders, the comparison view opens the
raw record behind an aggregate, and shared-demo mode shows no sensitive value while the unredacted host mode does
(positive control)."""
import json

import pytest
from streamlit.testing.v1 import AppTest

from app.redact import Redactor
from app.store import ROOT, load_config, load_runs, raw_record

APP = str(ROOT / 'app/dashboard.py')
CFG = load_config()
RUNS = load_runs(json.loads((ROOT / CFG['index_file']).read_text()), CFG)
RED = Redactor.for_dashboard(CFG)


def start(params, env=None, monkeypatch=None):
    if env:
        for k, v in env.items():
            monkeypatch.setenv(k, v)
    at = AppTest.from_file(APP, default_timeout=180)
    for k, v in params.items():
        at.query_params[k] = v
    return at.run()


def rendered_text(at) -> str:
    parts = [e.value for e in at.code] + [e.value for e in at.json] + [e.value for e in at.markdown] + [e.value for e in at.caption]
    parts += [e.value.to_csv() for e in at.dataframe]
    return '\n'.join(str(p) for p in parts)


@pytest.mark.parametrize('view', ['comparison', 'trace', 'policy', 'outcomes'])
def test_every_view_renders_without_errors(view):
    at = start({'view': view})
    assert not at.exception and not at.error
    assert at.header[0].value


def test_comparison_opens_the_raw_record_behind_an_aggregate():
    at = start({'view': 'comparison', 'group': '0'})
    assert not at.exception
    evidence = next(df for df in (e.value for e in at.dataframe) if 'run_id' in df.columns)
    rid = at.selectbox(key='raw_cmp').value
    assert rid in set(evidence['run_id'])
    run = next(r for r in RUNS if r['run_id'] == rid)
    assert at.download_button(key='dl_cmp') is not None
    shown = json.loads(at.json[0].value)
    assert shown['source'] == {'report': run['report'], 'sha256': run['report_sha256'], 'pointer': run['pointer']}
    assert shown['run']['evaluation'] == RED.value(raw_record(run)['run']['evaluation'])


def _run_with_secret_in_final_text():
    for r in RUNS:
        if r['invalid']:
            continue
        text = raw_record(r)['run'].get('final_text') or ''
        found = RED.find(text)
        if found:
            return r, found[0]
    pytest.skip('no valid run shows a sensitive value in its final text')


def test_shared_demo_mode_shows_no_sensitive_value_but_host_mode_can(monkeypatch):
    run, secret = _run_with_secret_in_final_text()
    monkeypatch.delenv(CFG['redaction']['unredacted_env'], raising=False)
    demo = start({'view': 'trace', 'run': run['run_id']})
    assert not demo.exception and demo.selectbox(key='trace_run').value == run['run_id']
    assert not demo.toggle, 'shared-demo mode offers no unredacted toggle'
    assert RED.find(rendered_text(demo)) == []
    host = start({'view': 'trace', 'run': run['run_id']}, env={CFG['redaction']['unredacted_env']: '1'}, monkeypatch=monkeypatch)
    host.toggle[0].set_value(True).run()
    assert secret in rendered_text(host), 'positive control: the unredacted host view must show the raw value'
