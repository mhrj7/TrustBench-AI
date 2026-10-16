"""TB-029 review UI: labels are stored only for the exact prediction shown, with a reviewer."""
import json

from fastapi.testclient import TestClient

import src.review.app as review


def test_label_round_trip_and_rejections(tmp_path, monkeypatch):
    monkeypatch.setitem(review.CFG, 'review_file', str(tmp_path / 'reviews.jsonl'))
    client = TestClient(review.app)
    case = review.sample()[0]['row']
    assert client.get('/').status_code == 200 and case['case_id'] in client.get('/?i=0').text
    checks = [k for k, _ in review.attributions(review.sample()[0])]
    ok = {'run_id': case['run_id'], 'prediction_sha256': case['prediction_sha256'], 'reviewer': 'tester', 'i': '0', **{f'label_{k}': 'correct' for k in checks}}
    assert client.post('/label', json=ok).status_code == 200
    for bad in ({**ok, 'prediction_sha256': 'stale'}, {**ok, 'run_id': 'nope'}, {**ok, f'label_{checks[0]}': 'maybe'}, {**ok, 'reviewer': ' '}):
        assert client.post('/label', json=bad).status_code == 400
    lines = [json.loads(l) for l in (tmp_path / 'reviews.jsonl').read_text().splitlines()]
    assert [l['check'] for l in lines] == checks and all(l['label'] == 'correct' and l['reviewer_type'] == 'human' for l in lines)
    assert '(1/' in client.get('/').text, 'progress counts the stored label'
