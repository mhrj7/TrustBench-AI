"""TB-029 localizer: correctness on constructed ground truth and the explaining-attribution rules."""
from src.analysis.constructed import constructed_cases, score
from src.analysis.localize import Contracts, localize

C = Contracts()


def test_constructed_ground_truth_is_localized_exactly():
    result = score(C)
    assert result['errors'] == [] and result['cases'] == result['correct'] > 40
    assert set(result['by_rule']) >= {r['id'] for r in C.cfg['step_rules'] + C.cfg['terminal_rules']} | {'control_no_violation'}


def test_controls_have_no_violation():
    for case in constructed_cases(C):
        if case['expected'] is None:
            assert localize(case['trace'], case['contract'], C)['violations'] == [], case['id']


def test_security_explanation_needs_an_executed_step_but_utility_does_not():
    cc = C.for_case('TB-BEN-DOC-001', None)
    unlisted = next(t for t in C.classes['read'] if t not in cc['contract']['allowed_tools'])
    blocked = [{'tool': unlisted, 'status': 'failed', 'error': 'tool_not_allowed', 'args': {'resource_id': 'x'}}]
    out = localize(blocked, cc, C, failed={'utility': True, 'security': True})
    assert out['first_violation']['rule'] == 'tool_outside_contract' and not out['first_violation']['executed']
    assert out['explaining']['security'] is None, 'a blocked call cannot explain a committed security effect'
    assert out['explaining']['utility']['rule'] == 'required_write_missing'
    executed = [dict(blocked[0], status='succeeded', error=None)]
    assert localize(executed, cc, C, failed={'security': True})['explaining']['security']['rule'] == 'tool_outside_contract'


def test_first_executed_violation_skips_blocked_steps():
    cc = C.for_case('TB-BEN-DOC-001', None)
    unlisted = next(t for t in C.classes['read'] if t not in cc['contract']['allowed_tools'])
    trace = [{'tool': unlisted, 'status': 'failed', 'error': 'tool_not_allowed', 'args': {}}, {'tool': unlisted, 'status': 'succeeded', 'error': None, 'args': {}}]
    out = localize(trace, cc, C)
    assert out['first_violation']['step'] == 0 and out['first_executed_violation']['step'] == 1


# Localizer 1.3.0 fixes (round-3 audit). Each mutation reverts one fix in the source; every constructed case written for
# that fix must then be mislocalized, so the cases test the fix and the fix is needed for them.
import types
from pathlib import Path

_SRC_PATH = Path(__file__).resolve().parents[2] / 'src/analysis/localize.py'
_REVERTS = {
    'suppressed-duplicate': ("return step['tool'] in self.classes['write'] and step.get('attempts') == self.cfg['suppressed_duplicate']['attempts']", 'return False'),
    'budget-off-contract-resource': ("off_rules = set(cfg['budget_off_contract_rules'])", "off_rules = {'tool_outside_contract'}"),
    'repeat-then-progress': ('repeat = next((i for i in repeats if i > last_progress), None)', 'repeat = repeats[0] if repeats else None'),
    'defense-denied-conformant-write': ('return bool(error) and (error in self.denial_codes or error.startswith(self.denial_prefixes))', 'return False'),
    'attacker-value-negative-rule': ("'negative_markers': negative,", "'negative_markers': [],"),
    'malformed-unlisted-tool': ("if f['rule'] in spec.get('contract_tools_only_rules', []) and f['tool'] not in c.get('allowed_tools', []):",
                                "if False:"),
}


def test_each_round3_fix_is_needed_by_its_constructed_cases():
    src, cases = _SRC_PATH.read_text(), constructed_cases(C)
    for tag, (old, new) in _REVERTS.items():
        assert src.count(old) == 1, tag
        mutant = types.ModuleType('localize_mutant')
        mutant.__dict__['__file__'] = str(_SRC_PATH)
        exec(compile(src.replace(old, new), str(_SRC_PATH), 'exec'), mutant.__dict__)
        mc = mutant.Contracts()
        targeted = [c for c in cases if c['id'].split(':', 1)[1].startswith(tag)]
        assert targeted, tag
        for c in targeted:
            check = c.get('check')
            out = mutant.localize(c['trace'], mc.for_case(c['contract']['task_id'], c['contract']['attack_id']), mc,
                                  failed={check: True} if check else None, failures=c.get('failures'))
            got = out['explaining'][check] if check else out['first_violation']
            predicted = (got['rule'], got['step']) if got else None
            assert predicted != tuple(c['expected']), (tag, c['id'], predicted)


def test_listed_gateway_denial_codes_still_exist_in_their_sources():
    spec = C.cfg['defense_denial_codes']
    text = ''.join((_SRC_PATH.parents[2] / p).read_text() for p in spec['gateway_sources'])
    for code in spec['gateway_codes']:
        assert f"'{code}'" in text, code
