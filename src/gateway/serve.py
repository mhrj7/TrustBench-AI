"""Launch only the gateway listener; keep raw ASGI tool service private."""
import argparse
import json
import os
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', required=True)
    parser.add_argument('--episode', required=True)
    parser.add_argument('--session-file', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--session-db', type=Path, default=None, help='durable session store (TB-026); sessions survive a gateway restart')
    parser.add_argument('--resume', action='store_true', help='reuse the existing session file and episode state instead of resetting')
    parser.add_argument('--flow-check', action='store_true', help='enable the provenance-aware flow check (configs/policy.yaml provenance_flow)')
    parser.add_argument('--audit-file', type=Path, default=None, help='append-only policy decision trace (host-only)')
    parser.add_argument('--disable-layer', action='append', default=[], help='TB-036 ablation only (configs/ablations.yaml): tool_allowlist, contract_scope or approval')
    args = parser.parse_args()
    from src.tools.app import app, store
    from src.gateway.app import Gateway
    import uvicorn
    fixture = store.fixtures[args.fixture]
    root = Path(__file__).resolve().parents[2]
    run_config = json.loads((root / 'configs/live-run.yaml').read_text())
    durability = json.loads((root / 'configs/durability.yaml').read_text())
    if args.resume and args.session_db is None:
        raise SystemExit('--resume needs --session-db: sessions only survive a restart when they are stored')
    if not args.resume:
        store.reset(args.episode, args.fixture, run_config['episode_max_tool_calls'])
    if args.audit_file is not None and not (args.resume and args.audit_file.exists()):
        args.audit_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.audit_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    gateway = Gateway(app, audit_path=args.audit_file, flow_check=args.flow_check,
                      session_db=str(args.session_db) if args.session_db else None, session_ttl_s=durability['gateway_session_ttl_s'],
                      disabled_layers=args.disable_layer)
    if args.resume:
        uvicorn.run(gateway.app, host='127.0.0.1', port=args.port)  # existing sessions are loaded from the store on first use
        return
    token = gateway.bind(args.episode, fixture['task_contract']['allowed_tools'])
    # Exclusive create protects existing credentials and refuses symlink overwrite.
    args.session_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.session_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'baseUrl':f'http://127.0.0.1:{args.port}', 'episodeId':args.episode, 'sessionToken':token, 'signingKey':gateway.signing_key(token)}, f)
    uvicorn.run(gateway.app, host='127.0.0.1', port=args.port)

if __name__ == '__main__':
    main()
