import asyncio, sys
from common import MODELS, PROMPT, lookup_policy_tier, report
from openai import AsyncOpenAI
from agents import Agent, Runner, function_tool, set_tracing_disabled, OpenAIChatCompletionsModel
set_tracing_disabled(True)  # no traces leave the machine
tool = function_tool(lookup_policy_tier)
async def main(name):
    m = MODELS[name]
    model = OpenAIChatCompletionsModel(model=m['model'], openai_client=AsyncOpenAI(base_url=m['base_url'], api_key=m['api_key']))
    try:
        r = await Runner.run(Agent(name='probe', instructions='You answer using tools.', tools=[tool], model=model), PROMPT, max_turns=6)
        report('openai-agents 0.24.0', name, str(r.final_output))
    except Exception as e:
        report('openai-agents 0.24.0', name, '', type(e).__name__ + ': ' + str(e)[:160])
asyncio.run(main(sys.argv[1]))
