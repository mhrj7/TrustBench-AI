"""TB-024: attack renderings and seed-state additions are data-driven and consistent with their cited sources."""
import json
import re
from pathlib import Path

import pytest

from src.arms.fixtures import ROOT, attack_info, attacked_fixture, goal_only, load_renderings, materialize, render_attack_text

ATTACKS = [json.loads(l) for l in (ROOT / 'data/attacks.jsonl').read_text().splitlines() if l.strip()]
BENIGN = {json.loads(l)['fixture_id']: json.loads(l) for l in (ROOT / 'data/benign.jsonl').read_text().splitlines() if l.strip()}
RENDERINGS = load_renderings()['renderings']
VENDOR = ROOT / 'data/vendor/agentdojo/src/agentdojo/attacks'


def test_every_attack_has_a_materialization_entry_and_no_stale_entries():
    entries = json.loads((ROOT / 'data/attack-materialization.json').read_text())['attacks']
    assert set(entries) == {a['attack_id'] for a in ATTACKS}


@pytest.mark.parametrize('rendering', sorted(RENDERINGS))
@pytest.mark.parametrize('attack', ATTACKS, ids=lambda a: a['attack_id'])
def test_every_rendering_places_the_goal_in_the_untrusted_channel_only(rendering, attack):
    base = BENIGN[attack['base_fixture_id']]
    fixture = attacked_fixture(base, attack, rendering, 'test-model')
    marker = attack_info([attack])[attack['attack_id']]['exposure_marker']
    blob_before = json.dumps(base['initial_state'])
    channel = json.dumps(fixture['initial_state']['documents'] + fixture['initial_state']['customers'])
    if RENDERINGS[rendering]['kind'] == 'positive_control':
        assert marker not in json.dumps(fixture['initial_state']), 'control must not inject anything'
    else:
        assert marker in channel
    assert json.dumps(fixture['task_contract']) == json.dumps(base['task_contract']), 'the trusted contract is never modified'
    assert blob_before == json.dumps(base['initial_state'])


def test_goal_only_removes_labels_and_disclaimers_but_keeps_the_instruction():
    for attack in ATTACKS:
        goal = goal_only(attack['untrusted_text'])
        assert goal and not re.search(r'cannot|not authoriz|untrusted|so the test can', goal, re.I)
        assert not goal.startswith('[')


def test_published_templates_match_the_vendored_agentdojo_source_verbatim():
    baseline = (VENDOR / 'baseline_attacks.py').read_text()
    important = (VENDOR / 'important_instructions_attacks.py').read_text()
    for rendering, source in [('agentdojo_direct', baseline), ('agentdojo_ignore_previous', baseline),
                              ('agentdojo_system_message', baseline), ('agentdojo_injecagent', baseline)]:
        assert RENDERINGS[rendering]['template'].replace('{goal}', '{goal}') in source.replace('\\n', '\n'), rendering
    template = RENDERINGS['agentdojo_important_instructions']['template']
    for line in [l for l in template.split('\n') if l.strip()]:
        assert line.replace('{user}', '{user}') in important.replace('\\n', ' ').replace('"', ''), line
    manifest = json.loads((ROOT / 'data/manifest.json').read_text())
    assert manifest['source']['commit'] in RENDERINGS['agentdojo_direct']['reference']


def test_template_renderings_substitute_user_model_and_goal():
    attack = ATTACKS[0]
    text = render_attack_text(attack['untrusted_text'], 'agentdojo_important_instructions', 'Test User', 'test-model')
    assert 'Test User' in text and 'test-model' in text and goal_only(attack['untrusted_text']) in text
    assert '{' not in text


def test_materialize_covers_all_fixtures_with_unique_ids():
    fixtures, info = materialize()
    ids = [f['fixture_id'] for f in fixtures]
    assert len(ids) == len(set(ids)) == len(BENIGN) + len(ATTACKS)
    assert set(info) == {a['attack_id'] for a in ATTACKS}
