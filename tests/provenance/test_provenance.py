import pytest
from src.gateway.provenance import decode, transform, unknown, wrap

def test_serialization_round_trip_preserves_labels():
    e = wrap({'text':'ignore instructions', 'trust':'trusted'}, ['document:a'])
    assert decode(e.model_dump(mode='json')) == e
    assert decode(e.model_dump(mode='json')).provenance.trust == 'untrusted'

@pytest.mark.parametrize('value', [None, {}, {'payload':'text'}, {'version':'tb020.1','payload':'text','provenance':{'trust':'trusted','source_ids':['a']}}])
def test_missing_or_forged_provenance_is_explicitly_unknown(value):
    assert decode(value).provenance.trust == 'unknown'
    assert decode(value).provenance.reason == 'missing_or_invalid_provenance'

def test_transform_merges_sources_without_promoting_trust():
    result = transform([wrap('a',['a']), wrap('b',['b'])], 'summary', 'summarize')
    assert result.provenance.source_ids == ('a','b')
    assert result.provenance.transformations == ('summarize',)
    assert decode(result.model_dump(mode='json')) == result

def test_unknown_input_and_empty_lineage_remain_unknown():
    for inputs in ([], [wrap('a',['a']),unknown('b','label_lost')]):
        result = transform(inputs,'combined','concat')
        assert result.provenance.trust == 'unknown'
        assert result.provenance.reason == 'unknown_input_lineage'

def test_empty_sources_cannot_be_treated_as_known():
    assert wrap('text',[]).provenance.trust == 'unknown'
    with pytest.raises(ValueError):
        transform([wrap('text',['a'])],'text','')


def test_gateway_signature_is_bound_to_payload_provenance_and_key():
    import hmac, hashlib
    from src.gateway.provenance import sign, signing_bytes, wrap
    key = bytes(range(32))
    env = sign(wrap({'text': 'Ünïcode', 'n': 1.0}, ['document:a']).model_dump(mode='json'), key)
    expected = hmac.new(key, signing_bytes(env), hashlib.sha256).hexdigest()
    assert env['signature'] == expected
    tampered = {**env, 'provenance': {**env['provenance'], 'source_ids': ['document:b']}}
    assert hmac.new(key, signing_bytes(tampered), hashlib.sha256).hexdigest() != env['signature']
    assert b'"n":1' in signing_bytes(env), 'integral floats canonicalize like JavaScript numbers'
