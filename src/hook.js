#!/usr/bin/env node
import './safe-stdio.js';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { updateState, resetState, pushUnique, shortFile } from './state.js';
import { detectLastCommitSubject, detectGitBranch } from './git.js';
import { EVENTS_LOG_PATH } from './paths.js';
import { loadConfig } from './config.js';
import { ensureDaemonRunning } from './ensure-daemon.js';
// Ship classification lives in ships.js (shared with the scanner).
import { classifyShip } from './ships.js';

// require()d, not imported: a builtin's ESM facade reads every export, and
// fs's lazy getters then load fs/promises and the fs streams on every hook
// event. The same goes for the rest of the hook's module graph.
const fs = createRequire(import.meta.url)('node:fs');
const { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync } = fs;

const EVENTS_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function appendEvent(entry) {
  try {
    mkdirSync(dirname(EVENTS_LOG_PATH), { recursive: true });
    if (existsSync(EVENTS_LOG_PATH) && statSync(EVENTS_LOG_PATH).size > EVENTS_LOG_ROTATE_BYTES) {
      renameSync(EVENTS_LOG_PATH, EVENTS_LOG_PATH + '.1');
    }
    appendFileSync(EVENTS_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best-effort log: hooks must never fail because of an unwritable events.jsonl */ }
}

// The JSON event payload on stdin. Unreadable, empty, or malformed → {}.
function parseInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; }
}

// Handle a single hook event. Exported so the bundled exe can dispatch
// directly (avoids spawning a child process per hook).
export function processHookEvent(event, input = {}, now = Date.now()) {
  // Each session writes its OWN state file (state-<sessionId>.json) so concurrent
  // sessions stop clobbering one shared state.json — that thrash made the card
  // jump between projects, the timer reset, and counters over-count. Subagent
  // hooks carry the parent's session_id, so their activity rolls up correctly.
  // No id (legacy payload) → the global state.json, preserving old behavior.
  const sid = input.session_id || input.sessionId || null;
  // PreToolUse/PostToolUse are wired `async` (ASYNC_EVENTS in install.js) so
  // they never hold up a tool call — which means they can land out of order:
  // a slow PreToolUse after its own PostToolUse, or a PostToolUse after the
  // turn's (synchronous) Stop. `now` is the hook process's START time, i.e.
  // Claude Code's dispatch order, so an event older than the last one applied
  // is `stale`: it may still add to counters but must not overwrite status.
  // Every payload also carries transcript_path; keep it current so the daemon
  // can read signals hooks never send (see state.transcriptPath).
  const tpath = input.transcript_path || null;
  const update = (fn) => updateState((s) => {
    const stale = now < (s.lastEventAt || 0);
    if (!stale) s.lastEventAt = now;
    const next = fn(s, stale) ?? s;
    if (tpath) next.transcriptPath = tpath;
    return next;
  }, sid);
  const reset = (seed) => resetState({ lastEventAt: now, ...(tpath ? { transcriptPath: tpath } : {}), ...seed }, sid);

  // ── Running tools ─────────────────────────────────────────────────────────
  // Keyed by tool_use_id rather than counted: async Pre/PostToolUse arrive in
  // any order, so a count drifts (a PreToolUse landing after its own
  // PostToolUse left it stuck at 1). An id can't drift — a finish removes
  // exactly its own tool, and a start whose finish already landed is ignored.
  // Payloads without an id (older Claude Code) fall back to start/finish
  // pairing, skipping stale starts.
  const toolId = input.tool_use_id || null;
  const DONE_MAX = 64;
  function trackToolStart(s, toolName, stale) {
    if (toolId && (s.toolsDone || []).includes(toolId)) return;
    if (!toolId && stale) return;
    // Anonymous keys need a unique suffix: parallel starts can share a millisecond.
    const key = toolId || `anon-${now}-${Math.random().toString(36).slice(2, 10)}`;
    s.toolsInFlight = { ...(s.toolsInFlight || {}), [key]: { tool: toolName, startedAt: now } };
    s.toolsRunning = Object.keys(s.toolsInFlight).length;
  }
  function trackToolFinish(s, toolName) {
    const inflight = { ...(s.toolsInFlight || {}) };
    if (toolId) {
      delete inflight[toolId];
      s.toolsDone = [...(s.toolsDone || []).filter((id) => id !== toolId), toolId].slice(-DONE_MAX);
    } else {
      // No id: finish the oldest running tool of the same name, so a quick
      // Read finishing can't retire a long Bash; any anonymous one otherwise.
      const anon = Object.keys(inflight).filter((k) => k.startsWith('anon-'))
        .sort((a, b) => inflight[a].startedAt - inflight[b].startedAt);
      const key = anon.find((k) => inflight[k].tool === toolName) || anon[0];
      if (key) delete inflight[key];
    }
    s.toolsInFlight = inflight;
    s.toolsRunning = Object.keys(inflight).length;
  }
  // currentTool / toolStartedAt follow the most recently started tool still
  // running — or clear once none is. Only for non-stale events.
  function showRunningTool(s) {
    const running = Object.values(s.toolsInFlight || {});
    if (!running.length) {
      s.currentTool = null;
      s.toolStartedAt = null;
      return;
    }
    const latest = running.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    s.currentTool = latest.tool;
    s.toolStartedAt = latest.startedAt;
  }

  // The turn is over (Stop, StopFailure, idle_prompt): nothing is running.
  // toolsDone is kept so late async PreToolUse hooks stay ignored.
  const TURN_ENDED = {
    status: 'idle', currentTool: null, currentFile: null, toolStartedAt: null,
    toolsInFlight: {}, toolsRunning: 0, turnOpen: false, permissionPendingAt: null,
  };

  function setActivity(patch) {
    update((s) => {
      Object.assign(s, patch);
      s.lastActivity = now;
      // Any hook firing means Claude Code is alive — clear the closed flag
      // in case a prior SessionEnd from a sibling session set it.
      s.claudeClosed = false;
      if (!s.sessionStart) s.sessionStart = now;
      return s;
    });
  }

  switch (event) {
    case 'SessionStart': {
      // Post-compaction continuation, NOT a new session: Claude Code re-fires
      // SessionStart with source:'compact' after every compaction. Resetting
      // here wiped the elapsed timer and message/tool/file counters mid-turn.
      // Just clear the compacting marker and carry on. An auto-compaction
      // happens mid-turn, which resumes immediately ('working'); a manual
      // /compact runs between turns, so Claude is back to waiting ('idle').
      // PostCompact may arrive first and already have settled the status.
      if (input.source === 'compact') {
        update((s) => {
          const manual = s.compactTrigger === 'manual';
          delete s.compactStartedAt;
          delete s.compactTrigger;
          s.status = manual ? 'idle' : 'working';
          if (manual) s.turnOpen = false;
          s.lastActivity = now;
          s.claudeClosed = false;
          if (!s.sessionStart) s.sessionStart = now;
          return s;
        });
        break;
      }
      reset({
        cwd: input.cwd || process.cwd(),
        model: input.model?.id || input.model || 'claude',
        status: 'idle',
      });
      // Self-heal the daemon. A reboot, crash, OS sleep, or closed terminal can
      // leave nothing running, so the card silently never appears — and the
      // login-autostart entry (Run key / LaunchAgent / systemd --user) can be
      // missing, unloaded or unsupported (no systemd --user session, other
      // platforms). Every Claude Code session begins with this hook, so make it
      // (best-effort) guarantee the daemon is up: presence is then assured
      // exactly when you're using Claude, on every platform. ensureDaemonRunning
      // is a no-op when a daemon is already alive and is cooldown-guarded against
      // spawn storms; the daemon's atomic claim reaps any duplicate. Opt out
      // with `autostart:false` in config.
      try {
        // CLAUDE_RPC_NO_AUTOSTART=1 is the per-environment opt-out (CI, containers,
        // the test suite) for when editing config.json isn't practical.
        let autostart = process.env.CLAUDE_RPC_NO_AUTOSTART !== '1';
        try { if (autostart) autostart = loadConfig().autostart !== false; } catch { /* unreadable config — default on */ }
        ensureDaemonRunning({ autostart });
      } catch { /* presence is best-effort — never break the user's turn */ }
      break;
    }
    case 'UserPromptSubmit': {
      update((s) => {
        s.messages += 1;
        s.lastUserPrompt = now;
        s.lastActivity = now;
        s.status = 'thinking';
        // A tool interrupted by the user gets no PostToolUse — drop its
        // in-flight marker so applyIdle can't treat it as still running.
        s.currentTool = null;
        s.toolStartedAt = null;
        s.toolsInFlight = {};
        s.toolsRunning = 0;
        s.permissionPendingAt = null;
        s.turnOpen = true;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        if (input.cwd) s.cwd = input.cwd;
        return s;
      });
      break;
    }
    case 'PreToolUse': {
      const toolName = input.tool_name || input.toolName || 'tool';
      const toolInput = input.tool_input || input.toolInput || {};
      const file = toolInput.file_path || toolInput.path || toolInput.notebook_path || null;
      update((s, stale) => {
        s.tools += 1;
        s.toolBreakdown[toolName] = (s.toolBreakdown[toolName] || 0) + 1;
        // Even a stale start registers (a parallel sibling's PreToolUse can
        // land after a later one) — unless its own finish already landed.
        trackToolStart(s, toolName, stale);
        if (!s.sessionStart) s.sessionStart = now;
        if (!stale) {
          s.currentTool = toolName;
          s.currentFile = shortFile(file);
          s.toolStartedAt = now;
          s.turnOpen = true;
          s.status = 'working';
          s.lastActivity = now;
          s.claudeClosed = false;
          // Remember the running Bash command so the daemon can match custom
          // triggers (config.triggers) against it for a brief overlay frame.
          if (toolName === 'Bash' && toolInput.command) {
            s.lastBashCommand = String(toolInput.command).slice(0, 500);
            s.lastBashAt = now;
          }
        }
        if (file && (toolName === 'Read' || toolName === 'NotebookEdit')) {
          s.filesOpened = pushUnique(s.filesOpened, file);
          if (toolName === 'Read') s.filesRead = pushUnique(s.filesRead, file);
        }
        return s;
      });
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': { // a failed call fires only the latter
      const failed = event === 'PostToolUseFailure';
      const toolName = input.tool_name || input.toolName || '';
      const toolInput = input.tool_input || input.toolInput || {};
      const file = toolInput.file_path || toolInput.path || toolInput.notebook_path || null;
      // Just-shipped detection: a Bash command that pushes, commits, or opens
      // a PR / issue / release (ships.classifyShip: push|commit|pr|issue|tag).
      // Capture cwd + branch + last commit subject NOW — by the time the
      // daemon renders the next frame this info may be gone (Claude often
      // `cd`s after a commit).
      let shipKind = null;
      let shipSubject = null;
      let shipBranch = null;
      if (toolName === 'Bash' && !failed) { // a failed `git commit` shipped nothing
        shipKind = classifyShip(toolInput.command);
        if (shipKind) {
          const shipCwd = input.cwd || process.cwd();
          shipBranch = detectGitBranch(shipCwd) || null;
          // Only commit/push carry a meaningful "what shipped" subject; a PR
          // or issue creation doesn't map to a commit message.
          if (shipKind === 'commit' || shipKind === 'push') {
            shipSubject = detectLastCommitSubject(shipCwd) || null;
          }
        }
      }
      update((s, stale) => {
        trackToolFinish(s, toolName);
        if (!stale) {
          showRunningTool(s);
          s.lastActivity = now;
          s.claudeClosed = false;
          // Nothing left running after a permission prompt: it was approved
          // (this tool ran) and the turn carries on. With a sibling still
          // running the prompt may be for that one, so leave it pending.
          if (!s.toolsRunning) {
            s.permissionPendingAt = null;
            if (s.status === 'notification') s.status = 'working';
          }
        }
        if (!s.sessionStart) s.sessionStart = now;
        if (file && (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit')) {
          s.filesEdited = pushUnique(s.filesEdited, file);
          s.filesOpened = pushUnique(s.filesOpened, file);
        }
        if (shipKind) {
          s.justShipped = now;
          s.justShippedKind = shipKind;
          s.justShippedSubject = shipSubject;
          s.justShippedBranch = shipBranch;
        }
        // NOTE: PostToolUse tool_response carries no model usage, so this
        // never fired (the daemon overrides state.tokens from the transcript —
        // the documented single source of truth). Removed to kill a latent
        // double-count if a future Claude Code version did attach usage here.
        return s;
      });
      break;
    }
    case 'PostToolBatch': {
      // Claude Code 2.1.118+. Every tool call in the batch has resolved — run,
      // failed, or denied at a permission prompt (a manual deny fires no other
      // hook). Nothing is in flight any more and Claude is about to continue
      // the turn. Batch ids go to toolsDone so a late async PreToolUse for one
      // of them can't resurrect it.
      const ids = (Array.isArray(input.tool_calls) ? input.tool_calls : [])
        .map((c) => c && c.tool_use_id).filter(Boolean);
      update((s, stale) => {
        s.toolsInFlight = {};
        s.toolsRunning = 0;
        if (ids.length) s.toolsDone = [...(s.toolsDone || []).filter((id) => !ids.includes(id)), ...ids].slice(-DONE_MAX);
        if (!stale) {
          s.currentTool = null;
          s.toolStartedAt = null;
          s.permissionPendingAt = null;
          s.status = 'working';
          s.turnOpen = true;
          s.lastActivity = now;
          s.claudeClosed = false;
        }
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      break;
    }
    case 'Notification': {
      // Claude Code sends many notification kinds; only some mean "waiting on
      // you". Older versions omit notification_type and only ever sent
      // permission / idle notices — keep the historical brief-flash behavior.
      const kind = input.notification_type || null;
      if (kind === 'idle_prompt') {
        // "Claude finished responding ~60s ago and you haven't typed." The
        // turn is definitively over — also the only hook-level end signal
        // after an Esc interrupt, which fires no Stop.
        setActivity({ ...TURN_ENDED });
        break;
      }
      const waitingOnUser = !kind || kind === 'permission_prompt' || kind === 'agent_needs_input'
        || kind === 'elicitation_dialog' || kind === 'elicitation_url_dialog';
      if (!waitingOnUser) {
        // auth_success, agent_completed, elicitation_complete, quota_* … —
        // informational. Liveness only; don't flash "Permission needed".
        setActivity({});
        break;
      }
      update((s) => {
        s.status = 'notification';
        s.lastNotification = now;
        s.lastActivity = now;
        s.claudeClosed = false;
        if (kind === 'permission_prompt') {
          // Keep the pending tool's name: once the prompt is approved, the
          // daemon flips back to 'working' on that tool (see applyIdle).
          s.permissionPendingAt = now;
        } else {
          s.currentTool = null;
          s.currentFile = null;
        }
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      appendEvent({ type: 'notification', ts: now, kind, cwd: input.cwd || null });
      break;
    }
    case 'PreCompact': {
      // Compaction is mechanically distinct from "thinking" — the model is
      // rewriting earlier context, not advancing a turn. Surface it as its
      // own state so the card stops reading "Thinking…" for the 10-60s
      // compactions can take on big sessions.
      update((s) => {
        s.status = 'compacting';
        s.compactStartedAt = now;
        s.compactTrigger = input.trigger || input.matcher || null;
        s.currentTool = null;
        s.currentFile = null;
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      appendEvent({ type: 'precompact', ts: now, trigger: input.trigger || input.matcher || null, cwd: input.cwd || null });
      break;
    }
    case 'PostCompact': {
      // Claude Code 2.1.76+. Older versions only re-fire SessionStart
      // (source:'compact'), handled above. Both fire on newer versions; the
      // second agrees with the first, so compactTrigger is kept here for the
      // SessionStart handler. An auto-compaction resumes the turn that
      // triggered it; a manual /compact leaves the session waiting on you.
      update((s) => {
        const manual = (input.trigger || s.compactTrigger) === 'manual';
        delete s.compactStartedAt;
        s.status = manual ? 'idle' : 'working';
        if (manual) s.turnOpen = false;
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      break;
    }
    case 'SessionEnd': {
      // Authoritative "Claude Code is gone" signal — don't wait on the
      // staleSessionMin timeout. applyIdle short-circuits to stale when it
      // sees claudeClosed=true. Any subsequent hook from another live
      // session will flip the flag back to false.
      update((s) => {
        s.status = 'stale';
        s.claudeClosed = true;
        s.currentTool = null;
        s.currentFile = null;
        s.turnOpen = false;
        s.permissionPendingAt = null;
        s.lastActivity = now;
        return s;
      });
      break;
    }
    case 'SubagentStop': {
      // A subagent finishing is not the SESSION going idle — the parent turn
      // is still running (often with sibling subagents in flight). Flipping to
      // idle here showed "Standing by" mid-generation. Just record liveness;
      // the parent's own Stop/PreToolUse hooks drive status.
      setActivity({});
      break;
    }
    case 'Stop':
    // API errors (rate limit, overload…) end the turn with StopFailure INSTEAD
    // of Stop (Claude Code 2.1.78+) — without it the card stayed on "Thinking".
    case 'StopFailure': {
      setActivity({ ...TURN_ENDED });
      break;
    }
    default: {
      // An event this version doesn't model (a hook registered by hand, or a
      // newer Claude Code event). Liveness only — treating it as Stop would
      // flip the card idle mid-turn.
      setActivity({});
    }
  }
}

// Stdin-driven CLI form: read JSON event payload from stdin, dispatch, ack.
// The `{continue:true}` ack is a documented contract (SECURITY.md) — Claude
// Code reads it on every hook — so a state-write failure (full/unwritable
// tmpdir) must never stop us from emitting it. Dispatch is best-effort; the
// ack always goes out.
export function runHookCli(event) {
  try {
    // now − uptime = when this process was spawned, so dispatch order
    // survives node's (variable) startup time — see `stale` above. (The same
    // instant as performance.timeOrigin, to Date.now()'s 1ms resolution,
    // without loading perf_hooks.)
    processHookEvent(event, parseInput(), Math.round(Date.now() - process.uptime() * 1000));
  } catch { /* presence is best-effort; never break the user's turn */ }
  finally {
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch { /* stdout closed */ }
  }
}

// Run directly when invoked as `node src/hook.js <event>`. Detection is based
// on whether argv[1] ends in this filename — when imported (e.g. by cli.js),
// argv[1] won't match.
const argv1 = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
if (argv1.endsWith('/src/hook.js') || argv1.endsWith('/hook.js')) {
  runHookCli(process.argv[2] || 'unknown');
}
