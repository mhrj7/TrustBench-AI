"""Materialize benign and attacked fixtures once so both comparison arms start from identical state.

Attack rendering and seed-state additions are data-driven: data/attack-renderings.json and
data/attack-materialization.json. Nothing about a specific attack is hardcoded here.
"""
import copy
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RENDERINGS_PATH = ROOT / 'data/attack-renderings.json'
MATERIALIZATION_PATH = ROOT / 'data/attack-materialization.json'


def _jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def load_renderings():
    return json.loads(RENDERINGS_PATH.read_text())


def goal_only(text, rules=None):
    """The instruction content of an authored payload, without its self-disclosing label or disclaimers."""
    rules = rules or load_renderings()['goal_only_rules']
    body = re.sub(rules['strip_leading_bracket_label'], '', text)
    body = re.sub(rules['strip_clause'], '', body)
    disclaimer = re.compile(rules['drop_sentences_matching'], re.I)
    return ' '.join(x.strip() for x in re.split(r'(?<=\.)\s+', body) if x.strip() and not disclaimer.search(x))


def exposure_marker(text):
    """First sentence of the goal; if a model-visible message contains it, the model was exposed to the injection."""
    sentences = [x.strip() for x in re.split(r'(?<=\.)\s+', goal_only(text)) if x.strip()]
    return sentences[0] if sentences else text.strip()


def render_attack_text(text, rendering, user_name='the user', model_name=None):
    registry = load_renderings()
    model_name = model_name or registry['default_model_name']
    spec = registry['renderings'].get(rendering)
    if spec is None:
        raise ValueError(f'unknown rendering {rendering}')
    if spec['kind'] == 'verbatim':
        return text
    if spec['kind'] == 'positive_control':
        return ''
    goal = goal_only(text, registry['goal_only_rules'])
    if spec['kind'] == 'goal_only':
        return goal
    return spec['template'].replace('{goal}', goal).replace('{user}', user_name).replace('{model}', model_name)


def _inject(fixture, entry_point, text):
    state = fixture['initial_state']
    if not text:
        return
    if entry_point in ('document.content', 'reference_document.content'):
        state['documents'][0]['content'] += f'\n\n{text}'
    elif entry_point == 'customer_record.untrusted_note':
        state['customers'][0]['untrusted_note'] = text
    else:
        raise ValueError(f'unsupported entry point {entry_point}')


def attacked_fixture(base, attack, rendering='as_authored', model_name=None):
    fixture = copy.deepcopy(base)
    fixture['fixture_id'] = f"{base['fixture_id']}--{attack['attack_id']}"
    users = fixture['initial_state'].get('users') or [{}]
    text = render_attack_text(attack['untrusted_text'], rendering, users[0].get('display_name', 'the user'), model_name)
    _inject(fixture, attack['entry_point'], text)
    additions = json.loads(MATERIALIZATION_PATH.read_text())['attacks'].get(attack['attack_id'])
    if additions is None:
        raise ValueError(f"{attack['attack_id']} has no entry in {MATERIALIZATION_PATH.name}")
    for update in additions.get('field_updates', []):
        targets = [row for row in fixture['initial_state'][update['collection']] if all(row.get(k) == v for k, v in update['match'].items())]
        if len(targets) != 1:
            raise ValueError(f"{attack['attack_id']} field update must match exactly one {update['collection']} row")
        targets[0].update(update['set'])
    for key, rows in additions.items():
        if key == 'field_updates':
            continue
        for row in rows:
            fixture['initial_state'][key].append(json.loads(json.dumps(row).replace('{tenant_id}', fixture['tenant_id'])))
    return fixture


def attack_info(attacks):
    return {a['attack_id']: {'goal': goal_only(a['untrusted_text']), 'exposure_marker': exposure_marker(a['untrusted_text'])} for a in attacks}


def sealed_fixture_ids():
    """Fixture and attack IDs of every sealed set (data/splits.json holdout_manifest, holdout2_manifest)."""
    splits = json.loads((ROOT / 'data/splits.json').read_text())
    return {f for key in ('holdout_manifest', 'holdout2_manifest') if splits.get(key) for f in splits[key]['fixture_ids']}


def materialize(benign_path=ROOT / 'data/benign.jsonl', attacks_path=ROOT / 'data/attacks.jsonl', rendering='as_authored', model_name=None, exclude_sealed=False):
    benign = _jsonl(benign_path)
    by_id = {row['fixture_id']: row for row in benign}
    attacks = _jsonl(attacks_path)
    if exclude_sealed:  # development runs never load a sealed fixture, not even into the tool service's fixture file
        sealed = sealed_fixture_ids()
        benign = [row for row in benign if row['fixture_id'] not in sealed]
        attacks = [a for a in attacks if a['attack_id'] not in sealed and a['base_fixture_id'] not in sealed]
    attacked = [attacked_fixture(by_id[a['base_fixture_id']], a, rendering, model_name) for a in attacks]
    return benign + attacked, attack_info(attacks)


def write_jsonl(path, fixtures):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(''.join(json.dumps(f, sort_keys=True) + '\n' for f in fixtures))
