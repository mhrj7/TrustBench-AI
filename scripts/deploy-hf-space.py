#!/usr/bin/env python3
"""TB-041: publish the constrained demo to a Hugging Face Space (Docker SDK, free CPU hardware).

Run by the project owner, with their own Hugging Face token (never stored in the repository):

  HF_TOKEN=... uv run --with huggingface_hub==0.30.2 python scripts/deploy-hf-space.py --space <user>/<name> [--set-secrets]

What it does:
  1. Stages exactly the committed tree (git archive HEAD; uncommitted files and gitignored secrets cannot be included),
     with Dockerfile.service as the Space's Dockerfile and the public-demo deployment profile switched on.
  2. Prepends the Space metadata (sdk: docker, app_port) to the staged README; the repository's README is unchanged.
  3. Creates the Space if needed (public) and uploads the staged tree as one commit.
  4. With --set-secrets: stores the project NVIDIA free-tier key and the operator token as Space secrets, read from
     deploy/secrets/ on this machine (they go only to Hugging Face's secret store, never into the Space's files).
Then run scripts/check-deployment.py --url https://<user>-<name>.hf.space --live against it."""
import argparse, os, subprocess, sys, tarfile, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = 'configs/deploy/public-demo.json'
FRONT = """---
title: TrustBench live demo
emoji: 🛡️
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 8080
pinned: false
short_description: Paired agent-security benchmark you can run live
---

"""


def stage(dest: Path) -> str:
    commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    dirty = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty:
        print('note: uncommitted changes are not deployed; the Space gets commit', commit[:7], file=sys.stderr)
    archive = dest.parent / 'tree.tar'
    subprocess.run(['git', 'archive', '--format=tar', '-o', str(archive), commit], cwd=ROOT, check=True)
    with tarfile.open(archive) as t:
        t.extractall(dest, filter='data')
    archive.unlink()
    dockerfile = (dest / 'Dockerfile.service').read_text()
    marker = 'EXPOSE 8080'
    assert marker in dockerfile
    (dest / 'Dockerfile').write_text(dockerfile.replace(marker, f'ENV TRUSTBENCH_DEPLOY_PROFILE={PROFILE} TRUSTBENCH_DEPLOYED_COMMIT={commit}\n{marker}', 1))
    (dest / 'README.md').write_text(FRONT + (dest / 'README.md').read_text())
    for forbidden in ('.env', 'deploy/secrets'):
        assert not (dest / forbidden).exists(), forbidden
    return commit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--space', required=True, help='<user or org>/<space name>')
    ap.add_argument('--set-secrets', action='store_true')
    ap.add_argument('--stage-only', help='write the staged tree to this directory and stop (no upload)')
    a = ap.parse_args()
    if a.stage_only:
        out = Path(a.stage_only)
        out.mkdir(parents=True, exist_ok=False)
        print('staged commit', stage(out), 'in', out)
        return
    token = os.environ.get('HF_TOKEN')
    if not token:
        sys.exit('set HF_TOKEN to a Hugging Face write token (it is read from the environment only)')
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp) / 'space'
        tree.mkdir()
        commit = stage(tree)
        api.create_repo(a.space, repo_type='space', space_sdk='docker', exist_ok=True, private=False)
        if a.set_secrets:
            for name, file in (('NVIDIA_API_KEY', 'nvidia_api_key'), ('TRUSTBENCH_ADMIN_TOKEN', 'trustbench_admin_token')):
                value = (ROOT / 'deploy/secrets' / file).read_text().strip()
                api.add_space_secret(a.space, name, value)
                print('secret set:', name)
        api.upload_folder(folder_path=str(tree), repo_id=a.space, repo_type='space', commit_message=f'Deploy TrustBench {commit[:7]}', delete_patterns=['*'])
    user, name = a.space.split('/')
    print(f'deployed {commit[:7]} to https://huggingface.co/spaces/{a.space}; the site will be at https://{user}-{name}.hf.space'.lower().replace('_', '-'))


if __name__ == '__main__':
    main()
