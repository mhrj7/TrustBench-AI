#!/bin/sh
# TB-037: create the host tools venv (.venv-tools) from the committed hash-pinned locks, with the Python in .python-version.
set -eu
cd "$(dirname "$0")/.."
uv venv --allow-existing .venv-tools --python "$(cat .python-version)"
uv pip install --python .venv-tools/bin/python --require-hashes -r src/tools/requirements.lock
uv pip install --python .venv-tools/bin/python --require-hashes -r requirements/analysis.lock
.venv-tools/bin/python -c "import sys; print('tools venv ready:', sys.version.split()[0])"
