"""TB-030 view logic on hand-built runs: counts, intervals, invalid and kind rules, evidence rows, policy sources."""
from app import views

METRICS = {'utility_pass': {'label': 'U', 'field': 'utility_pass', 'kinds': None},
           'attacker_goal': {'label': 'A', 'field': 'attacker_goal', 'kinds': ['attack']}}


def run(i, system, kind, util, goal, invalid=False, policy=(), errors=()):
    return {'run_id': f'r{i}', 'system': system, 'model': 'm', 'kind': kind, 'utility_pass': util, 'attacker_goal': goal, 'invalid': invalid,
            'case_id': f'c{i}', 'repetition': 1, 'arm': 'defended', 'outcome': 'success', 'report': 'rep.json', 'report_sha256': 'f' * 64,
            'pointer': f'/cases/{i}/defended', 'policy': [list(p) for p in policy], 'trace_errors': [list(e) for e in errors]}


RUNS = [run(0, 'a', 'benign', True, False), run(1, 'a', 'attack', False, True), run(2, 'a', 'attack', True, False),
        run(3, 'a', 'attack', True, True, invalid=True), run(4, 'b', 'benign', False, False,
        policy=[('t', 'deny', 'tool_not_allowed'), ('t', 'deny', 'tool_not_allowed')], errors=[('t', 'tool_not_allowed'), ('t', 'tool_service_error')])]


def test_aggregate_counts_lists_ids_and_excludes_invalid_and_wrong_kinds():
    rows = {r['key']['system']: r for r in views.aggregate(RUNS, ['system'], METRICS, 1.96)}
    a = rows['a']
    assert a['runs'] == 4 and a['invalid_ids'] == ['r3']
    assert (a['metrics']['utility_pass']['k'], a['metrics']['utility_pass']['n']) == (2, 3)
    assert sorted(a['metrics']['utility_pass']['hit_ids']) == ['r0', 'r2'] and a['metrics']['utility_pass']['miss_ids'] == ['r1']
    assert (a['metrics']['attacker_goal']['k'], a['metrics']['attacker_goal']['n']) == (1, 2)  # benign r0 and invalid r3 not counted
    assert rows['b']['metrics']['attacker_goal']['n'] == 0 and rows['b']['metrics']['attacker_goal']['ci'] is None


def test_wilson_interval():
    lo, hi = views.wilson(2, 3, 1.959963984540054)
    assert round(lo, 4) == 0.2077 and round(hi, 4) == 0.9385 and views.wilson(0, 0, 1.96) is None


def test_evidence_rows_say_how_each_run_counted():
    g = next(r for r in views.aggregate(RUNS, ['system'], METRICS, 1.96) if r['key']['system'] == 'a')
    rows = {r['run_id']: r for r in views.evidence_rows(g, {r['run_id']: r for r in RUNS}, g['metrics'])}
    assert rows['r1']['utility_pass'] == 'counted: no' and rows['r1']['attacker_goal'] == 'counted: yes'
    assert rows['r0']['attacker_goal'] == 'not counted' and rows['r3']['utility_pass'] == 'not counted'
    assert rows['r0']['pointer'] == '/cases/0/defended'


def test_filters_drop_invalid_unless_asked():
    assert [r['run_id'] for r in views.apply_filters(RUNS, {'system': ['a']})] == ['r0', 'r1', 'r2']
    assert len(views.apply_filters(RUNS, {'system': ['a']}, include_invalid=True)) == 4


def test_policy_sources_count_gateway_decisions_and_agent_side_denials_separately():
    gw = views.policy_reasons(RUNS, ['system'], 'gateway')
    assert gw == [{'key': {'system': 'b', 'decision': 'deny', 'reason': 'tool_not_allowed'}, 'count': 2, 'run_ids': ['r4']}]
    agent = views.policy_reasons(RUNS, ['system'], 'agent', lambda e: e == 'tool_not_allowed')
    assert agent == [{'key': {'system': 'b', 'decision': 'denied', 'reason': 'tool_not_allowed'}, 'count': 1, 'run_ids': ['r4']}]


def test_step_rows_use_the_error_the_agent_received_and_mark_attribution():
    record = {'run': {'tool_trace': [{'tool': 'read', 'status': 'succeeded', 'error': None, 'args': {}},
                                     {'tool': 'write', 'status': 'failed', 'error': 'untrusted_flow:x', 'attempts': 1, 'args': {'a': 1}}],
                      'policy_decisions': [{'seq': 0, 'tool': 'write', 'decision': 'deny', 'reason': 'untrusted_flow:x'}]}}
    rows = views.step_rows(record, {'first_step': 1, 'utility_step': 1, 'security_step': None}, lambda e: e.startswith('untrusted_flow:'))
    assert rows[1]['error / policy reason'] == 'untrusted_flow:x' and rows[1]['defense denial'] is True
    assert rows[1]['attribution'] == 'first violation, utility attribution' and rows[0]['attribution'] is None
    assert views.gateway_rows(record)[0]['reason'] == 'untrusted_flow:x'
