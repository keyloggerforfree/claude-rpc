#!/usr/bin/env bash
# Run the daemon end to end in an isolated sandbox, against a fake Discord.
#
# Unit tests can't reach the daemon's presence path: pushPresence returns
# early unless Discord is connected, so resolvePresence / applyIdle /
# applyPrivacy / buildActivity only run with a live IPC peer. This script
# gives the daemon one, and keeps everything else away from the real machine:
#
#   - the working tree is copied into <sandbox>/home/node_modules/claude-rpc,
#     so the daemon runs in npm mode and reads only the sandbox config
#   - HOME, XDG_CONFIG_HOME, TMPDIR and XDG_RUNTIME_DIR point into the sandbox:
#     its own pid file, state, log and Claude settings, and the Discord client
#     only looks for the fake socket (the real one lives in /run/user/<uid>)
#   - the config sets autostart:false (the startup self-heal would otherwise
#     call `systemctl --user` on the real session) and community off
#
# Usage: scripts/sandbox/run.sh [fixture.json] [seconds]
#   fixture   session state to replay (default: fixtures/permission-prompt.json).
#             Any numeric timestamp field that is <= 0 is relative to now:
#             -120000 means two minutes ago. "transcriptPath" is filled in.
#   seconds   how long the daemon runs (default 10)
#   CONFIG=<file>  replace the sandbox config (keep autostart:false in it!)
#
# Prints the daemon log and every activity sent to the fake Discord, then
# deletes the sandbox. Nothing is installed and nothing outside it is touched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FIXTURE="${1:-$HERE/fixtures/permission-prompt.json}"
SECONDS_TO_RUN="${2:-10}"

# A short base path: Unix socket paths max out at ~108 bytes.
BOX="$(mktemp -d -t crpc-sbx.XXXX)"
cleanup() {
  [[ -n "${FAKE_PID:-}" ]] && kill "$FAKE_PID" 2>/dev/null || true
  rm -rf "$BOX"
}
trap cleanup EXIT

PKG="$BOX/home/node_modules/claude-rpc"
mkdir -p "$PKG" "$BOX/cfg/claude-rpc" "$BOX/tmp/claude-rpc" "$BOX/run" "$BOX/home/.claude/projects/-tmp-proj"
cp -r "$REPO/src" "$REPO/bin" "$REPO/package.json" "$PKG/"

if [[ -n "${CONFIG:-}" ]]; then
  cp "$CONFIG" "$BOX/cfg/claude-rpc/config.json"
else
  cat > "$BOX/cfg/claude-rpc/config.json" <<'EOF'
{
  "clientId": "1506443909406920948",
  "autostart": false,
  "community": { "enabled": false },
  "privacy": { "patterns": ["*"], "mode": "name-only", "projectName": "Project",
               "autoDetectGithubPrivate": false, "hotspot": false }
}
EOF
fi

# A small transcript, so token/model enrichment and turn signals have a file.
TRANSCRIPT="$BOX/home/.claude/projects/-tmp-proj/sess-a.jsonl"
printf '%s\n' \
  '{"type":"user","cwd":"/tmp/proj","message":{"content":"hi"},"version":"2.1.300"}' \
  '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":5}},"version":"2.1.300"}' \
  > "$TRANSCRIPT"

# Fixture → state file, resolving relative timestamps against now.
node -e '
  const fs = require("fs");
  const [fixture, out, transcript] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const now = Date.now();
  const TIMES = ["sessionStart", "lastActivity", "lastEventAt", "toolStartedAt", "permissionPendingAt",
    "lastNotification", "justShipped", "compactStartedAt", "lastUserPrompt", "lastBashAt"];
  for (const k of TIMES) if (typeof s[k] === "number" && s[k] <= 0) s[k] = now + s[k];
  for (const t of Object.values(s.toolsInFlight || {})) if (t.startedAt <= 0) t.startedAt = now + t.startedAt;
  s.transcriptPath = transcript;
  fs.writeFileSync(out, JSON.stringify(s));
' "$FIXTURE" "$BOX/tmp/claude-rpc/state-sess-a.json" "$TRANSCRIPT"

node "$HERE/fake-discord.mjs" "$BOX/run/discord-ipc-0" "$BOX/activities.jsonl" "$PKG/src/discord-ipc.js" &
FAKE_PID=$!
sleep 1

echo "▶ daemon running ${SECONDS_TO_RUN}s on $(basename "$FIXTURE")"
set +e
HOME="$BOX/home" XDG_CONFIG_HOME="$BOX/cfg" XDG_RUNTIME_DIR="$BOX/run" TMPDIR="$BOX/tmp" \
  CLAUDE_RPC_NO_AUTOSTART=1 timeout "$SECONDS_TO_RUN" node "$PKG/src/daemon.js" > "$BOX/stdout.txt" 2>&1
status=$?
set -e

echo
echo "── daemon log ──"
cat "$BOX/tmp/claude-rpc/daemon.log" 2>/dev/null || echo "(no log)"
if grep -qiE 'referenceerror|typeerror|syntaxerror|is not defined|unhandled' "$BOX/stdout.txt"; then
  echo
  echo "── ERRORS on stdout/stderr ──"
  grep -iE -B2 -A8 'referenceerror|typeerror|syntaxerror|is not defined|unhandled' "$BOX/stdout.txt"
  status=1
fi

echo
echo "── sent to Discord ──"
if [[ -s "$BOX/activities.jsonl" ]]; then
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    for (const l of lines) {
      const a = JSON.parse(l);
      if (!a) { console.log("CLEARED"); continue; }
      console.log(`${a.details ?? "-"} | ${a.state ?? "(no line 2)"} | hover: ${a.assets?.large_text ?? "-"}`);
    }
  ' "$BOX/activities.jsonl"
else
  echo "(nothing — the daemon never pushed a presence)"
fi

# timeout's 124 is the expected way out; anything else is a crash.
[[ $status -eq 124 ]] && exit 0 || exit "$status"
