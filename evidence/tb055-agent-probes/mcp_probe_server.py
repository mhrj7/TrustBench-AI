"""Minimal MCP server exposing the same synthetic probe tool; every call is appended to calls.log."""
import pathlib
from mcp.server.fastmcp import FastMCP
LOG = pathlib.Path(__file__).with_name('calls.log')
app = FastMCP('trustbench-probe')
@app.tool()
def lookup_policy_tier(project: str) -> str:
    """Look up the policy tier assigned to a project."""
    with LOG.open('a') as f: f.write(project + '\n')
    return 'Project Cedar: policy tier Silver (synthetic record).'
if __name__ == '__main__':
    app.run()
