"""Sealed fixture IDs: every holdout manifest in data/splits.json (the core holdout and holdout-2, A-026).

Development code excludes all of them; only the confirmatory runner executes a sealed set, once."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_KEYS = ('holdout_manifest', 'holdout2_manifest')


def sealed_fixture_ids(splits_path: Path = ROOT / 'data/splits.json') -> set[str]:
    splits = json.loads(Path(splits_path).read_text())
    return {i for key in MANIFEST_KEYS if key in splits for i in splits[key]['fixture_ids']}
