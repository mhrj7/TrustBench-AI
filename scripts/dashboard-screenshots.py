#!/usr/bin/env python3
"""TB-030 evidence: screenshots of every dashboard view in shared-demo (redacted) mode.

Starts the dashboard on a local port without the unredacted variable, drives headless Chrome over the DevTools protocol,
waits for each view to finish rendering, captures the whole page, and checks the rendered text for Streamlit exceptions
and for any sensitive value (any spelling variant). Runs and groups shown are picked by the selectors in
configs/dashboard.yaml from the data, never by a typed ID. Writes app/screenshots/*.png and manifest.json."""
import base64, hashlib, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from websockets.sync.client import connect  # noqa: E402

from app import views  # noqa: E402
from app.redact import Redactor  # noqa: E402
from app.store import load_config, load_runs  # noqa: E402

cfg = load_config()
sc = cfg['screenshots']
index = json.loads((ROOT / cfg['index_file']).read_text())
runs = load_runs(index, cfg)
valid = [r for r in runs if not r['invalid']]
metrics = {k: v for k, v in cfg['metrics'].items() if isinstance(v, dict)}


def pick_run(selector: str) -> dict:
    ordered = sorted(valid, key=lambda r: r['run_id'])
    if selector == 'timed_failed_with_gateway_denial':
        cands = [r for r in ordered if r['spans_file'] and not (r['utility_pass'] and r['security_pass']) and any(d == 'deny' for _, d, _ in r['policy'])]
    elif selector == 'untimed_defense_false_positive':
        cands = [r for r in ordered if not r['spans_file'] and r['utility_rule'] == 'call_denied_by_defense']
    else:
        raise SystemExit(f'unknown run selector {selector}')
    if not cands:
        raise SystemExit(f'no run matches {selector}')
    return cands[0]


def pick_group(selector: str) -> tuple[int, dict]:
    groups = views.aggregate(valid, cfg['default_group'], metrics, cfg['wilson_z'])
    if selector != 'defended_system_with_most_runs':
        raise SystemExit(f'unknown group selector {selector}')
    by_system: dict = {}
    for g in groups:
        if g['key']['system'] != 'baseline':
            by_system[g['key']['system']] = by_system.get(g['key']['system'], 0) + g['runs']
    system = max(sorted(by_system), key=by_system.get)
    i, g = max(((i, g) for i, g in enumerate(groups) if g['key']['system'] == system), key=lambda x: (x[1]['runs'], -x[0]))
    return i, g


def wait_http(url: str, timeout: float = 60) -> bytes:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                return resp.read()
        except OSError:
            time.sleep(0.5)
    raise SystemExit(f'timed out waiting for {url}')


class CDP:
    def __init__(self, ws_url: str):
        self.ws, self.n = connect(ws_url, max_size=None), 0

    def call(self, method: str, **params):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self.n:
                if 'error' in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get('result', {})

    def page_value(self, expr: str):
        # Runs one of this script's fixed read-only expressions in the local headless page (CDP Runtime.evaluate); no
        # input from the page or the data is ever evaluated.
        return self.call('Runtime.evaluate', expression=expr, returnByValue=True)['result'].get('value')


STATE_JS = """JSON.stringify({
  header: [...document.querySelectorAll('h2')].map(h => h.innerText).join('|'),
  running: !!document.querySelector('[data-testid="stStatusWidget"] img, [data-testid="stStatusWidget"] svg'),
  skeleton: document.querySelectorAll('[data-testid="stSkeleton"]').length,
  plots: document.querySelectorAll('.js-plotly-plot .main-svg').length,
  exception: document.querySelectorAll('[data-testid="stException"]').length,
  height: Math.max(document.body.scrollHeight, ...[...document.querySelectorAll('[data-testid="stMain"], section.main, [data-testid="stAppViewContainer"]')].map(e => e.scrollHeight))
})"""

out_dir = ROOT / sc['dir']
out_dir.mkdir(parents=True, exist_ok=True)
env = {k: v for k, v in os.environ.items() if k != cfg['redaction']['unredacted_env']}
app_proc = subprocess.Popen([str(ROOT / '.venv-tools/bin/python'), '-m', 'streamlit', 'run', 'app/dashboard.py', '--server.address', '127.0.0.1',
                             '--server.port', str(sc['port']), '--server.headless', 'true', '--browser.gatherUsageStats', 'false',
                             '--client.toolbarMode', 'viewer'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
profile = tempfile.mkdtemp(prefix='tb030-chrome-')
chrome = None
red = Redactor.for_dashboard(cfg)
shots, failures = [], []
try:
    wait_http(f"http://127.0.0.1:{sc['port']}/_stcore/health")
    w, h = sc['window']
    chrome = subprocess.Popen([sc['chrome'], '--headless=new', f"--remote-debugging-port={sc['cdp_port']}", f'--user-data-dir={profile}',
                               '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', f'--window-size={w},{h}', 'about:blank'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_http(f"http://127.0.0.1:{sc['cdp_port']}/json/version")
    target = next(t for t in json.loads(wait_http(f"http://127.0.0.1:{sc['cdp_port']}/json/list")) if t['type'] == 'page')
    cdp = CDP(target['webSocketDebuggerUrl'])
    cdp.call('Page.enable')
    for v in sc['views']:
        query, chosen = dict(v['query']), {}
        if 'run' in v:
            run = pick_run(v['run'])
            query['run'], chosen = run['run_id'], {'run_selector': v['run'], 'run_id': run['run_id']}
        if 'group' in v:
            i, g = pick_group(v['group'])
            query['group'], chosen = str(i), {'group_selector': v['group'], 'group_index': i, 'group': g['key'], 'group_runs': g['runs']}
        url = f"http://127.0.0.1:{sc['port']}/?{urlencode(query)}"
        cdp.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
        cdp.call('Page.navigate', url=url)
        stable, last, end = 0, None, time.time() + 120
        while time.time() < end:
            time.sleep(1.0)
            state = json.loads(cdp.page_value(STATE_JS) or '{}')
            ready = v['header'] in state.get('header', '') and not state.get('running') and not state.get('skeleton')
            stable = stable + 1 if ready and state == last else 0
            last = state
            if stable >= 3:
                break
        else:
            failures.append(f"{v['name']}: page did not settle")
        height = min(int(last['height']) + 60, sc['max_height'])
        cdp.call('Emulation.setDeviceMetricsOverride', width=w, height=height, deviceScaleFactor=1, mobile=False)
        time.sleep(2.0)  # let Streamlit and Plotly re-layout at the new height
        text = cdp.page_value('document.body.innerText') or ''
        found = red.find(text)
        if found:
            failures.append(f"{v['name']}: sensitive value visible ({len(found)})")
        if last.get('exception'):
            failures.append(f"{v['name']}: Streamlit exception on the page")
        # The viewport already has the full page height; capturing beyond it re-lays the page out mid-capture.
        png = base64.b64decode(cdp.call('Page.captureScreenshot', format='png', captureBeyondViewport=False)['data'])
        path = out_dir / f"{v['name']}.png"
        path.write_bytes(png)
        shots.append({'name': v['name'], 'file': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(png).hexdigest(), 'bytes': len(png),
                      'url_query': query, 'height': height, 'plots': last.get('plots'), 'sensitive_values_visible': len(found), **chosen})
        print(f"{v['name']}: {path.relative_to(ROOT)} ({height}px, {last.get('plots')} plots)")
finally:
    if chrome:
        chrome.terminate()
        chrome.wait(timeout=20)
    app_proc.terminate()
    app_proc.wait(timeout=20)
    shutil.rmtree(profile, ignore_errors=True)

manifest = {'task_id': 'TB-030', 'captured_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'store_version': index['store_version'],
            'mode': 'shared demo (redacted; unredacted variable unset)', 'browser': 'headless Chrome over the DevTools protocol',
            'ok': not failures, 'failures': failures, 'screenshots': shots}
(out_dir / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
print(json.dumps({'ok': not failures, 'failures': failures, 'screenshots': len(shots)}))
sys.exit(0 if not failures else 1)
