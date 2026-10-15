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
    parser.add_argument('--flow-check', action='store_true', help='enable the provenance-aware flow check (configs/policy.yaml provenance_flow)')
    parser.add_argument('--audit-file', type=Path, default=None, help='append-only policy decision trace (host-only)')
    args = parser.parse_args()
    from src.tools.app import app, store
    from src.gateway.app import Gateway
    import uvicorn
    fixture = store.fixtures[args.fixture]
    run_config = json.loads((Path(__file__).resolve().parents[2] / 'configs/live-run.yaml').read_text())
    store.reset(args.episode, args.fixture, run_config['episode_max_tool_calls'])
    if args.audit_file is not None:
        args.audit_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.audit_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    gateway = Gateway(app, audit_path=args.audit_file, flow_check=args.flow_check)
    token = gateway.bind(args.episode, fixture['task_contract']['allowed_tools'])
    # Exclusive create protects existing credentials and refuses symlink overwrite.
    args.session_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.session_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'baseUrl':f'http://127.0.0.1:{args.port}', 'episodeId':args.episode, 'sessionToken':token}, f)
    uvicorn.run(gateway.app, host='127.0.0.1', port=args.port)

if __name__ == '__main__':
    main()
