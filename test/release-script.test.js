// scripts/release.mjs: the pure pieces (version bump, changelog roll, commit
// subject, homepage bump). The git/npm side is exercised by actually releasing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { nextVersion, rollChangelog, summarize, bumpIndexHtml } = await import('../scripts/release.mjs');

test('nextVersion: keywords and explicit versions', () => {
  assert.equal(nextVersion('1.5.4', 'patch'), '1.5.5');
  assert.equal(nextVersion('1.5.4', 'minor'), '1.6.0');
  assert.equal(nextVersion('1.5.4', 'major'), '2.0.0');
  assert.equal(nextVersion('1.5.4', '1.10.0'), '1.10.0');
  assert.throws(() => nextVersion('1.5.4', '1.5.4'), /isn't newer/);
  assert.throws(() => nextVersion('1.5.4', '1.4.9'), /isn't newer/);
  assert.throws(() => nextVersion('1.5.4', 'v1.6.0'), /isn't x\.y\.z/);
});

const CHANGELOG = `# Changelog

## [Unreleased]

**Fixed**

- **Thing one** got fixed. Longer explanation here.
- Thing two.

## [1.5.4] - 2026-10-22

- old

[Unreleased]: https://github.com/rar-file/claude-rpc/compare/v1.5.4...HEAD
[1.5.4]: https://github.com/rar-file/claude-rpc/compare/v1.5.2...v1.5.4
`;

test('rollChangelog: moves [Unreleased] under a dated heading and fixes links', () => {
  const { text, notes } = rollChangelog(CHANGELOG, '1.6.0', '2026-10-23', '1.5.4');
  assert.match(notes, /^\*\*Fixed\*\*/);
  assert.ok(text.includes('## [Unreleased]\n\n## [1.6.0] - 2026-10-23\n\n**Fixed**\n'));
  assert.ok(text.includes('- Thing two.\n\n## [1.5.4] - 2026-10-22'));
  assert.ok(text.includes('[Unreleased]: https://github.com/rar-file/claude-rpc/compare/v1.6.0...HEAD\n[1.6.0]: https://github.com/rar-file/claude-rpc/compare/v1.5.4...v1.6.0\n[1.5.4]:'));
  // Rolling again with nothing new refuses.
  assert.throws(() => rollChangelog(text, '1.6.1', '2026-10-24', '1.6.0'), /\[Unreleased\] is empty/);
});

test('summarize: first bullet, plain text, first sentence', () => {
  assert.equal(summarize('**Fixed**\n\n- **Thing one** got fixed. More.\n- Two.'), 'Thing one got fixed');
  assert.equal(summarize('- see [docs](https://x) for `cmd`'), 'see docs for cmd');
  assert.equal(summarize('- ' + 'a'.repeat(100)).length, 72);
});

test('bumpIndexHtml: version, date and a new changelog line on top', () => {
  const html = '"softwareVersion": "1.5.4",\n"dateModified": "2026-10-22",\n<ul id="changelog-list">\n      <li>old</li>\n';
  const out = bumpIndexHtml(html, '1.6.0', '2026-10-23', 'new <code>thing</code>');
  assert.ok(out.includes('"softwareVersion": "1.6.0"'));
  assert.ok(out.includes('"dateModified": "2026-10-23"'));
  assert.ok(out.includes('<ul id="changelog-list">\n      <li><span class="v">v1.6.0</span> <span class="note">new <code>thing</code></span></li>\n      <li>old</li>'));
  assert.equal(bumpIndexHtml(html, '1.6.0', '2026-10-23', null).includes('v1.6.0'), false);
});
