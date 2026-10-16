"""Deterministic failure localization (TB-029).

For a failed run, scan its tool trajectory against the task contract and report the first violated rule (configs/
localization.yaml). This names where the trajectory first left the contract; it does not establish that this step caused
the failure (a correlation with a tool step is not causality). A run no rule explains is reported as unattributed.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
_load = lambda p: json.loads((ROOT / p).read_text())
_TYPES = {'string': str, 'boolean': bool, 'array': list, 'object': dict, 'integer': int, 'number': (int, float)}


def _key(value: Any) -> Any:
    """Hashable form of a model-supplied argument; malformed (non-scalar) values never match a contract resource."""
    return value if isinstance(value, (str, int, float, bool)) or value is None else json.dumps(value, sort_keys=True)


def _norm(value: Any) -> str:
    return ' '.join(str(value).split()).casefold() if value is not None else ''


def _dig(obj: Any, path: list[str]) -> Any:
    for part in path:
        obj = obj[part]
    return obj


def _values_of(obj: Any, key: str) -> list[Any]:
    """Every value stored under `key` anywhere in a nested config."""
    if isinstance(obj, dict):
        return [v for k, v in obj.items() if k == key] + [x for v in obj.values() for x in _values_of(v, key)]
    if isinstance(obj, list):
        return [x for v in obj for x in _values_of(v, key)]
    return []


def _mentions(text: str, value: str) -> bool:
    """`value` occurs in `text` as a whole token (not inside a longer identifier)."""
    return bool(value) and re.search(r'(?<![\w-])' + re.escape(value) + r'(?![\w-])', text) is not None


def schema_violation(args: dict[str, Any], schema: dict[str, Any] | None) -> str | None:
    """Missing required fields, extra fields (when the schema forbids them) and wrong JSON types."""
    if not schema:
        return None
    props = schema.get('properties', {})
    missing = [k for k in schema.get('required', []) if k not in args]
    extra = [k for k in args if k not in props] if schema.get('additionalProperties') is False else []
    wrong = []
    for k, v in args.items():
        t = props.get(k, {}).get('type')
        if t in _TYPES and not (isinstance(v, _TYPES[t]) and not (t in ('integer', 'number') and isinstance(v, bool))):
            wrong.append(f'{k} is {type(v).__name__}, expected {t}')
        elif t == 'array' and isinstance(v, list) and props[k].get('items', {}).get('type') in _TYPES and not all(isinstance(x, _TYPES[props[k]['items']['type']]) for x in v):
            wrong.append(f'{k} items have the wrong type')
        # Size limits (minLength/maxLength, minItems/maxItems) on correctly typed values.
        spec = props.get(k, {})
        if isinstance(v, str) and t == 'string' and not (spec.get('minLength', 0) <= len(v) <= spec.get('maxLength', len(v))):
            wrong.append(f'{k} length {len(v)} outside [{spec.get("minLength", 0)}, {spec.get("maxLength", "inf")}]')
        if isinstance(v, list) and t == 'array' and not (spec.get('minItems', 0) <= len(v) <= spec.get('maxItems', len(v))):
            wrong.append(f'{k} has {len(v)} items, outside [{spec.get("minItems", 0)}, {spec.get("maxItems", "inf")}]')
    parts = ([f"missing {', '.join(missing)}"] if missing else []) + ([f"extra {', '.join(extra)}"] if extra else []) + wrong
    return '; '.join(parts) or None


class Contracts:
    """Task contracts, oracles, attack markers and tool schemas, read from the data and config files."""

    def __init__(self) -> None:
        self.cfg = _load('configs/localization.yaml')
        self.benign = {f['fixture_id']: f for f in map(json.loads, (ROOT / 'data/benign.jsonl').read_text().splitlines()) if f}
        self.attacks = {a['attack_id']: a for a in map(json.loads, (ROOT / 'data/attacks.jsonl').read_text().splitlines()) if a}
        self.oracles = _load('data/attack-oracles.json')['attacks']
        self.classes = _load('configs/recovery.yaml')['tool_classes']
        self.schemas = _load(self.cfg['schema_file'])['argument_schemas']
        self.possibly_executed = {_dig(_load(spec[0]), spec[1:]) for spec in self.cfg['possibly_executed_error_codes']['from_files']}
        denial = self.cfg['defense_denial_codes']
        self.denial_codes = set(denial['gateway_codes']) | {v for f in denial['denied_code_keys_in'] for v in _values_of(_load(f), denial['denied_code_key'])}
        self.denial_prefixes = tuple(denial['prefixes'])

    def is_defense_denial(self, error: str | None) -> bool:
        return bool(error) and (error in self.denial_codes or error.startswith(self.denial_prefixes))

    def executed(self, step: dict[str, Any]) -> bool:
        """A succeeded call changed state, unless it is a write the runtime answered from its ledger without running it
        (a suppressed exact duplicate, recorded with the configured attempts count)."""
        return step['status'] == 'succeeded' and not self.suppressed(step)

    def suppressed(self, step: dict[str, Any]) -> bool:
        return step['tool'] in self.classes['write'] and step.get('attempts') == self.cfg['suppressed_duplicate']['attempts']

    def for_case(self, fixture_id: str, attack_id: str | None) -> dict[str, Any]:
        task_id, _, attack_part = fixture_id.partition('--')
        attack_id = attack_id or attack_part or None
        fixture = self.benign[task_id]
        contract = dict(fixture['task_contract'])
        attack = self.attacks.get(attack_id) if attack_id else None
        if attack:
            contract['allowed_tools'] = attack['protected_contract'].get('allowed_tools', contract['allowed_tools'])
        markers: list[str] = []
        # A negative oracle rule (any value except the allowed ones) registers no attacker value; the attacker's value is
        # then a disallowed value of that argument that the attack text itself names.
        negative: list[dict[str, Any]] = []
        neg_cfg = self.cfg['negative_oracle_rules']
        for rule in self.oracles.get(attack_id, []) if attack_id else []:
            markers += rule.get('any_of', [])
            if rule['rule'] == 'succeeded_call_arg_equals' and isinstance(rule.get('value'), str):
                markers.append(rule['value'])
            if rule['rule'] in neg_cfg['rules'] and attack:
                ref = attack.get(neg_cfg['contract_field'], {})
                allowed_values = [ref.get(v['contract']) if isinstance(v, dict) and 'contract' in v else v for v in rule['allowed']]
                negative.append({'argument': rule['argument'], 'allowed': allowed_values, 'text': str(attack.get(neg_cfg['attack_text_field'], ''))})
        allowed = set()
        for f in self.cfg['allowed_resource_fields']['lists']:
            allowed.update(contract.get(f, []))
        for f in self.cfg['allowed_resource_fields']['single']:
            if contract.get(f):
                allowed.add(contract[f])
        evidence = {r for f in self.cfg['grounding_resource_fields'] for r in contract.get(f, [])}
        return {'task_id': task_id, 'attack_id': attack_id, 'contract': contract, 'oracle': fixture['oracle'], 'markers': [m for m in markers if m],
                'negative_markers': negative, 'allowed_resources': allowed, 'evidence_resources': evidence}


def _content_mismatch(tool: str, args: dict[str, Any], oracle: dict[str, Any]) -> str | None:
    kind = oracle.get('kind')
    if tool == 'save_research_note' and kind == 'research_note':
        if not isinstance(args.get('abstained'), bool):
            return None  # a non-boolean flag is a schema violation, never read as a value
        if args['abstained'] is not bool(oracle.get('abstained')):
            return 'abstention flag differs'
        if not oracle.get('abstained') and _norm(args.get('answer')) != _norm(oracle.get('answer')):
            return 'answer differs from the oracle answer'
        if sorted(map(str, args.get('citation_document_ids') or [])) != sorted(oracle.get('citation_document_ids', [])):
            return 'citations differ'
    if tool == 'create_email_draft' and kind == 'email_draft':
        missing = [f for f in oracle.get('required_body_fragments', []) if f not in str(args.get('body', ''))]
        if missing:
            return f'body lacks required evidence ({len(missing)} fragment(s))'
    return None


def localize(trace: list[dict[str, Any]], case_contract: dict[str, Any], contracts: Contracts, failed: dict[str, bool] | None = None,
             failures: list[str] | None = None) -> dict[str, Any]:
    """trace: [{tool, status, error, args}] in execution order; failed: {'utility': bool, 'security': bool}; failures: the
    run's failure codes (to recognise runtime termination). Returns the first violation, the first executed one, and per
    failed check the first violation that can explain it."""
    cfg, c, oracle = contracts.cfg, case_contract['contract'], case_contract['oracle']
    reads, writes = set(contracts.classes['read']), set(contracts.classes['write'])
    identity_tools = set(cfg['identity_arguments'])
    required = cfg['required_write_by_oracle_kind'].get(oracle.get('kind'))
    order = [r['id'] for r in cfg['step_rules']]
    findings: list[dict[str, Any]] = []
    grounded = False
    for i, step in enumerate(trace):
        tool, args = step['tool'], step.get('args') or {}
        executed = contracts.executed(step)
        possibly = executed or (not contracts.suppressed(step) and step.get('error') in contracts.possibly_executed)
        hits: list[tuple[str, str]] = []
        if tool in writes or tool in identity_tools:
            text = json.dumps(args, sort_keys=True)
            found = [m for m in case_contract['markers'] if m in text]
            found += [str(args[n['argument']]) for n in case_contract.get('negative_markers', [])
                      if n['argument'] in cfg['identity_arguments'].get(tool, {}) and isinstance(args.get(n['argument']), str)
                      and args[n['argument']] not in n['allowed'] and _mentions(n['text'], args[n['argument']])]
            if found:
                hits.append(('write_carries_attacker_value', found[0]))
        if tool not in c.get('allowed_tools', []):
            hits.append(('tool_outside_contract', tool))
        if tool in reads and cfg['resource_argument'] in args and _key(args[cfg['resource_argument']]) not in case_contract['allowed_resources'] and tool != 'search_documents':
            hits.append(('resource_outside_contract', str(_key(args[cfg['resource_argument']]))[:120]))
        malformed = schema_violation(args, contracts.schemas.get(tool))
        if malformed:
            hits.append(('write_malformed_arguments', malformed))
        if tool in cfg['identity_arguments']:
            bad = [a for a, key in cfg['identity_arguments'][tool].items() if key in c and args.get(a) != c[key]]
            if bad:
                hits.append(('write_identity_mismatch', ','.join(bad)))
        if tool == required and tool in cfg['grounding_required_for'] and case_contract['evidence_resources'] and not grounded:
            hits.append(('write_before_grounding', 'no successful read of the task evidence yet'))
        if tool in writes:
            mismatch = _content_mismatch(tool, args, oracle)
            if mismatch:
                hits.append(('write_content_mismatch', mismatch))
        if not hits and step['status'] != 'succeeded' and contracts.is_defense_denial(step.get('error')):
            hits.append(('call_denied_by_defense', step['error']))  # the call broke no rule; the defense refused it
        for rule, detail in sorted(hits, key=lambda h: order.index(h[0])):
            findings.append({'rule': rule, 'step': i, 'tool': tool, 'executed': executed, 'possibly_executed': possibly, 'error': step.get('error'), 'detail': detail,
                             'unlisted_write': rule == 'tool_outside_contract' and tool in writes})
        if executed and tool in reads and _key(args.get(cfg['resource_argument'])) in case_contract['evidence_resources']:
            grounded = True
    ok_write = any(s['tool'] == required and contracts.executed(s)
                   and all((s.get('args') or {}).get(a) == c[key] for a, key in cfg['identity_arguments'].get(required, {}).items() if key in c) for s in trace)
    if required and not ok_write:
        codes = set(failures or [])
        term = [code for code in cfg['termination_failure_codes']['codes'] if code in codes]
        attempts = [s for s in trace if s['tool'] == required]
        # Under the step limit, steps spent on off-contract calls (tools or resources; executed or blocked: both consume steps)
        # or on repeating an identical call with no progress afterwards explain why the required write never happened; the
        # earliest such step is reported. Progress is a successful call not made before; a repeat the agent moved on from
        # did not stall the run.
        off_rules = set(cfg['budget_off_contract_rules'])
        off = next((f for f in findings if f['rule'] in off_rules), None)
        seen, repeats, last_progress = set(), [], -1
        for i, st in enumerate(trace):
            key = (st['tool'], json.dumps(st.get('args'), sort_keys=True))
            if key in seen:
                repeats.append(i)
                continue
            seen.add(key)
            if st['status'] == 'succeeded':
                last_progress = i
        repeat = next((i for i in repeats if i > last_progress), None)
        budget = []
        if cfg['termination_failure_codes']['step_limit_code'] in codes:
            if off is not None:
                budget.append((off['step'], 0, 'step_budget_spent_off_contract', off['tool'], 'step limit reached without the required write after off-contract calls'))
            if repeat is not None:
                budget.append((repeat, 1, 'no_progress_repetition', trace[repeat]['tool'], 'step limit reached without the required write after repeating an identical call'))
        if budget:
            step, _, rule, tool, detail = min(budget)
            findings.append({'rule': rule, 'step': step, 'tool': tool, 'executed': True, 'possibly_executed': True, 'error': None, 'detail': detail, 'unlisted_write': False})
        elif term:
            findings.append({'rule': 'run_terminated', 'step': len(trace), 'tool': required, 'executed': False, 'possibly_executed': False, 'error': term[0],
                             'detail': f'cut off by {term[0]} after {len(attempts)} attempt(s) of the required write', 'unlisted_write': False})
        else:
            findings.append({'rule': 'required_write_missing', 'step': len(trace), 'tool': required, 'executed': False, 'possibly_executed': False,
                             'error': attempts[-1].get('error') if attempts else None,
                             'detail': f'{len(attempts)} attempt(s), none succeeded with the contract identity' if attempts else 'never attempted', 'unlisted_write': False})
    final_write = max((i for i, st in enumerate(trace) if st['tool'] == required
                       and (contracts.executed(st) or (not contracts.suppressed(st) and st.get('error') in contracts.possibly_executed))
                       and all((st.get('args') or {}).get(a) == c[key] for a, key in cfg['identity_arguments'].get(required, {}).items() if key in c)), default=-1)
    step_findings = sorted((f for f in findings if f['rule'] not in {r['id'] for r in cfg['terminal_rules']}), key=lambda f: f['step'])
    first = step_findings[0] if step_findings else (findings[0] if findings else None)
    first_executed = next((f for f in step_findings if f['executed']), None)
    explaining = {}
    for check, failed_check in (failed or {}).items():
        if not failed_check:
            continue
        spec = cfg['explains'][check]
        def explains(f: dict[str, Any]) -> bool:
            if check == 'utility':
                if f['tool'] == required and f['executed'] and f['rule'] in spec.get('overwritten_write_rules', []) and f['step'] < final_write:
                    return False  # overwritten by a later committed write of the required kind, which determines the final state
                if f['rule'] in spec.get('denied_required_write_rules', []) and (f['tool'] != required or f['step'] < final_write):
                    return False  # a denied conformant call explains utility only as the required write, with none committed later
                if f['rule'] in spec.get('contract_tools_only_rules', []) and f['tool'] not in c.get('allowed_tools', []):
                    return False  # a malformed or mismatched call to a tool outside the task does not leave the task's state wrong
                return f['rule'] in spec['rules'] or (spec.get('executed_unlisted_writes_explain') and f['unlisted_write'] and f['executed'])
            happened = f['possibly_executed'] if spec.get('possibly_executed_counts') else f['executed']
            return f['rule'] in spec['rules'] and happened
        # Step-level explanations (in step order) come before terminal ones, which are only a fallback.
        explaining[check] = next((f for f in findings if explains(f)), None)
    return {'first_violation': first, 'first_executed_violation': first_executed, 'explaining': explaining, 'violations': findings,
            'attributed': first is not None}
