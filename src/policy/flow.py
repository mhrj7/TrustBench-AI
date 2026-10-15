"""Provenance-aware flow check for free-text data arguments of write tools (configs/policy.yaml provenance_flow).

Capability rules (capabilities.py) already pin control arguments such as recipients and record IDs to the trusted task
contract. Free-text data arguments (a note answer, an email body) cannot be pinned, so injected content can ride inside
an otherwise authorized write. This check uses the provenance labels the gateway attaches to tool outputs:

  (a) a resource identifier that exists in the episode state but is not authorized by the trusted contract may not be
      written into a data argument (unauthorized resource reference), and
  (b) a marker/address token may not be written into a data argument when it was first seen in an untrusted tool output
      during this session and does not occur in the trusted contract (untrusted token flow).

Ordinary prose and values extracted from documents (words, numbers, dates) are not matched by these rules.
"""
import json
import re


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for inner in value.values():
            yield from _strings(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _strings(inner)


def _ids(value, suffix):
    if isinstance(value, dict):
        for key, inner in value.items():
            if key.endswith(suffix) and isinstance(inner, str):
                yield inner
            yield from _ids(inner, suffix)
    elif isinstance(value, list):
        for inner in value:
            yield from _ids(inner, suffix)


class FlowGuard:
    def __init__(self, policy, contract_json):
        self.cfg = policy['provenance_flow']
        self.patterns = {name: re.compile(p) for name, p in self.cfg['token_patterns'].items()}
        contract = json.loads(contract_json)
        self.trusted_values = set(_strings(contract))
        self.trusted_text = '\n'.join(self.trusted_values)
        self.untrusted_tokens = {}

    def observe(self, envelope):
        """Record marker/address tokens from tool outputs labelled untrusted or unknown."""
        if envelope['provenance']['trust'] not in self.cfg['untrusted_trust_levels']:
            return
        for text in _strings(envelope['payload']):
            for name, pattern in self.patterns.items():
                for token in pattern.findall(text):
                    self.untrusted_tokens.setdefault(token, name)

    def check(self, tool, arguments, state):
        """Returns None when allowed, otherwise a dict describing the violation."""
        fields = self.cfg['checked_arguments'].get(tool)
        if not fields:
            return None
        resource_ids = set(_ids(state, self.cfg['state_identifier_key_suffix'])) - self.trusted_values
        for field in fields:
            for text in _strings(arguments.get(field)):
                for rid in sorted(resource_ids):
                    if re.search(rf'(?<![\w-]){re.escape(rid)}(?![\w-])', text):
                        return {'rule': 'unauthorized_resource_reference', 'argument': field, 'token': rid}
                for name, pattern in self.patterns.items():
                    for token in pattern.findall(text):
                        if token in self.untrusted_tokens and token not in self.trusted_text:
                            return {'rule': 'untrusted_token_flow', 'argument': field, 'token': token, 'pattern': name}
        return None
