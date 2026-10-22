// `claude-rpc statcards` — every shareable card in one place, each to a live
// link (served by the worker, refreshes itself as you work), a PNG, or an SVG.
//
//   claude-rpc statcards                      menu: pick a card, then where it goes
//   claude-rpc statcards stats --link --md    Markdown for a README, to stdout
//   claude-rpc statcards poster --png         ./claude-poster.png
//   claude-rpc statcards badge --metric streak --svg streak.svg
//   claude-rpc statcards list                 what exists and where it can go
//
// Live links need a public profile (the worker renders from what it has
// published). PNG/SVG render locally from the aggregate when the card has a
// local renderer, otherwise from the live link. The older one-card commands
// (badge, card, github-stat, calendar, session-card, readme) still work
// unchanged.

import { writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { c, fail, EX_USER_ERROR, EX_BAD_STATE, EX_SYS_ERROR } from './ui.js';
import { isValidHandle } from './leaderboard.js';

const SITE = 'https://claude-rpc.com';
const DEFAULT_ENDPOINT = 'https://claude-rpc-totals.claude-rpc.workers.dev';

const q = (metric, fallback) => (metric && metric !== fallback ? `?metric=${metric}` : '');

export const CARDS = [
  { id: 'stats', title: 'Stats + heatmap', blurb: 'totals over your year heatmap — the README hero',
    metrics: ['tokens', 'hours'],
    hosted: (h, o) => `/stats/${h}.svg${q(o.metric, 'tokens')}`, page: (h) => `${SITE}/u/${h}`,
    local: async (ctx, o) => (await import('./calendar.js')).renderCalendarCard(ctx.aggregate(), { metric: o.metric || 'tokens', handle: ctx.handle }) },
  { id: 'profile', title: 'Profile card', blurb: 'tokens, sessions, hours and streak on one card',
    hosted: (h) => `/card/${h}.svg`, page: (h) => `${SITE}/u/${h}`,
    local: async (ctx) => (await import('./profile.js')).renderProfileCard(ctx.aggregate(), { handle: ctx.handle }) },
  { id: 'badge', title: 'Badge', blurb: 'a small shields-style badge',
    metrics: ['hours', 'tokens', 'streak', 'sessions'], localMetrics: ['hours', 'tokens', 'streak', 'prompts', 'cost', 'lines', 'files'],
    hosted: (h, o) => `/badge/${h}.svg?metric=${o.metric || 'hours'}`, page: () => `${SITE}/?ref=badge`,
    local: async (ctx, o) => (await import('./badge.js')).badgeSvg({ aggregate: ctx.aggregate(), metric: o.metric || 'hours', range: o.range || '7d' }) },
  { id: 'heatmap', title: 'Year heatmap', blurb: 'just the GitHub-style year grid',
    metrics: ['tokens', 'hours'],
    hosted: (h, o) => `/heatmap/${h}.svg${q(o.metric, 'tokens')}`, page: (h) => `${SITE}/u/${h}`,
    local: async (ctx, o) => (await import('./calendar.js')).renderCalendar(ctx.aggregate(), { metric: o.metric || 'tokens' }) },
  { id: 'poster', title: 'Poster', blurb: 'the big summary poster (great in Discord)',
    ranges: ['year', 'month', 'week', 'all'],
    local: async (ctx, o) => (await import('./card.js')).renderCard(ctx.aggregate(), { range: o.range || 'year' }) },
  { id: 'session', title: 'This session', blurb: 'recap of the session you are in',
    local: async (ctx) => (await import('./session-card.js')).renderSessionCard(ctx.liveVars(), {}) },
  { id: 'wrapped', title: 'Wrapped card', blurb: 'your year in review (after wrapped --publish)',
    hosted: (h, o) => `/wrapped/${h}.svg${o.year ? `?year=${o.year}` : ''}`, page: (h) => `${SITE}/wrapped/${h}` },
];

export const OUTPUTS = ['link', 'png', 'svg'];
const cardById = (id) => CARDS.find((k) => k.id === id) || null;

// Parse statcards' argv. `--png`/`--svg` take an optional path: the next token,
// unless it is a flag or a card name.
export function parseArgs(argv) {
  const o = { card: null, out: null, path: null, md: false, html: false, copy: false, metric: null, range: null, year: null };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => val ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : null);
    if (a === '--link' || a === '--url') o.out = 'link';
    else if (a === '--png' || a === '--svg') {
      o.out = a.slice(2);
      const n = val ?? argv[i + 1];
      if (n && !n.startsWith('-') && !cardById(n)) { o.path = n; if (val === null) i++; }
    } else if (a === '--md' || a === '--markdown') { o.md = true; o.out = o.out || 'link'; }
    else if (a === '--html') { o.html = true; o.out = o.out || 'link'; }
    else if (a === '--copy') o.copy = true;
    else if (a === '--metric' || a === '-m') o.metric = next();
    else if (a === '--range' || a === '-r') o.range = next();
    else if (a === '--year') o.year = next();
    else if (!a.startsWith('-') && !o.card) o.card = a;
    else return { error: `unknown option ${argv[i]}` };
  }
  return o;
}

export function snippets(card, handle, opts, endpoint = DEFAULT_ENDPOINT) {
  const url = endpoint.replace(/\/+$/, '') + card.hosted(handle, opts);
  const page = card.page(handle);
  const alt = card.id === 'badge' ? `Claude Code ${opts.metric || 'hours'}` : 'Claude Code stats';
  return {
    url,
    md: `[![${alt}](${url})](${page})`,
    html: `<a href="${page}"><img src="${url}" alt="${alt}" /></a>`,
  };
}

// Copy text to the system clipboard. Returns the tool used, or null.
export async function copyToClipboard(text, platform = process.platform, env = process.env) {
  const { spawnSync } = await import('node:child_process');
  const tries = platform === 'darwin' ? [['pbcopy', []]]
    : platform === 'win32' ? [['clip', []]]
    : [...(env.WAYLAND_DISPLAY ? [['wl-copy', []]] : []), ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [bin, args] of tries) {
    try {
      const r = spawnSync(bin, args, { input: text, timeout: 3000, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      if (r.status === 0) return bin;
    } catch { /* not installed — next */ }
  }
  return null;
}

function printList(ctx) {
  const live = ctx.live;
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ Stat cards${c.reset}  ${c.dim}— claude-rpc statcards <card> [--link|--png|--svg]${c.reset}`);
  console.log('');
  const w = CARDS.reduce((m, k) => Math.max(m, k.id.length), 0);
  for (const k of CARDS) {
    const where = [k.hosted ? 'link' : null, 'png', 'svg'].filter(Boolean).join(' · ');
    const extra = k.metrics ? `  ${c.gray}--metric ${(k.localMetrics ? [...new Set([...k.metrics, ...k.localMetrics])] : k.metrics).join('|')}${c.reset}`
      : k.ranges ? `  ${c.gray}--range ${k.ranges.join('|')}${c.reset}` : '';
    console.log(`    ${c.cyan}${k.id.padEnd(w)}${c.reset}  ${k.blurb}  ${c.dim}[${where}]${c.reset}${extra}`);
  }
  console.log('');
  console.log(live
    ? `  ${c.green}●${c.reset} ${c.dim}live links on — public profile ${c.reset}${c.cyan}@${ctx.handle}${c.reset}`
    : `  ${c.yellow}○${c.reset} ${c.dim}live links need a public profile: ${c.reset}${c.cyan}claude-rpc profile set --handle <name>${c.reset}${c.dim} then ${c.reset}${c.cyan}claude-rpc profile on${c.reset}`);
  console.log('');
}

async function renderSvg(card, ctx, opts) {
  if (card.local) return card.local(ctx, opts);
  // Hosted-only card: fetch what the worker serves.
  const { url } = snippets(card, ctx.handle, opts, ctx.endpoint);
  const res = await fetch(url, { headers: { 'user-agent': 'claude-rpc statcards' } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
}

// ctx: { aggregate(), liveVars(), config, prompt(q), enableProfile() }
export async function runStatcards(argv, ctx) {
  const o = parseArgs(argv);
  if (o.error) return fail(o.error, { hint: 'claude-rpc help statcards', code: EX_USER_ERROR });
  const cfg = ctx.config;
  const profile = cfg.profile || {};
  ctx.handle = isValidHandle(profile.handle) ? profile.handle : '';
  ctx.live = !!profile.enabled && !!ctx.handle;
  ctx.endpoint = (cfg.community?.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const tty = !!(process.stdout.isTTY && process.stdin.isTTY);
  const { select } = tty ? await import('./select.js') : {};

  if (o.card === 'list') return printList(ctx);

  // 1. Which card.
  let card = o.card ? cardById(o.card) : null;
  if (o.card && !card) {
    return fail(`no card called "${o.card}"`, { hint: `cards: ${CARDS.map((k) => k.id).join(', ')}`, code: EX_USER_ERROR });
  }
  if (!card) {
    if (!tty) return printList(ctx);
    console.log('');
    const i = await select({
      title: 'Which card?',
      options: CARDS.map((k) => ({ label: k.title, hint: k.blurb })),
    });
    if (i === null) return;
    card = CARDS[i];
  }

  // 2. Where it goes.
  let out = o.out;
  if (out === 'link' && !card.hosted) {
    return fail(`the ${card.id} card has no live link`, { hint: `save it instead: claude-rpc statcards ${card.id} --png`, code: EX_USER_ERROR });
  }
  if (!out && !tty) out = 'svg';
  if (!out) {
    const linkWhy = !card.hosted ? 'only renders on this machine' : !ctx.live ? 'needs a public profile — you can turn it on next' : '';
    const i = await select({
      title: 'Where to?',
      options: [
        { label: 'Live link', hint: 'paste once in a README or site; it keeps itself up to date', disabled: !card.hosted ? linkWhy : '' },
        { label: 'PNG image', hint: 'for Discord, X, LinkedIn, slides' },
        { label: 'SVG file', hint: 'crisp at any size' },
      ],
      initial: card.hosted && ctx.live ? 0 : 1,
    });
    if (i === null) return;
    out = OUTPUTS[i];
  }

  // 3. Options the card takes.
  const metrics = out === 'link' || !card.local ? card.metrics : (card.localMetrics || card.metrics);
  if (o.metric && metrics && !metrics.includes(o.metric)) {
    return fail(`--metric ${o.metric} isn't available for the ${card.id} card${out === 'link' ? ' as a live link' : ''}`,
      { hint: `use one of: ${metrics.join(', ')}`, code: EX_USER_ERROR });
  }
  if (o.metric && !metrics) return fail(`the ${card.id} card has no --metric`, { code: EX_USER_ERROR });
  if (o.range && !(card.ranges || card.id === 'badge')) return fail(`the ${card.id} card has no --range`, { code: EX_USER_ERROR });
  if (tty && !o.metric && metrics) {
    const list = metrics;
    const i = await select({ title: 'Counting?', options: list.map((m) => ({ label: m })) });
    if (i === null) return;
    o.metric = list[i];
  }
  if (tty && !o.range && card.ranges && out !== 'link') {
    const i = await select({ title: 'Covering?', options: card.ranges.map((r) => ({ label: r === 'all' ? 'all time' : `this ${r}` })) });
    if (i === null) return;
    o.range = card.ranges[i];
  }

  // Live link (or a hosted-only card's file) needs the public profile.
  if ((out === 'link' || !card.local) && !ctx.live) {
    if (!ctx.handle) {
      return fail('live cards need a public profile', {
        hint: ['claude-rpc profile set --handle <name>', 'claude-rpc profile on   — then run this again'], code: EX_BAD_STATE,
      });
    }
    if (!tty) return fail(`your profile @${ctx.handle} is private`, { hint: 'claude-rpc profile on', code: EX_BAD_STATE });
    const answer = (await ctx.prompt(`  Make @${ctx.handle} public so the link works? ${c.dim}[y/N]${c.reset} `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log(`  ${c.dim}left private — PNG and SVG work without it.${c.reset}`);
      return;
    }
    await ctx.enableProfile();
    ctx.live = true;
  }

  if (out === 'link') return emitLink(card, ctx, o, tty);
  return emitFile(card, ctx, o, out, tty);
}

async function emitLink(card, ctx, o, tty) {
  const s = snippets(card, ctx.handle, o, ctx.endpoint);
  // Pipe-friendly: just the one thing asked for.
  if (!tty) {
    const text = o.md ? s.md : o.html ? s.html : s.url;
    if (o.copy) await copyToClipboard(text);
    process.stdout.write(text + '\n');
    return;
  }

  console.log('');
  console.log(`  ${c.green}✓${c.reset}  ${c.bold}${card.title}${c.reset} ${c.dim}— live; it refreshes itself as you work${c.reset}`);
  console.log('');
  console.log(`    ${c.dim}link     ${c.reset}${c.cyan}${s.url}${c.reset}`);
  console.log(`    ${c.dim}markdown ${c.reset}${s.md}`);
  console.log(`    ${c.dim}html     ${c.reset}${s.html}`);
  console.log('');
  const which = o.html ? 'html' : 'md';
  const tool = await copyToClipboard(s[which]);
  if (tool) console.log(`  ${c.magenta}⧉${c.reset}  ${c.dim}${which === 'html' ? 'HTML' : 'Markdown'} copied — paste it into your README${c.reset}`);
  if (card.id === 'wrapped') console.log(`  ${c.dim}shows your year once it's published: ${c.reset}${c.cyan}claude-rpc wrapped --publish${c.reset}`);
  console.log('');
}

async function emitFile(card, ctx, o, out, tty) {
  let svg;
  try {
    svg = await renderSvg(card, ctx, o);
  } catch (e) {
    return fail(`couldn't render the ${card.id} card: ${e.message}`, { code: EX_SYS_ERROR });
  }
  const suffix = [card.id, o.metric && card.metrics && o.metric !== card.metrics[0] ? o.metric : null, o.range && o.range !== 'year' ? o.range : null]
    .filter(Boolean).join('-');
  const path = resolve(o.path || `claude-${suffix}.${out}`);
  const shown = relative(process.cwd(), path) || path;

  if (out === 'svg') {
    if (!o.path && !tty && !o.out) { process.stdout.write(svg); return; }
    writeFileSync(path, svg);
    console.log(`  ${c.green}✓${c.reset}  saved ${c.cyan}${shown}${c.reset}  ${c.dim}(${svg.length} bytes)${c.reset}`);
    return;
  }

  const { svgToPng } = await import('./png.js');
  try {
    const r = await svgToPng(svg, path);
    console.log(`  ${c.green}✓${c.reset}  saved ${c.cyan}${shown}${c.reset}  ${c.dim}(${r.width}×${r.height}, via ${r.via})${c.reset}`);
    if (tty) console.log(`     ${c.dim}drag it into Discord, X or a slide — it's 2× for sharp screens${c.reset}`);
  } catch (e) {
    return fail(e.message, { hint: e.hint || '', code: EX_SYS_ERROR });
  }
}
