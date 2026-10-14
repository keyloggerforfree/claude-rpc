// installHooks marks the per-tool-call hooks async (so they never block a tool
// call) and ONLY those. Runs in a child with a temp HOME: installHooks writes
// the real ~/.claude/settings.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INSTALL = fileURLToPath(new URL('../src/install.js', import.meta.url));

function install(home) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { installHooks } = await import(${JSON.stringify(pathToFileURL(INSTALL).href)}); installHooks('x', { silent: true });`],
  { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks;
}

test('installHooks: PreToolUse/PostToolUse are async, turn events stay sync', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rpc-async-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hooks = install(home);
  for (const [event, entries] of Object.entries(hooks)) {
    const ours = entries.flatMap((e) => e.hooks).find((h) => h._claudeRpc);
    const want = event === 'PreToolUse' || event === 'PostToolUse';
    assert.equal(ours.async === true, want, `${event} async should be ${want}`);
  }
});

test('installHooks: upgrading an existing sync entry adds async, keeps third-party hooks', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rpc-async-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: '', hooks: [
      { type: 'command', command: 'claude-rpc hook PreToolUse', _claudeRpc: true },
      { type: 'command', command: 'other-tool check' },
    ] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'claude-rpc hook Stop', async: true, _claudeRpc: true }] }],
  } }));
  const hooks = install(home);
  const pre = hooks.PreToolUse[0].hooks;
  assert.equal(pre[0].async, true);
  assert.deepEqual(pre[1], { type: 'command', command: 'other-tool check' }, 'third-party hook untouched');
  assert.equal('async' in hooks.Stop[0].hooks[0], false, 'a stray async on a turn event is removed');
});
