#!/bin/sh
# TB-046: reproduce the offline subset as another user would, in a clean container, from only the files git tracks at a
# commit or tag (no local caches, environments, secrets or untracked files). Needs Docker.
#   sh repro/run-in-container.sh <commit or tag> [log output path]
set -eu
ref="${1:?usage: sh repro/run-in-container.sh <commit or tag> [log path]}"
out="${2:-repro/reproduction-log.json}"
root="$(cd "$(dirname "$0")/.." && pwd)"
ctx="$(mktemp -d "${TRUSTBENCH_STORAGE_ROOT:-$root/..}/.repro-ctx.XXXXXX")"
trap 'rm -r "$ctx"' EXIT
git -C "$root" archive --format=tar "$ref" | tar -x -C "$ctx"
cat > "$ctx/Dockerfile.repro" <<'DOCKER'
FROM ghcr.io/astral-sh/uv:0.11.28@sha256:0f36cb9361a3346885ca3677e3767016687b5a170c1a6b88465ec14aefec90aa AS uv
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
RUN npm install -g npm@12.0.0
# another user: not root, a home directory unrelated to the author's machine
USER node
ENV TRUSTBENCH_STORAGE_ROOT=/home/node/work npm_config_cache=/home/node/work/.cache/npm UV_CACHE_DIR=/home/node/work/.cache/uv \
    UV_PYTHON_INSTALL_DIR=/home/node/work/.cache/python PYTHONDONTWRITEBYTECODE=1
WORKDIR /home/node/work/TrustBench-AI
COPY --chown=node:node . .
# the documented steps (repro/README.md): a git checkout of the tracked files, then install from the locks
RUN git init -q && git add -A && git -c user.name=repro -c user.email=repro@example.invalid commit -qm "tracked files at the release" \
    && cp .env.example .env && npm ci && sh scripts/setup-python.sh
CMD ["sh", "-c", ".venv-tools/bin/python scripts/repro.py check && .venv-tools/bin/python scripts/repro.py reproduce; s=$?; cat repro/reproduction-log.json; exit $s"]
DOCKER
tag="trustbench-repro:$(git -C "$root" rev-parse --short "$ref")"
docker build -q -f "$ctx/Dockerfile.repro" -t "$tag" "$ctx" >/dev/null
cid="$(docker create --network none -e TRUSTBENCH_REPRO_SOURCE_COMMIT="$(git -C "$root" rev-parse "$ref^{commit}")" "$tag")"
status=0; docker start -a "$cid" || status=$?
docker cp "$cid:/home/node/work/TrustBench-AI/repro/reproduction-log.json" "$out" 2>/dev/null || true
docker rm "$cid" >/dev/null
echo "container exit=$status, log: $out"
exit "$status"
