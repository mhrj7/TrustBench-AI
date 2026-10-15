"""Merge authored reviews; never generate or modify reviewer judgments."""
import csv, hashlib, json
from collections import Counter
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
REPORTS=ROOT/'reports'
a=json.loads((REPORTS/'tb018-reviewer-a.json').read_text())['reviews']
b={x['run_id']:x for x in json.loads((REPORTS/'tb018-reviewer-b.json').read_text())['reviews']}
assert len(a)==len(b)==10
rows=[]
for first in a:
 second=b[first['run_id']]
 disagreement=[]
 if first['category']!=second['category']: disagreement.append('category')
 if first['ambiguous']!=second['ambiguous']: disagreement.append('ambiguity')
 rows.append(dict(run_id=first['run_id'], reviewer_a=first['category'],reviewer_b=second['category'],
    ambiguity_a=first['ambiguous'],ambiguity_b=second['ambiguous'],
    disagreements=';'.join(disagreement) or 'none',final_category=first['category'],
    ambiguous=first['ambiguous'] or second['ambiguous'],alternative=first['alternative_category'] or second.get('alternative_category') or '',
    adjudication=('Retain format/specification ambiguity alongside the agreed evaluator-error label; no score changes.' if first['category']=='evaluator_error' else
                  'Retain model decision error as primary and evaluator mismatch as co-occurring ambiguity.' if first['category']=='model_reasoning' else
                  'Both reviewers agree; classify from preflight metadata only, not a reconstructed raw trajectory.'),
    rationale_a=first['rationale'],rationale_b=second['rationale'],evidence=first['evidence']))
with (REPORTS/'failure-taxonomy.csv').open('w',newline='') as f:
 writer=csv.DictWriter(f,fieldnames=list(rows[0]),lineterminator='\n');writer.writeheader();writer.writerows(rows)
paths=['reports/tb018-reviewer-a.json','reports/tb018-reviewer-b.json','reports/failure-taxonomy.csv','runs/baseline-pilot/raw-runs.jsonl','runs/baseline-pilot/outcomes.jsonl','runs/baseline-pilot/preflight-failures.json']
summary=dict(task_id='TB-018',reviewer_kind='two AI reviewers, not humans',cases=len(rows),
 primary_label_agreement=sum(r['reviewer_a']==r['reviewer_b'] for r in rows),
 ambiguity_agreement=sum(r['ambiguity_a']==r['ambiguity_b'] for r in rows),
 disagreement_cases=sum(r['disagreements']!='none' for r in rows),
 final_categories=dict(Counter(r['final_category'] for r in rows)),
 source_hashes={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths},
 original_pilot_metrics_changed=False,holdout_reviewed=False)
(REPORTS/'tb018-review-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
notebook={'nbformat':4,'nbformat_minor':5,'metadata':{'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'}},'cells':[
 {'cell_type':'markdown','id':'review-method','metadata':{},'source':(REPORTS/'failure-taxonomy.md').read_text().splitlines(keepends=True)},
 {'cell_type':'code','id':'review-table','metadata':{},'execution_count':1,'source':['import csv, json\n','from pathlib import Path\n',"rows = list(csv.DictReader(Path('failure-taxonomy.csv').open()))\n","print(json.dumps([{k:r[k] for k in ('run_id','reviewer_a','reviewer_b','disagreements','adjudication')} for r in rows], indent=2))\n"],
 'outputs':[{'output_type':'stream','name':'stdout','text':json.dumps([{k:r[k] for k in ('run_id','reviewer_a','reviewer_b','disagreements','adjudication')} for r in rows],indent=2).splitlines(keepends=True)}]}]}
(REPORTS/'failure-review.ipynb').write_text(json.dumps(notebook,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='source_hashes'}))
