#!/usr/bin/env node
// Cut a release in one command. Bumps every place the version lives, rolls
// CHANGELOG.md's [Unreleased] section into a dated entry, runs the tests, then
// commits, tags and pushes. The tag push is what ships: release.yml runs the
// test matrix, builds the binaries and installers, publishes to npm and
// creates the GitHub Release; the Homebrew tap bumps itself from npm.
//
//   node scripts/release.mjs 1.6.0 --note "one line for the site changelog"
//   node scripts/release.mjs minor --note "…"      patch | minor | major work too
//   node scripts/release.mjs 1.6.0 --no-site-note  skip the homepage changelog line
//   node scripts/release.mjs 1.6.0 --dry-run       show what would change, touch nothing
//
// Refuses unless you're on a clean `main` that matches origin, the tag is new,
// and [Unreleased] has something in it. The --note text is HTML (it goes
// straight into site/index.html's #changelog-list), so `<code>` and entities work.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { PAGES, syncPage } from './sync-nav.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/rar-file/claude-rpc';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, spec) {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`current version \`${current}\` isn't x.y.z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (spec === 'major') return `${maj + 1}.0.0`;
  if (spec === 'minor') return `${maj}.${min + 1}.0`;
  if (spec === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (!SEMVER.test(spec)) throw new Error(`\`${spec}\` isn't x.y.z, patch, minor or major`);
  const n = SEMVER.exec(spec).slice(1).map(Number);
  const newer = n[0] - maj || n[1] - min || n[2] - pat;
  if (newer <= 0) throw new Error(`${spec} isn't newer than ${current}`);
  return spec;
}

// Move the body of `## [Unreleased]` under a new `## [version] - date`
// heading (leaving [Unreleased] empty) and repoint the compare links at the
// bottom. Returns { text, notes } where notes is the moved body.
export function rollChangelog(text, version, date, prev) {
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!head) throw new Error('CHANGELOG.md has no `## [Unreleased]` heading');
  const bodyStart = head.index + head[0].length;
  const next = text.slice(bodyStart).search(/^## \[/m);
  const bodyEnd = next === -1 ? text.length : bodyStart + next;
  const notes = text.slice(bodyStart, bodyEnd).trim();
  if (!notes) throw new Error('[Unreleased] is empty: add the changes to CHANGELOG.md first');

  let out = text.slice(0, bodyStart) + `\n## [${version}] - ${date}\n\n${notes}\n\n` + text.slice(bodyEnd);

  const unrelLink = /^\[Unreleased\]: .*$/m;
  const links = `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n[${version}]: ${REPO}/compare/v${prev}...v${version}`;
  out = unrelLink.test(out) ? out.replace(unrelLink, links) : out.trimEnd() + `\n\n${links}\n`;
  return { text: out, notes };
}

// First bullet of the notes, stripped of markdown, for the commit subject.
export function summarize(notes, max = 72) {
  const bullet = notes.split('\n').find((l) => /^\s*[-*] /.test(l)) || notes.split('\n')[0] || '';
  const plain = bullet
    .replace(/^\s*[-*] /, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(?<=[.:;])\s/)[0]
    .replace(/[.:;]$/, '');
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

export function bumpIndexHtml(html, version, date, note) {
  let out = html
    .replace(/"softwareVersion": "[^"]*"/, `"softwareVersion": "${version}"`)
    .replace(/"dateModified": "[^"]*"/, `"dateModified": "${date}"`);
  if (note != null) {
    const list = '<ul id="changelog-list">\n';
    if (!out.includes(list)) throw new Error('site/index.html has no <ul id="changelog-list">');
    out = out.replace(list, `${list}      <li><span class="v">v${version}</span> <span class="note">${note}</span></li>\n`);
  }
  return out;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function die(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { spec: null, note: null, noSiteNote: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--note') opts.note = argv[++i];
    else if (a.startsWith('--note=')) opts.note = a.slice(7);
    else if (a === '--no-site-note') opts.noSiteNote = true;
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (!a.startsWith('-') && !opts.spec) opts.spec = a;
    else die(`unknown argument \`${a}\``);
  }
  if (!opts.spec) die('usage: node scripts/release.mjs <x.y.z|patch|minor|major> --note "…" [--no-site-note] [--dry-run]');
  if (opts.note == null && !opts.noSiteNote) die('pass --note "<one line for the site changelog>" (or --no-site-note)');
  if (opts.note != null && !opts.note.trim()) die('--note is empty');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

  const pkgText = read('package.json');
  const prev = JSON.parse(pkgText).version;
  let version;
  try { version = nextVersion(prev, opts.spec); } catch (e) { die(e.message); }
  const tag = `v${version}`;
  const date = new Date().toISOString().slice(0, 10);

  // Preconditions: clean main, in step with origin, new tag.
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') die(`on \`${branch}\`, not main`);
  if (git('status', '--porcelain')) die('working tree is not clean: commit or stash first');
  git('fetch', '--quiet', '--tags', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) die('main and origin/main differ: pull or push first');
  if (git('tag', '--list', tag)) die(`tag ${tag} already exists`);

  // Compute every edit in memory first so a failure leaves nothing half-done.
  const edits = new Map();
  edits.set('package.json', pkgText.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));

  const lockText = read('package-lock.json');
  const lock = JSON.parse(lockText);
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  edits.set('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

  const verText = read('src/version.js');
  if (!/const BAKED = '[^']*';/.test(verText)) die('src/version.js has no `const BAKED = \'…\';`');
  edits.set('src/version.js', verText.replace(/const BAKED = '[^']*';/, `const BAKED = '${version}';`));

  let rolled;
  try { rolled = rollChangelog(read('CHANGELOG.md'), version, date, prev); } catch (e) { die(e.message); }
  edits.set('CHANGELOG.md', rolled.text);

  for (const [rel, cfg] of Object.entries(PAGES)) {
    const p = `site/${rel}`;
    let html = read(p);
    if (rel === 'index.html') html = bumpIndexHtml(html, version, date, opts.noSiteNote ? null : opts.note);
    edits.set(p, syncPage(html, cfg, version));
  }

  const changed = [...edits].filter(([rel, text]) => text !== read(rel)).map(([rel]) => rel);
  const subject = `release: ${version} — ${opts.note ? opts.note.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '') : summarize(rolled.notes)}`;

  console.log(`\n  ${prev} → ${version}  (${tag}, ${date})\n`);
  for (const rel of changed) console.log(`  ~ ${rel}`);
  console.log(`\n  commit: ${subject}\n`);

  if (opts.dryRun) {
    console.log('  dry run: nothing written.\n');
    return;
  }

  for (const rel of changed) writeFileSync(join(ROOT, rel), edits.get(rel));

  console.log('  running npm test…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const t = spawnSync(npm, ['test'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  if (t.status !== 0) die('tests failed: the bump is left in the working tree (git checkout . to undo); nothing committed');

  git('add', '--', ...changed);
  git('commit', '--quiet', '-m', subject);
  git('tag', tag);
  git('push', '--quiet', 'origin', 'main');
  git('push', '--quiet', 'origin', tag);

  console.log(`\n  pushed ${tag}. release.yml takes it from here:`);
  console.log(`  ${REPO}/actions/workflows/release.yml\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
