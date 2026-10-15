import hashlib,json,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from src.policy.capabilities import Capability,SCHEMAS
from src.tools.store import EpisodeStore
(ROOT/'.tool-state').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=ROOT/'.tool-state') as temporary:
    store=EpisodeStore(ROOT/'data/benign.jsonl',Path(temporary)/'state.sqlite')
    manifests={}
    for fixture_id,fixture in store.fixtures.items():
        episode=fixture_id.lower()
        store.reset(episode,fixture_id,12)
        manifests[fixture_id]=Capability.issue(store,episode,fixture['task_contract']['allowed_tools']).manifest()
    payload={'version':'tb021.1','note':'Fixture manifest templates. Live issuance binds the actual episode and generation; templates are not bearer credentials.',
      'fixture_sha256':hashlib.sha256((ROOT/'data/benign.jsonl').read_bytes()).hexdigest(),
      'tasks':manifests,'argument_schemas':{name:s.model_json_schema() for name,s in SCHEMAS.items()}}
    (ROOT/'src/policy/capability-manifests.json').write_text(json.dumps(payload,indent=2)+'\n')
print('Exported six user-scoped fixture capability templates and nine JSON argument schemas.')
