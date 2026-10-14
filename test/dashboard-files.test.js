// Every local file the dashboard main/preload process require()s must be in
// electron-builder's build.files allowlist, or it is missing from app.asar and
// the packaged app dies on launch (issue #39: port.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../dashboard/', import.meta.url);
const { build } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));

test('dashboard: every local require() is packaged in build.files', () => {
  const missing = [];
  for (const entry of ['main.js', 'preload.js']) {
    const src = readFileSync(new URL(entry, dir), 'utf8');
    for (const [, rel] of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
      const file = rel.endsWith('.js') || rel.endsWith('.json') ? rel : `${rel}.js`;
      if (!build.files.includes(file)) missing.push(`${entry} → ${file}`);
    }
  }
  assert.deepEqual(missing, [], 'add these to dashboard/package.json build.files');
});
