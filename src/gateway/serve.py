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
    args = parser.parse_args()
    from src.tools.app import app, store
    from src.gateway.app import Gateway
    import uvicorn
    fixture = store.fixtures[args.fixture]
    store.reset(args.episode, args.fixture, 12)
    gateway = Gateway(app)
    token = gateway.bind(args.episode, fixture['task_contract']['allowed_tools'])
    # Exclusive create protects existing credentials and refuses symlink overwrite.
    args.session_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.session_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'baseUrl':f'http://127.0.0.1:{args.port}', 'episodeId':args.episode, 'sessionToken':token}, f)
    uvicorn.run(gateway.app, host='127.0.0.1', port=args.port)

if __name__ == '__main__':
    main()
