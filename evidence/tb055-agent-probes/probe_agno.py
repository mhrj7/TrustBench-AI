import os, sys
os.environ['AGNO_TELEMETRY'] = 'false'  # no telemetry leaves the machine
from common import MODELS, PROMPT, lookup_policy_tier, report
from agno.agent import Agent
from agno.models.openai.like import OpenAILike
m = MODELS[sys.argv[1]]
try:
    a = Agent(model=OpenAILike(id=m['model'], base_url=m['base_url'], api_key=m['api_key']), tools=[lookup_policy_tier], instructions='You answer using tools.', telemetry=False)
    r = a.run(PROMPT)
    report('agno 3.1.6', sys.argv[1], str(r.content))
except Exception as e:
    report('agno 3.1.6', sys.argv[1], '', type(e).__name__ + ': ' + str(e)[:160])
