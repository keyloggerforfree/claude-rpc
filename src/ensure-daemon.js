// Daemon-lifecycle primitives shared by the CLI (`start`), the daemon itself
// (single-instance guard), and the hook (self-heal on SessionStart). Kept in a
// tiny dependency-light module so the hook — which runs on every Claude Code
// event and must stay fast and crash-proof — can import the spawn recipe
// without pulling in cli.js's UI stack.
//
// The "ultra assured startup" story lives here: the daemon comes up whenever a
// Claude Code session starts (ensureDaemonRunning, called from the hook), and a
// race-proof claim (claimSingleInstance, called by the daemon) guarantees that
// no matter how many launchers fire at once — a manual `start`, a Windows Run
// entry, several SessionStart hooks from concurrent sessions — exactly one
// daemon survives.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PID_PATH, STATE_DIR, DAEMON_SCRIPT, CANONICAL_EXE, IS_PACKAGED } from './paths.js';

// require()d, not imported — on the hook hot path; see hook.js.
const require = createRequire(import.meta.url);
const {
  openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, statSync, mkdirSync,
} = require('node:fs');

// mtime of this marker = last time any launcher attempted a spawn. A short
// cooldown stops concurrent SessionStart hooks (several sessions opening at
// once) and any startup crash-loop from spawning a swarm of throwaway daemons —
// the single-instance claim would reap them, but not spawning them is cheaper.
const SPAWN_MARKER = join(STATE_DIR, 'daemon-spawn.ts');
const SPAWN_COOLDOWN_MS = 15_000;

// True if `pid` names a live process. process.kill(pid,0) sends no signal — it
// just probes: ESRCH → gone, EPERM → exists but owned by someone else (still
// alive). 0/NaN is never alive.
export function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function readPid(pidPath = PID_PATH) {
  try { return Number(readFileSync(pidPath, 'utf8')) || 0; }
  catch { return 0; }
}

// The pid of the live daemon, or 0 if none is running.
export function daemonAlive(pidPath = PID_PATH) {
  const pid = readPid(pidPath);
  return pid && isAlive(pid) ? pid : 0;
}

// Does this command line look like a claude-rpc daemon? Covers every launch
// shape spawnDaemonDetached produces, from ANY install — the repo checkout and
// the npm copy are different paths, and a daemon started under a different
// TMPDIR keeps its pid file somewhere `daemonAlive()` never looks:
//   dev/npm  → node …/claude-rpc/src/daemon.js
//   packaged → …/claude-rpc(.exe) daemon
// Matched on argv STRUCTURE, not a substring: the executable must be the
// runtime (or the packaged exe) and daemon.js / `daemon` its first real
// argument. A substring test also hit any shell, grep or `tail -f` whose
// command line merely mentioned the path — and stop would SIGTERM it. The CLI
// itself (`claude-rpc stop`) has no `daemon` argument, so it never matches.
// Exported for tests.
export function looksLikeRpcDaemon(cmdline) {
  const c = String(cmdline || '').replace(/\\/g, '/').toLowerCase().trim();
  // argv tokens: a "quoted path with spaces" or a bare run of non-spaces.
  const tokens = (c.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
  if (tokens.length < 2) return false;
  const exe = tokens[0].slice(tokens[0].lastIndexOf('/') + 1);
  // First non-flag argument (skips node options like --max-old-space-size=…).
  const arg = tokens.slice(1).find((t) => !t.startsWith('-')) || '';
  if (/^(node|nodejs|bun|deno)(\.exe)?$/.test(exe)) return arg.endsWith('/claude-rpc/src/daemon.js');
  if (/^claude-rpc(\.exe)?$/.test(exe)) return arg === 'daemon';
  return false;
}

// Every running claude-rpc daemon's pid except our own, found by scanning the
// process table instead of trusting a pid file. Sync (a single ps/CIM query)
// so stopDaemon can stay synchronous. Returns [] when the platform can't be
// queried — callers then just fall back to the pid file.
export function findDaemonPids({ exclude = process.pid } = {}) {
  let out;
  try {
    // Required here, not imported: the hook loads this module on every event
    // and only the CLI's stop/restart ever scan (see spawnDaemonDetached).
    const { execFileSync } = require('node:child_process');
    out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='claude-rpc.exe'\" | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }"],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== exclude && looksLikeRpcDaemon(m[2])) pids.push(pid);
  }
  return pids;
}

// The single source of truth for HOW to launch the daemon, shared by every
// launcher so the CLI and the hook spawn it identically:
//   packaged → "<canonical exe>" daemon   (prefer the canonical install over a
//              transient Downloads copy so we don't keep that file locked open)
//   dev/npm  → "<node>" "<abs daemon.js>" (PATH-independent — process.execPath
//              is the very node already running us)
// Always detached + windowless + stdio-ignored so it outlives the launcher and
// never pops a console. Returns the child (caller reads .pid) or null on a
// synchronous spawn failure.
export function spawnDaemonDetached() {
  const exe = (IS_PACKAGED && existsSync(CANONICAL_EXE)) ? CANONICAL_EXE : process.execPath;
  const args = IS_PACKAGED ? ['daemon'] : [DAEMON_SCRIPT];
  try {
    // Required here, not imported: node:child_process (plus dgram and the
    // spawn bindings it pulls in) costs the hook a few ms on every event,
    // although it only spawns when the daemon is down.
    const { spawn } = require('node:child_process');
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // An async spawn failure (ENOENT on the exe) emits 'error'; with no listener
    // Node rethrows it as an unhandled exception that can take down the launcher.
    // Swallow — the caller verifies liveness via the pid file, not the child.
    child.on('error', () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
}

// Pure decision for the hook's self-heal: should THIS SessionStart spawn a
// daemon? Separated from the side effects so it's unit-testable.
export function shouldSpawnDaemon({ autostart, daemonPid, lastAttemptMs, now, cooldownMs }) {
  if (autostart === false) return false;                                  // explicit opt-out
  if (daemonPid) return false;                                            // already running
  if (lastAttemptMs && now - lastAttemptMs < cooldownMs) return false;    // within the cooldown
  return true;
}

// Self-heal entry point, called by the SessionStart hook. Best-effort and fast:
// if no daemon is running (reboot, crash, OS sleep, closed terminal — or simply
// a platform with no login-autostart entry), bring one up. Stamps the cooldown
// marker BEFORE spawning so sibling SessionStart hooks racing this one skip
// instead of each launching a throwaway. Returns the spawned child, or null.
export function ensureDaemonRunning({ autostart = true, now = Date.now(), cooldownMs = SPAWN_COOLDOWN_MS } = {}) {
  // Hard opt-out for the test suite: hook tests fire SessionStart with TMPDIR
  // pointed at a scratch dir, so no daemon is ever found there and each run
  // spawned a real detached dev-mode daemon. It outlived the test, was
  // invisible to `claude-rpc stop` (its pid file lives in the scratch dir),
  // and pushed unprivatized presence to Discord.
  if (process.env.CLAUDE_RPC_NO_AUTOSTART) return null;
  let lastAttemptMs = 0;
  try { if (existsSync(SPAWN_MARKER)) lastAttemptMs = statSync(SPAWN_MARKER).mtimeMs; } catch { /* unreadable — treat as never */ }
  if (!shouldSpawnDaemon({ autostart, daemonPid: daemonAlive(), lastAttemptMs, now, cooldownMs })) return null;
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* exists / unwritable */ }
  try { writeFileSync(SPAWN_MARKER, String(now)); } catch { /* best-effort cooldown */ }
  return spawnDaemonDetached();
}

// Atomic single-instance claim, called once by the daemon at startup. Returns
// the pid of an already-running daemon (caller should exit), or null when WE
// now own the pid file. The exclusive-create ('wx') makes the pid file itself
// the mutex: only one of N simultaneously-starting daemons can create it; the
// losers read the winner's live pid and step aside. A stale file (dead owner,
// empty, or our own recycled pid) is reclaimed and the create retried — so a
// crashed daemon never blocks its successor.
export function claimSingleInstance({ pidPath = PID_PATH, pid = process.pid, alive = isAlive } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let fd;
    try {
      fd = openSync(pidPath, 'wx'); // atomic: throws EEXIST if the file already exists
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Unexpected (perms, missing dir). Best-effort write and take ownership
        // rather than refusing to start.
        try { writeFileSync(pidPath, String(pid)); } catch { /* unwritable — run lockless */ }
        return null;
      }
      let owner = 0;
      try { owner = Number(readFileSync(pidPath, 'utf8')) || 0; } catch { /* mid-write — reclaim */ }
      if (owner && owner !== pid && alive(owner)) return owner; // a live daemon already owns it
      try { unlinkSync(pidPath); } catch { /* a racer reclaimed it first */ }
      continue; // retry the exclusive create
    }
    try { writeFileSync(fd, String(pid)); } finally { try { closeSync(fd); } catch { /* already closed */ } }
    return null; // we created the file → we are THE daemon
  }
  // Repeatedly lost the reclaim race (extreme contention) — proceed best-effort.
  try { writeFileSync(pidPath, String(pid)); } catch { /* unwritable */ }
  return null;
}
