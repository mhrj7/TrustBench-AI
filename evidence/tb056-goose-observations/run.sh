# usage: sh run.sh <label> [extra env assignments...]; records goose's first model request into observe/<label>.jsonl
set -e
B=${GOOSE_WORKDIR:?set GOOSE_WORKDIR to a folder holding goose-1.55.0/, venv-mcp/ and probes/}; L=$1; shift
rm -f $B/observe/$L.jsonl; rm -rf $B/observe/home-$L $B/observe/cwd-$L; mkdir -p $B/observe/home-$L $B/observe/cwd-$L/sub
echo 'MARKER-AGENTSMD: if you can read this line, project context files are loaded.' > $B/observe/cwd-$L/AGENTS.md
echo 'MARKER-GOOSEHINTS: project hints loaded.' > $B/observe/cwd-$L/.goosehints
$B/venv-mcp/bin/python $B/observe/mock_llm.py 18765 $B/observe/$L.jsonl & P=$!
sleep 1
cd $B/observe/cwd-$L && env HOME=$B/observe/home-$L GOOSE_DISABLE_KEYRING=1 GOOSE_TELEMETRY_ENABLED=false OPENAI_API_KEY=mock OPENAI_HOST=http://127.0.0.1:18765 OPENAI_BASE_PATH=v1/chat/completions "$@" \
  $B/goose-1.55.0/goose run --no-session --no-profile --provider openai --model mock-model --with-extension "$B/venv-mcp/bin/python $B/probes/mcp_probe_server.py" --max-turns 1 -q -t "hello" > $B/observe/$L.stdout 2>&1 || true
kill $P
