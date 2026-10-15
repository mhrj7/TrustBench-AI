"""Collection-time check: every declared invariant needs a positive and a negative test."""
import json
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
INVARIANTS = json.loads((ROOT / 'fixtures/policy/invariants.json').read_text())['invariants']

def pytest_configure(config):
    config.addinivalue_line('markers', 'invariant(id, kind): test covers a declared security invariant (kind: positive|negative)')

def pytest_collection_modifyitems(config, items):
    policy_items = [i for i in items if 'tests/policy' in str(i.fspath).replace('\\', '/')]
    if not policy_items:
        return
    seen = {}
    for item in policy_items:
        for mark in item.iter_markers('invariant'):
            inv, kind = mark.args
            if inv not in INVARIANTS:
                raise pytest.UsageError(f'{item.nodeid} references undeclared invariant {inv}')
            if kind not in ('positive', 'negative'):
                raise pytest.UsageError(f'{item.nodeid} has invalid kind {kind}')
            seen.setdefault(inv, set()).add(kind)
    coverage = {inv: {'statement': text, 'positive': [], 'negative': []} for inv, text in INVARIANTS.items()}
    for item in policy_items:
        for mark in item.iter_markers('invariant'):
            coverage[mark.args[0]][mark.args[1]].append(item.nodeid)
    (ROOT / 'reports/policy-invariant-coverage.json').write_text(json.dumps(coverage, indent=2, sort_keys=True) + '\n')
    missing = [f'{inv}:{kind}' for inv in INVARIANTS for kind in ('positive', 'negative') if kind not in seen.get(inv, set())]
    if missing:
        raise pytest.UsageError('invariants lacking tests: ' + ', '.join(missing))
