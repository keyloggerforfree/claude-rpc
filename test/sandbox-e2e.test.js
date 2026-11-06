// End to end: the real daemon, against a fake Discord, via scripts/sandbox/run.sh.
//
// Unit tests can't reach the daemon's presence path — pushPresence returns
// early unless Discord is connected, and daemon.js runs as a whole process —
// so a merge once left resolvePresence reading `opts.state` after it stopped
// taking `opts`: a ReferenceError on EVERY presence update that every unit
// test and `node --check` missed. These tests run the actual daemon and assert
// on what it actually sends. See scripts/sandbox/run.sh for the isolation
// (own HOME / config / TMPDIR / XDG_RUNTIME_DIR; autostart, community and
// auto-update off) — nothing outside a temp folder is touched.
//
// POSIX only: Unix sockets and bash. ~4s per scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN = fileURLToPath(new URL('../scripts/sandbox/run.sh', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../scripts/sandbox/fixtures/', import.meta.url));
const skip = process.platform === 'win32' && 'needs bash + Unix sockets';

// Run one fixture; return the script's exit status, full output, and the
// activities it reports as sent to Discord ("details | state | hover: x").
function sandbox(fixture, seconds = 3) {
  const r = spawnSync('bash', [RUN, FIXTURES + fixture, String(seconds)], { encoding: 'utf8', timeout: 60_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const sent = out.split('── sent to Discord ──')[1] || '';
  const activities = sent.split('\n').map((l) => l.trim()).filter((l) => l.includes(' | '));
  return { status: r.status, out, activities };
}

test('sandbox: a pending permission prompt holds "Waiting on you" (daemon presence path end to end)', { skip }, () => {
  const { status, out, activities } = sandbox('permission-prompt.json');
  assert.equal(status, 0, out);
  assert.ok(activities.length > 0, `the daemon never pushed a presence:\n${out}`);
  for (const a of activities) {
    assert.match(a, /^Waiting on you · Project \| .* \| hover: Permission needed$/, `unexpected activity: ${a}`);
  }
});

test('sandbox: a commit under name-only privacy reaches Discord without its message or branch', { skip }, () => {
  const { status, out, activities } = sandbox('commit-under-privacy.json');
  assert.equal(status, 0, out);
  assert.ok(activities.length > 0, `the daemon never pushed a presence:\n${out}`);
  for (const a of activities) assert.equal(a, 'Committed · Project | (no line 2) | hover: Committed');
  assert.doesNotMatch(out.split('── sent to Discord ──')[1], /acme-billing|invoice/, 'commit subject / branch leaked');
});
