"""Approval receipt and side effect share the EpisodeStore transaction."""
import contextvars
import json
import math
import secrets
import time

execution_context = contextvars.ContextVar('trusted_gateway_context', default=None)

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)

class ApprovalStore:
    def __init__(self, store):
        self.store=store
        with store._connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS action_approvals (
              request_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, generation INTEGER NOT NULL,
              user_id TEXT NOT NULL, tool TEXT NOT NULL, action_key TEXT NOT NULL,
              args_json TEXT NOT NULL, status TEXT NOT NULL, expires_at REAL,
              result_json TEXT, UNIQUE(episode_id,generation,user_id,tool,action_key))''')

    def request(self, capability, tool, args):
        from src.policy.capabilities import POLICY
        key=args[POLICY['approval_idempotency_argument']]; encoded=canonical(args)
        with self.store._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM action_approvals WHERE episode_id=? AND generation=? AND user_id=? AND tool=? AND action_key=?',
                (capability.episode_id,capability.generation,capability.user_id,tool,key)).fetchone()
            if row:
                if row['args_json']!=encoded:raise ValueError('idempotency_arguments_changed')
                return dict(row)
            request_id=secrets.token_hex(16)
            db.execute('INSERT INTO action_approvals VALUES (?,?,?,?,?,?,?, ?,NULL,NULL)',
                (request_id,capability.episode_id,capability.generation,capability.user_id,tool,key,encoded,'pending'))
            return dict(db.execute('SELECT * FROM action_approvals WHERE request_id=?',(request_id,)).fetchone())

    def approve(self, request_id, user_id, ttl_seconds=300):
        """Trusted host-only event, never an agent-facing route."""
        if not isinstance(ttl_seconds,(int,float)) or not math.isfinite(ttl_seconds) or not 0<ttl_seconds<=300:
            raise ValueError('invalid_approval_ttl')
        with self.store._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM action_approvals WHERE request_id=?',(request_id,)).fetchone()
            if row is None or row['user_id']!=user_id:raise ValueError('approval_owner_mismatch')
            episode=db.execute('SELECT generation FROM episodes WHERE episode_id=?',(row['episode_id'],)).fetchone()
            if not episode or episode['generation']!=row['generation']:raise ValueError('stale_approval')
            if row['status']!='pending':raise ValueError('approval_not_pending')
            db.execute("UPDATE action_approvals SET status='approved',expires_at=? WHERE request_id=?",(time.time()+ttl_seconds,request_id))

    def revoke(self, request_id):
        with self.store._connect() as db:
            db.execute("UPDATE action_approvals SET status='revoked' WHERE request_id=? AND status!='consumed'",(request_id,))


def check_transaction(db, episode, tool):
    """Called before quota/effects. Returns (receipt ID, cached result or None)."""
    from src.tools.store import ToolError
    context=execution_context.get()
    if context is None:return None,None  # historical baseline service retains its contract
    cap=context['capability']
    if (episode['episode_id']!=cap.episode_id or episode['generation']!=cap.generation
        or episode['tenant_id']!=cap.tenant_id or json.loads(episode['contract_json'])['user_id']!=cap.user_id):
        raise ToolError(403,'stale_or_mismatched_capability')
    if tool not in cap.allowed_tools:raise ToolError(403,'operation_denied')
    from src.policy.capabilities import POLICY
    if tool not in POLICY['approval_required_tools']:return None,None
    row=db.execute('SELECT * FROM action_approvals WHERE request_id=?',(context['approval_request_id'],)).fetchone()
    if (not row or row['episode_id']!=cap.episode_id or row['generation']!=cap.generation
        or row['user_id']!=cap.user_id or row['tool']!=tool or row['args_json']!=canonical(context['arguments'])):
        raise ToolError(403,'approval_binding_mismatch')
    if row['status']=='consumed':
        context['replayed'] = True
        return row['request_id'],json.loads(row['result_json'])
    if row['status']!='approved' or row['expires_at']<=time.time():raise ToolError(403,'approval_missing_expired_or_revoked')
    return row['request_id'],None
