"""LangGraph approval workflow for consequential tool calls (TB-022).

Node layout keeps side effects out of nodes that LangGraph may replay:
  propose  - sends the exact request to the gateway; the gateway durably records a
             pending approval (idempotent) and returns 409. No tool effect.
  gate     - calls interrupt(); on resume this node restarts from its top, so it holds
             no side effects.
  execute  - re-submits the identical request. The gateway consumes the approval and
             commits the effect in one SQLite transaction; replaying this node returns
             the saved receipt without a second effect.
The approval authority is the host-only ApprovalStore.approve event, not the resume
payload: a resume cannot make the gateway execute changed arguments.
"""
import sqlite3
from typing import Any, Callable, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

CallTool = Callable[[str, dict], tuple[int, Any]]


class ApprovalState(TypedDict, total=False):
    tool: str
    arguments: dict
    request_id: str
    status: str  # awaiting_approval | approved | rejected | completed | denied
    http_status: int
    result: Any


def build_graph(call_tool: CallTool, checkpointer):
    def propose(state: ApprovalState):
        code, body = call_tool(state['tool'], state['arguments'])
        if code == 409 and isinstance(body, dict) and body.get('detail') == 'approval_required':
            return {'request_id': body['request_id'], 'status': 'awaiting_approval'}
        return {'status': 'completed' if code == 200 else 'denied', 'http_status': code, 'result': body}

    def gate(state: ApprovalState):
        decision = interrupt({'request_id': state['request_id'], 'tool': state['tool'],
                              'arguments': state['arguments']})
        if (not isinstance(decision, dict) or decision.get('approved') is not True
                or decision.get('request_id') != state['request_id']):
            return {'status': 'rejected'}
        return {'status': 'approved'}

    def execute(state: ApprovalState):
        code, body = call_tool(state['tool'], state['arguments'])
        return {'status': 'completed' if code == 200 else 'denied', 'http_status': code, 'result': body}

    graph = StateGraph(ApprovalState)
    graph.add_node('propose', propose)
    graph.add_node('gate', gate)
    graph.add_node('execute', execute)
    graph.add_edge(START, 'propose')
    graph.add_conditional_edges('propose', lambda s: 'gate' if s['status'] == 'awaiting_approval' else END,
                                {'gate': 'gate', END: END})
    graph.add_conditional_edges('gate', lambda s: 'execute' if s['status'] == 'approved' else END,
                                {'execute': 'execute', END: END})
    graph.add_edge('execute', END)
    return graph.compile(checkpointer=checkpointer)


def open_checkpointer(path):
    """Durable checkpoint store (separate SQLite file from the episode database)."""
    return SqliteSaver(sqlite3.connect(str(path), check_same_thread=False))


def start(graph, thread_id: str, tool: str, arguments: dict):
    return graph.invoke({'tool': tool, 'arguments': arguments},
                        {'configurable': {'thread_id': thread_id}})


def pending_interrupt(graph, thread_id: str):
    snapshot = graph.get_state({'configurable': {'thread_id': thread_id}})
    return [i.value for task in snapshot.tasks for i in task.interrupts]


def resume(graph, thread_id: str, request_id: str, approved: bool = True):
    return graph.invoke(Command(resume={'request_id': request_id, 'approved': approved}),
                        {'configurable': {'thread_id': thread_id}})
