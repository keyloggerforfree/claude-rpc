// SVG → PNG with whatever the machine already has, so claude-rpc stays at zero
// dependencies: rsvg-convert, then a Chromium-family browser in headless mode
// (Chrome, Edge, Brave, Chromium — Edge ships with every Windows 10/11), then
// ImageMagick or Inkscape. CLAUDE_RPC_BROWSER points at a browser binary
// explicitly.

import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Width/height of the root <svg>, from width/height or the viewBox.
export function svgSize(svg) {
  const tag = (svg.match(/<svg\b[^>]*>/i) || [''])[0];
  const num = (name) => {
    const m = tag.match(new RegExp(`\\s${name}="([\\d.]+)(px)?"`, 'i'));
    return m ? Number(m[1]) : null;
  };
  let w = num('width');
  let h = num('height');
  if (!w || !h) {
    const vb = tag.match(/viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/i);
    if (vb) { w = w || Number(vb[1]); h = h || Number(vb[2]); }
  }
  return { width: Math.ceil(w || 600), height: Math.ceil(h || 300) };
}

function onPath(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || env.Path || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

function browserCandidates(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']
      .map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`);
  }
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return roots.flatMap((r) => rel.map((p) => join(r, p)));
  }
  return [];
}

// The first available renderer as { kind, bin }, or null.
export function findRasterizer(env = process.env, platform = process.platform) {
  if (env.CLAUDE_RPC_BROWSER) return existsSync(env.CLAUDE_RPC_BROWSER) ? { kind: 'browser', bin: env.CLAUDE_RPC_BROWSER } : null;
  const rsvg = onPath('rsvg-convert', env, platform);
  if (rsvg) return { kind: 'rsvg', bin: rsvg };
  for (const p of browserCandidates(env, platform)) if (existsSync(p)) return { kind: 'browser', bin: p };
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser', 'msedge', 'chrome']) {
    const p = onPath(name, env, platform);
    if (p) return { kind: 'browser', bin: p };
  }
  const magick = onPath('magick', env, platform);
  if (magick) return { kind: 'magick', bin: magick };
  const inkscape = onPath('inkscape', env, platform);
  if (inkscape) return { kind: 'inkscape', bin: inkscape };
  return null;
}

// The argv for one renderer. Exported for tests.
export function rasterArgs(kind, { svgFile, htmlFile, out, width, height, scale, profileDir, root = false }) {
  switch (kind) {
    case 'rsvg': return ['-z', String(scale), '-b', 'none', '-o', out, svgFile];
    case 'magick': return ['-background', 'none', '-density', String(96 * scale), svgFile, out];
    case 'inkscape': return ['--export-type=png', `--export-filename=${out}`, `--export-dpi=${96 * scale}`, svgFile];
    case 'browser': return [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profileDir}`, '--default-background-color=00000000',
      `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`,
      `--screenshot=${out}`, ...(root ? ['--no-sandbox'] : []), pathToFileURL(htmlFile).href,
    ];
    default: throw new Error(`unknown rasterizer ${kind}`);
  }
}

// Render `svg` to a PNG at `out` (2× by default). Throws with a readable
// message when nothing on the machine can do it.
export async function svgToPng(svg, out, { scale = 2, env = process.env } = {}) {
  const r = findRasterizer(env);
  if (!r) {
    const e = new Error('no SVG renderer found');
    e.hint = process.platform === 'darwin'
      ? 'install Chrome, or `brew install librsvg` — or use --svg / --link instead'
      : process.platform === 'win32'
        ? 'Microsoft Edge does it — or set CLAUDE_RPC_BROWSER to a Chrome/Edge exe; --svg / --link work without one'
        : 'install librsvg (rsvg-convert) or Chromium — or use --svg / --link instead';
    throw e;
  }
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'claude-rpc-png-'));
  try {
    const { width, height } = svgSize(svg);
    const svgFile = join(dir, 'card.svg');
    const htmlFile = join(dir, 'card.html');
    writeFileSync(svgFile, svg);
    writeFileSync(htmlFile, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`);
    const args = rasterArgs(r.kind, {
      svgFile, htmlFile, out, width, height, scale,
      profileDir: join(dir, 'profile'), root: typeof process.getuid === 'function' && process.getuid() === 0,
    });
    // stdio to a file, not a pipe: Chrome's crashpad helper inherits the pipe
    // and outlives the browser, so spawnSync would wait on it until timeout.
    const errFile = join(dir, 'err.log');
    const fd = openSync(errFile, 'w');
    let res;
    try { res = spawnSync(r.bin, args, { stdio: ['ignore', fd, fd], timeout: 45_000, windowsHide: true }); } finally { closeSync(fd); }
    try { res.stderr = readFileSync(errFile, 'utf8'); } catch { /* keep whatever spawnSync had */ }
    let ok = false;
    try { ok = readFileSync(out).subarray(0, 4).equals(PNG_MAGIC); } catch { /* not written */ }
    if (!ok) {
      const why = (res.error?.message || res.stderr || '').trim().split('\n').slice(-2).join(' ');
      throw new Error(`${basenameOf(r.bin)} could not render the PNG${why ? `: ${why.slice(0, 200)}` : ''}`);
    }
    return { out, via: basenameOf(r.bin), width: width * scale, height: height * scale };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
  }
}

function basenameOf(p) {
  return String(p).split(/[\\/]/).pop();
}
