// ensure-daemon.js — the startup-assurance primitives: the hook's self-heal
// decision (shouldSpawnDaemon), the daemon's race-proof single-instance claim
// (claimSingleInstance), and the liveness probe (isAlive). spawnDaemonDetached /
// ensureDaemonRunning launch a real detached process, so they're exercised
// end-to-end elsewhere; here we cover the pure logic + the fs-level claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const { shouldSpawnDaemon, claimSingleInstance, isAlive, ensureDaemonRunning, looksLikeRpcDaemon, findDaemonPids } = await import('../src/ensure-daemon.js');

// ── looksLikeRpcDaemon (stray-daemon scan behind `claude-rpc stop`) ─────
test('looksLikeRpcDaemon: matches dev, npm and packaged daemons', () => {
  assert.equal(looksLikeRpcDaemon('/usr/bin/node /home/o/Projects/claude-rpc/src/daemon.js'), true);
  assert.equal(looksLikeRpcDaemon('/usr/bin/node /home/o/node_modules/claude-rpc/src/daemon.js'), true);
  assert.equal(looksLikeRpcDaemon('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\o\\claude-rpc\\src\\daemon.js"'), true);
  assert.equal(looksLikeRpcDaemon('/home/o/.local/share/claude-rpc/claude-rpc daemon'), true);
  assert.equal(looksLikeRpcDaemon('"C:\\Users\\o\\AppData\\Roaming\\claude-rpc\\claude-rpc.exe" daemon'), true);
});

test('looksLikeRpcDaemon: never matches the CLI, hooks, or Claude Code', () => {
  assert.equal(looksLikeRpcDaemon('node /home/o/node_modules/claude-rpc/bin/claude-rpc.js stop'), false);
  assert.equal(looksLikeRpcDaemon('node /home/o/node_modules/claude-rpc/src/hook.js SessionStart'), false);
  assert.equal(looksLikeRpcDaemon('C:\\Users\\o\\AppData\\Roaming\\claude-rpc\\claude-rpc.exe stop'), false);
  assert.equal(looksLikeRpcDaemon('claude --resume'), false);
  assert.equal(looksLikeRpcDaemon('node /work/other-app/src/daemon.js'), false);
  assert.equal(looksLikeRpcDaemon(''), false);
});

test('looksLikeRpcDaemon: a shell or tool that merely MENTIONS the path is not a daemon', () => {
  // Regression: a substring match made `stop` SIGTERM the user's own shell.
  assert.equal(looksLikeRpcDaemon('/usr/bin/zsh -c ps aux | grep /home/o/claude-rpc/src/daemon.js'), false);
  assert.equal(looksLikeRpcDaemon('tail -f /home/o/node_modules/claude-rpc/src/daemon.js'), false);
  assert.equal(looksLikeRpcDaemon('vim /home/o/Projects/claude-rpc/src/daemon.js'), false);
  assert.equal(looksLikeRpcDaemon('node -e setInterval(()=>{},1e9) /x/claude-rpc/src/daemon.js'), false);
  // …while runtime flags before the script are still fine.
  assert.equal(looksLikeRpcDaemon('node --max-old-space-size=256 /home/o/claude-rpc/src/daemon.js'), true);
});

test('findDaemonPids: returns an array of numbers and never includes the caller', () => {
  const pids = findDaemonPids();
  assert.ok(Array.isArray(pids));
  assert.ok(pids.every((p) => Number.isInteger(p) && p > 0));
  assert.ok(!pids.includes(process.pid));
});

const NOW = 1_000_000;
const COOL = 15_000;

test('ensureDaemonRunning: CLAUDE_RPC_NO_AUTOSTART blocks the spawn even with autostart on', () => {
  const prev = process.env.CLAUDE_RPC_NO_AUTOSTART;
  process.env.CLAUDE_RPC_NO_AUTOSTART = '1';
  try {
    assert.equal(ensureDaemonRunning({ autostart: true, cooldownMs: 0 }), null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_RPC_NO_AUTOSTART;
    else process.env.CLAUDE_RPC_NO_AUTOSTART = prev;
  }
});

// ── shouldSpawnDaemon (hook self-heal decision) ────────────────────────
test('shouldSpawnDaemon: down + autostart on + no recent attempt → spawn', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 0, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), true);
});
test('shouldSpawnDaemon: autostart off → never', () => {
  assert.equal(shouldSpawnDaemon({ autostart: false, daemonPid: 0, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), false);
});
test('shouldSpawnDaemon: a daemon already alive → never', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 4321, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), false);
});
test('shouldSpawnDaemon: inside the cooldown → suppressed (storm / crash-loop guard)', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 0, lastAttemptMs: NOW - 5_000, now: NOW, cooldownMs: COOL }), false);
});
test('shouldSpawnDaemon: cooldown elapsed → spawn again', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 0, lastAttemptMs: NOW - 20_000, now: NOW, cooldownMs: COOL }), true);
});

// ── isAlive ────────────────────────────────────────────────────────────
test('isAlive: this process is alive; an absurd pid / 0 / NaN are not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2_000_000_000), false); // far above any OS pid_max
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(NaN), false);
});

// ── claimSingleInstance (race-proof single-instance) ───────────────────
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'daemon.pid');
}

// doctor.js and tui.js used to carry their own probe that read EPERM ("exists,
// but you may not signal it") as dead: doctor reported a running daemon as a
// stale pid file, the TUI as not running. Both now use isAlive. Run them in a
// child with a sandboxed HOME/TMPDIR so the real pid file is never touched.
test('doctor + tui treat an EPERM pid as running (shared isAlive)', (t) => {
  const box = mkdtempSync(join(tmpdir(), 'rpc-eperm-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const src = (m) => JSON.stringify(pathToFileURL(join(REPO, 'src', m)).href);
  const script = `
    const FAKE = 424242;
    const realKill = process.kill.bind(process);
    process.kill = (pid, sig) => {
      if (pid === FAKE) { const e = new Error('kill EPERM'); e.code = 'EPERM'; throw e; }
      return realKill(pid, sig);
    };
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const paths = await import(${src('paths.js')});
    mkdirSync(paths.STATE_DIR, { recursive: true });
    writeFileSync(paths.PID_PATH, String(FAKE));
    const tui = await import(${src('tui.js')});
    console.log('TUI_PID=' + tui.loadSnapshot().pid);
    const { runDoctor } = await import(${src('doctor.js')});
    runDoctor();
  `;
  const env = {
    ...process.env, HOME: box, USERPROFILE: box, XDG_CONFIG_HOME: join(box, '.config'),
    TMPDIR: join(box, 'tmp'), TMP: join(box, 'tmp'), TEMP: join(box, 'tmp'),
    CLAUDE_RPC_NO_AUTOSTART: '1', NO_COLOR: '1',
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30_000 });
  assert.match(r.stdout, /TUI_PID=424242/, `tui pid\n${r.stdout}\n${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.includes('daemon running')) || '';
  assert.match(line, /pid 424242/, `doctor line: ${line}`);
  assert.doesNotMatch(line, /stale/);
});

test('claimSingleInstance: fresh file → we own it (null, our pid written)', (t) => {
  const pidPath = tmp(t);
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => true });
  assert.equal(r, null);
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});

test('claimSingleInstance: a LIVE owner → step aside (returns owner pid, file untouched)', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, '99999');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: (p) => p === 99999 });
  assert.equal(r, 99999);
  assert.equal(readFileSync(pidPath, 'utf8'), '99999');
});

test('claimSingleInstance: a DEAD owner is reclaimed (null, our pid wins)', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, '99999');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => false });
  assert.equal(r, null);
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});

test('claimSingleInstance: an empty / garbage pid file is reclaimed', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, 'not-a-pid');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => true });
  assert.equal(r, null);
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});

test('claimSingleInstance: our OWN recycled pid in the file is reclaimed, not mistaken for a peer', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, '1234');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => true });
  assert.equal(r, null, 'owner === our pid cannot be a different live daemon → reclaim');
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});
