"""Payload redaction for the review dashboard (TB-030).

The sensitive set is the one TB-027 uses for spans (src/observability/tracing.ts, sensitiveValues): every string of the
attack seed-state additions and the named benign fixture fields, read from the data files in configs/observability.yaml.
Sealed holdout fixtures are never read. tests/app/test_redact.py checks this port against the TypeScript builder."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def sensitive_values(cfg: dict[str, Any] | None = None) -> list[str]:
    cfg = cfg or json.loads((ROOT / 'configs/observability.yaml').read_text())
    s, out = cfg['sensitive_values'], set()

    def walk(v: Any, key: str = '') -> None:
        if isinstance(v, str):
            if key not in s['attack_seed_skip_keys'] and '{' not in v and len(v) >= s['min_length']:
                out.add(v)
        elif isinstance(v, list):
            for x in v:
                walk(x, key)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)

    holdout = set(json.loads((ROOT / 'data/splits.json').read_text())['holdout_manifest']['fixture_ids'])
    for attack_id, add in json.loads((ROOT / s['attack_seed_file']).read_text())['attacks'].items():
        if attack_id not in holdout:
            walk(add)
    for line in (ROOT / s['benign_file']).read_text().strip().splitlines():
        fixture = json.loads(line)
        if fixture['fixture_id'] in holdout:
            continue
        state = fixture.get('initial_state') or {}
        for collection, fields in s['benign_fields'].items():
            for row in state.get(collection, []):
                for f in fields:
                    if isinstance(row.get(f), str) and len(row[f]) >= s['min_length']:
                        out.add(row[f])
    return sorted(out, key=lambda x: (-len(x), x))  # longest first, so overlapping values are fully replaced


def _strings(obj: Any) -> set[str]:
    if isinstance(obj, str):
        return {obj}
    if isinstance(obj, list):
        return {s for x in obj for s in _strings(x)}
    if isinstance(obj, dict):
        return {s for x in obj.values() for s in _strings(x)}
    return set()


def dashboard_secrets(dash_cfg: dict[str, Any]) -> list[str]:
    """The payload redaction set (configs/dashboard.yaml, redaction): TB-027 values not named by any trusted task contract,
    plus the oracle markers of private-data effects."""
    holdout = set(json.loads((ROOT / 'data/splits.json').read_text())['holdout_manifest']['fixture_ids'])
    contract: set[str] = set()
    for line in (ROOT / 'data/benign.jsonl').read_text().strip().splitlines():
        f = json.loads(line)
        if f['fixture_id'] not in holdout:
            contract |= _strings(f.get('task_contract'))
    attacks = [json.loads(l) for l in (ROOT / 'data/attacks.jsonl').read_text().splitlines() if l.strip()]
    for a in attacks:
        if a['attack_id'] not in holdout:
            contract |= _strings(a.get('protected_contract'))
    obs = json.loads((ROOT / dash_cfg['redaction']['config']).read_text())
    keep = [v for v in sensitive_values(obs) if v not in contract]
    effects = set(dash_cfg['redaction']['private_data_effects'])
    oracles = json.loads((ROOT / 'data/attack-oracles.json').read_text())['attacks']
    markers = {m for attack_id, rules in oracles.items() if attack_id not in holdout
               for r in rules if r.get('effect') in effects for m in r.get('any_of', [])}
    return sorted(set(keep) | markers, key=lambda x: (-len(x), x))


_DASHES = '-‐‑‒–—−﹣－'
_SPACES = '      '


def variant_pattern(secret: str) -> re.Pattern[str]:
    """Matches secret case-insensitively with any Unicode dash for '-' and any space variant for ' ': models rewrite
    hyphens as non-breaking hyphens (U+2011) and spaces as narrow no-break spaces, which exact matching misses."""
    parts = []
    for ch in secret:
        parts.append(f'[{re.escape(_DASHES)}]' if ch == '-' else f'[{re.escape(_SPACES)}]' if ch == ' ' else re.escape(ch))
    return re.compile(''.join(parts), re.IGNORECASE)


class Redactor:
    def __init__(self, secrets: list[str], placeholder: str) -> None:
        self.secrets, self.placeholder, self.replaced = secrets, placeholder, 0
        self.patterns = [variant_pattern(s) for s in secrets]  # secrets are longest first

    def find(self, text: str) -> list[str]:
        """The secrets that occur in text, in any variant spelling."""
        return [s for s, p in zip(self.secrets, self.patterns) if p.search(text)]

    @classmethod
    def for_dashboard(cls, dash_cfg: dict[str, Any]) -> 'Redactor':
        obs = json.loads((ROOT / dash_cfg['redaction']['config']).read_text())
        return cls(dashboard_secrets(dash_cfg), obs['redaction_placeholder'])

    def scrub(self, text: str) -> str:
        for pattern in self.patterns:
            text, n = pattern.subn(self.placeholder, text)
            self.replaced += bool(n)
        return text

    def value(self, obj: Any) -> Any:
        """A deep copy of obj with every string (keys included) scrubbed."""
        if isinstance(obj, str):
            return self.scrub(obj)
        if isinstance(obj, list):
            return [self.value(x) for x in obj]
        if isinstance(obj, dict):
            return {self.scrub(k) if isinstance(k, str) else k: self.value(v) for k, v in obj.items()}
        return obj
