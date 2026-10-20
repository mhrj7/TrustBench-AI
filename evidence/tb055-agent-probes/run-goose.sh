#!/bin/sh
# Goose 1.55.0 probe, headless and isolated: a throwaway HOME, no keyring, telemetry off, no default profile (so its
# built-in shell and file extensions are not loaded), only the probe MCP server. usage: sh run-goose.sh ollama|nvidia
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export HOME="${GOOSE_PROBE_HOME:?set GOOSE_PROBE_HOME to an empty folder}" GOOSE_DISABLE_KEYRING=1 GOOSE_TELEMETRY_ENABLED=false
SRV="${MCP_PYTHON:?set MCP_PYTHON to a Python with mcp installed} $HERE/mcp_probe_server.py"
P='Which policy tier is assigned to Project Cedar? Use the lookup tool, then answer in one sentence.'
case "$1" in
  ollama) OLLAMA_HOST=http://localhost:11434 "$GOOSE" run --no-session --no-profile --provider ollama --model qwen3.5:9b --with-extension "$SRV" --max-turns 6 -q -t "$P" ;;
  nvidia) OPENAI_API_KEY="$NVIDIA_API_KEY" OPENAI_HOST=https://integrate.api.nvidia.com OPENAI_BASE_PATH=v1/chat/completions \
          "$GOOSE" run --no-session --no-profile --provider openai --model openai/gpt-oss-20b --with-extension "$SRV" --max-turns 6 -q -t "$P" ;;
esac
