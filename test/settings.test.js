// The /settings page's server side (src/server/settings.js): the config save
// path, its validation, and the guard on write requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/default-config.js';
import { mergeConfig } from '../src/config.js';

const { saveSettings, validateConfig, writeAllowed, STATUSES, stopDaemons } = await import('../src/server/settings.js');

const clone = (v) => structuredClone(v);
const tmpConfig = (content) => {
  const path = join(mkdtempSync(join(tmpdir(), 'crpc-settings-')), 'config.json');
  if (content !== undefined) writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};
const view = (raw) => mergeConfig(DEFAULT_CONFIG, raw);

test('saveSettings writes only the edited key, atomically', () => {
  const raw = { clientId: '1506443909406920948', appName: 'Mine' };
  const path = tmpConfig(raw);
  const base = view(raw);
  const edited = clone(base);
  edited.rotationIntervalMs = 20000;

  const r = saveSettings({ base, edited }, { path });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...raw, rotationIntervalMs: 20000 });
  assert.equal(r.config.rotationIntervalMs, 20000, 'returns the new effective config');
  assert.deepEqual(r.config.presence.buttons, DEFAULT_CONFIG.presence.buttons, 'defaults still apply, not frozen into the file');
  assert.deepEqual(readdirSync(join(path, '..')), ['config.json'], 'no tmp file left behind');
});

test('saveSettings creates the file when there is none', () => {
  const path = tmpConfig();
  const base = view({});
  const edited = clone(base);
  edited.presence.byStatus.working.details = 'Hacking on {project}';
  assert.equal(saveSettings({ base, edited }, { path }).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')),
    { presence: { byStatus: { working: { details: 'Hacking on {project}' } } } });
});

test('saveSettings refuses to overwrite a config it cannot parse', () => {
  const path = tmpConfig('{ "clientId": "150644390940692');
  const base = view({});
  const edited = clone(base);
  edited.appName = 'X';
  const r = saveSettings({ base, edited }, { path });
  assert.match(r.error, /isn't valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{ "clientId": "150644390940692', 'file untouched');
});

test('saveSettings rejects a config that would break the card, and writes nothing', () => {
  const path = tmpConfig();
  const base = view({});
  for (const mutate of [
    (c) => { c.clientId = 'nope'; },
    (c) => { c.clientId = ''; },
    (c) => { c.presence.buttons = [{ label: 'x', url: 'javascript:alert(1)' }]; },
    (c) => { c.presence.buttons = [1, 2, 3].map((n) => ({ label: `b${n}`, url: 'https://example.com' })); },
    (c) => { c.idleThresholdSec = -5; },
    (c) => { c.rotationIntervalMs = 'fast'; },
  ]) {
    const edited = clone(base);
    mutate(edited);
    const r = saveSettings({ base, edited }, { path });
    assert.ok(r.error, 'rejected');
    assert.equal(existsSync(path), false, 'nothing written');
  }
});

test('saveSettings needs both views', () => {
  const path = tmpConfig();
  assert.ok(saveSettings(null, { path }).error);
  assert.ok(saveSettings({ edited: {} }, { path }).error);
  assert.ok(saveSettings({ base: [], edited: {} }, { path }).error);
});

test('validateConfig accepts the shipped defaults', () => {
  assert.equal(validateConfig(DEFAULT_CONFIG), null);
});

test('STATUSES all have a default card', () => {
  for (const s of STATUSES) assert.ok(DEFAULT_CONFIG.presence.byStatus[s], `${s} has a byStatus block`);
});

test('writeAllowed: only same-origin JSON requests may change settings', () => {
  const host = '127.0.0.1:47474';
  const json = 'application/json';
  // The page itself.
  assert.equal(writeAllowed({ host, origin: `http://${host}`, 'content-type': json }), true);
  assert.equal(writeAllowed({ host: 'localhost:47474', origin: 'http://localhost:47474', 'content-type': 'application/json; charset=utf-8' }), true);
  // Non-browser client (no Origin header).
  assert.equal(writeAllowed({ host, 'content-type': json }), true);
  // Another site, another local port, or an opaque origin.
  assert.equal(writeAllowed({ host, origin: 'https://evil.example', 'content-type': json }), false);
  assert.equal(writeAllowed({ host, origin: 'http://127.0.0.1:3000', 'content-type': json }), false);
  assert.equal(writeAllowed({ host, origin: 'null', 'content-type': json }), false);
  // What a cross-site <form> can send without a preflight.
  assert.equal(writeAllowed({ host, origin: `http://${host}`, 'content-type': 'text/plain' }), false);
  assert.equal(writeAllowed({ host, origin: `http://${host}`, 'content-type': 'application/x-www-form-urlencoded' }), false);
  assert.equal(writeAllowed({ host, origin: `http://${host}` }), false);
});

// ── fork: the page's Stop must not leave stray daemons running ──────────
// Fakes only: the real process scan would find (and stop) the machine's own
// running daemon.
test('stopDaemons: stops the pid-file daemon AND strays the pid file does not know', async () => {
  let daemon = 7;
  const calls = {};
  const ok = await stopDaemons({
    pidAlive: () => daemon,
    find: () => [7, 42],                       // the scan sees the daemon itself too
    signalAll: ({ pid, strays }) => { calls.signal = { pid, strays }; return { signalled: true, strays, errors: [] }; },
    waitAll: async ({ strays }) => { calls.wait = strays; daemon = 0; return { killedDaemon: null, killedStrays: [] }; },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls.signal, { pid: 7, strays: [42] }, 'the daemon once, the stray separately');
  assert.deepEqual(calls.wait, [42], 'waits on (and would SIGKILL) the stray');
});

test('stopDaemons: a stray alone (no pid-file daemon) is still stopped', async () => {
  const calls = {};
  const ok = await stopDaemons({
    pidAlive: () => 0,
    find: () => [42],
    signalAll: ({ pid, strays }) => { calls.signal = { pid, strays }; return { signalled: false, strays, errors: [] }; },
    waitAll: async ({ strays }) => { calls.wait = strays; return { killedDaemon: null, killedStrays: [] }; },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls.signal, { pid: 0, strays: [42] });
});

test('stopDaemons: nothing running → nothing signalled', async () => {
  let signalled = false;
  const ok = await stopDaemons({ pidAlive: () => 0, find: () => [], signalAll: () => { signalled = true; return {}; } });
  assert.equal(ok, true);
  assert.equal(signalled, false);
});

// ── fork: saving from the page keeps settings the page doesn't show ─────
test('saveSettings keeps the fork\'s privacy keys (projectName, hotspot) when other settings change', () => {
  const raw = {
    clientId: '1506443909406920948',
    privacy: { patterns: ['*'], mode: 'name-only', projectName: 'Project', autoDetectGithubPrivate: false, hotspot: false },
  };
  const path = tmpConfig(raw);
  const base = view(raw);
  const edited = clone(base);
  edited.rotationIntervalMs = 20000;                // an unrelated edit
  edited.privacy.mode = 'hidden';                   // and one inside the same privacy block
  assert.equal(saveSettings({ base, edited }, { path }).ok, true);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.privacy.hotspot, false, 'privacy.hotspot survives');
  assert.equal(saved.privacy.projectName, 'Project', 'privacy.projectName survives');
  assert.equal(saved.privacy.mode, 'hidden');
  assert.deepEqual(saved.privacy.patterns, ['*']);
});
