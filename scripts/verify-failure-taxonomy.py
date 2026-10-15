import csv,hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
rows=list(csv.DictReader((root/'reports/failure-taxonomy.csv').open()))
report=json.loads((root/'reports/tb018-review-summary.json').read_text())
failures={r['run_id'] for r in map(json.loads,(root/'runs/baseline-pilot/outcomes.jsonl').read_text().splitlines()) if r['failure_records']}
failures.update(r['run_id'] for r in json.loads((root/'runs/baseline-pilot/preflight-failures.json').read_text())['failures'])
assert len(rows)==len(failures)==10
assert {r['run_id'] for r in rows}==failures
for row in rows:
 assert row['rationale_a'] and row['rationale_b'] and row['adjudication']
 expected=[]
 if row['reviewer_a']!=row['reviewer_b']:expected.append('category')
 if row['ambiguity_a']!=row['ambiguity_b']:expected.append('ambiguity')
 assert row['disagreements']==(';'.join(expected) or 'none')
 if row['ambiguous']=='True': assert row['alternative']
for path,digest in report['source_hashes'].items():
 assert hashlib.sha256((root/path).read_bytes()).hexdigest()==digest,path
assert report['primary_label_agreement']==sum(r['reviewer_a']==r['reviewer_b'] for r in rows)
assert report['ambiguity_agreement']==sum(r['ambiguity_a']==r['ambiguity_b'] for r in rows)
assert report['disagreement_cases']==sum(r['disagreements']!='none' for r in rows)
assert not report['holdout_reviewed'] and not report['original_pilot_metrics_changed']
assert json.loads((root/'reports/failure-review.ipynb').read_text())['nbformat']==4
print(json.dumps({'task':'TB-018','reviewed_failures':len(rows),'disagreements_retained':report['disagreement_cases'],'verified':True}))
