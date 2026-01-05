#!/bin/bash
# Claude Code PreToolUse hook - notifies Miranda when AskUserQuestion is called
#
# Install:
#   1. Copy to ~/.claude/hooks/notify-miranda.sh
#   2. Add to ~/.claude/settings.json:
#      {
#        "hooks": {
#          "PreToolUse": [{
#            "matcher": { "tool_name": "AskUserQuestion" },
#            "hooks": [{ "command": "~/.claude/hooks/notify-miranda.sh" }]
#          }]
#        }
#      }
#
# Requires: jq, curl

set -euo pipefail

# Verify jq is available
command -v jq >/dev/null 2>&1 || exit 0

# Read JSON input from stdin (Claude Code passes hook data via stdin)
json_input=$(cat)

# Extract tool name
tool_name=$(echo "$json_input" | jq -r '.tool_name // empty')

# Only notify for AskUserQuestion
if [[ "$tool_name" != "AskUserQuestion" ]]; then
    exit 0
fi

# Get tmux session name (set by Miranda when spawning the session)
session="${TMUX_SESSION:-}"
if [[ -z "$session" ]]; then
    # Not running in a tmux session Miranda manages, skip
    exit 0
fi

# Extract relevant fields from hook input
session_id=$(echo "$json_input" | jq -r '.session_id // empty')
tool_input=$(echo "$json_input" | jq -c '.tool_input // {}')

# Miranda endpoint (configurable via env, defaults to localhost)
MIRANDA_URL="${MIRANDA_URL:-http://localhost:3847}"

# Build JSON payload safely (avoids injection via jq --arg)
payload=$(jq -n \
    --arg session "$session" \
    --arg session_id "$session_id" \
    --arg tool "$tool_name" \
    --argjson input "$tool_input" \
    '{session: $session, session_id: $session_id, tool: $tool, input: $input}')

# Log file for debugging (create parent dir if needed)
log_file="${HOME}/.claude/hooks/miranda.log"
mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

# POST notification to Miranda (async, don't block Claude)
# Errors are logged but don't fail the hook
{
    curl -sf -X POST "${MIRANDA_URL}/notify" \
        -H "Content-Type: application/json" \
        -d "$payload" || echo "[$(date -Iseconds)] notify failed: $?" >> "$log_file"
} &>/dev/null &

exit 0
