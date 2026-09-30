#!/bin/sh
# usage: run-cc.sh <label> <tool> <args-json> [extra env assignments...]
label=$1; tool=$2; args=$3; shift 3
D=/work/fake/$label; rm -rf $D; mkdir -p $D /work/cchome-$label /work/projcc
cat > $D/mcp.json <<JSON
{"mcpServers":{"probe":{"type":"stdio","command":"node","args":["${PROBE_SERVER:-/work/v1/cc-probe-server.mjs}"],"env":{"PROBE_LOG":"$D/server.log"}}}}
JSON
FAKE_PORT=18080 FAKE_LOG=$D node /work/v1/fake-anthropic.mjs 2>$D/fake.err &
FP=$!
sleep 1
cd /work/projcc
start=$(date +%s)
env HOME=/work/cchome-$label ANTHROPIC_BASE_URL=http://127.0.0.1:18080 ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 ENABLE_TOOL_SEARCH=false "$@" \
  timeout 300 /work/cc/package/claude -p "TOOL=$tool ARGS=$args" --mcp-config $D/mcp.json --strict-mcp-config \
  --allowedTools "mcp__probe__work,mcp__probe__plain,mcp__probe__ask,mcp__probe__ask_mrtr" --output-format json --model claude-sonnet-4-5 > $D/cc.out 2> $D/cc.err
echo "exit=$? wall=$(( $(date +%s) - start ))s" > $D/exit.txt
kill $FP 2>/dev/null
cat $D/exit.txt
