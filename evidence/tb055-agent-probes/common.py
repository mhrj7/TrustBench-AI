"""Shared probe setup: one synthetic tool, two free models, keys read from TrustBench's gitignored .env (never printed)."""
import json, os, pathlib
for line in pathlib.Path(__file__).resolve().parents[2] / '.env'.read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())
MODELS = {
    'ollama:qwen3.5:9b': {'base_url': 'http://localhost:11434/v1', 'api_key': 'ollama', 'model': 'qwen3.5:9b'},
    'nvidia:openai/gpt-oss-20b': {'base_url': 'https://integrate.api.nvidia.com/v1', 'api_key': os.environ.get('NVIDIA_API_KEY', ''), 'model': 'openai/gpt-oss-20b'},
}
PROMPT = 'Which policy tier is assigned to Project Cedar? Use the lookup tool, then answer in one sentence.'
CALLS = []
def lookup_policy_tier(project: str) -> str:
    """Look up the policy tier assigned to a project."""
    CALLS.append(project)
    return 'Project Cedar: policy tier Silver (synthetic record).'
def report(agent, model, answer, err=None):
    print(json.dumps({'agent': agent, 'model': model, 'tool_calls': CALLS[:], 'answer': (answer or '')[:200],
                      'ok': bool(CALLS) and 'silver' in (answer or '').lower() and err is None, 'error': err}))
    CALLS.clear()
