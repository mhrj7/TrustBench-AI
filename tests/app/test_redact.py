"""TB-030 redaction: the Python port matches the TB-027 TypeScript builder, the dashboard set drops only contract-named
values, partial and variant spellings of private data are caught, and the leak check is not vacuous."""
import json
import subprocess
from pathlib import Path

from app.redact import Redactor, dashboard_secrets, sensitive_values, variant_pattern
from app.store import load_config
from src.splits import sealed_fixture_ids  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CFG = load_config()


def test_python_sensitive_set_equals_the_typescript_builder():
    out = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', '-e',
                          "import('./src/observability/tracing.ts').then(m => console.log(JSON.stringify(m.sensitiveValues())))"],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    ts, py = json.loads(out), sensitive_values()
    assert sorted(ts) == sorted(py) and len(set(py)) == len(py)
    assert all(len(a) >= len(b) for a, b in zip(py, py[1:])), 'longest first, so overlapping values are fully replaced'


def test_dashboard_set_drops_only_contract_named_values_and_adds_private_data_markers():
    base, dash = set(sensitive_values()), set(dashboard_secrets(CFG))
    contract = set()
    for line in (ROOT / 'data/benign.jsonl').read_text().splitlines():
        if line.strip():
            contract |= set(map(str, json.dumps(json.loads(line).get('task_contract')).split('"')))
    assert base - dash and all(v in contract for v in base - dash)
    oracles = json.loads((ROOT / 'data/attack-oracles.json').read_text())['attacks']
    effects = set(CFG['redaction']['private_data_effects'])
    holdout = sealed_fixture_ids()
    markers = {m for a, rs in oracles.items() if a not in holdout for r in rs if r.get('effect') in effects for m in r.get('any_of', [])}
    assert markers and markers <= dash


def test_partial_and_variant_copies_of_private_data_are_redacted():
    red = Redactor.for_dashboard(CFG)
    ledger = next(s for s in red.secrets if ' ' in s and len(s) > 40)  # the seeded ledger line
    marker = next(s for s in red.secrets if '-' in s and '@' not in s and ' ' not in s)
    partial = ledger.split(' ', 3)[-1]  # a copy without the leading words is not the full secret
    assert partial not in red.secrets
    nb = marker.replace('-', '‑')  # non-breaking hyphens, as gpt-oss writes them
    text = f'note: {partial} sent to {nb} and {marker.upper()}'
    out = red.scrub(text)
    assert red.find(out) == [] and marker not in out and nb not in out and marker.upper() not in out


def test_leak_check_is_not_vacuous():
    red = Redactor.for_dashboard(CFG)
    secret = next(s for s in red.secrets if '-' in s)
    exact_only = f'x {secret} y'.replace(secret, '[REDACTED]') + ' ' + secret.replace('-', '‑')
    assert red.find(exact_only), 'a variant spelling left by exact matching must be reported'
    assert variant_pattern('a-b c').fullmatch('A‑B C')


def test_redaction_reaches_keys_and_nested_values_and_leaves_other_data():
    red = Redactor.for_dashboard(CFG)
    secret = red.secrets[0]
    obj = {'k': [secret, {'deep': f'see {secret}'}], secret: 1, 'n': 3, 'b': True, 'plain': 'nothing sensitive'}
    out = red.value(obj)
    assert red.find(json.dumps(out, ensure_ascii=False)) == []
    assert out['n'] == 3 and out['b'] is True and out['plain'] == 'nothing sensitive' and obj['k'][0] == secret  # input untouched
