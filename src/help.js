// `claude-rpc help` and `claude-rpc help <command>`, both rendered from the
// command table in commands.js.

import { c } from './ui.js';
import { VERSION } from './version.js';
import { GROUPS, ALIAS_HINT, findCommand, visibleCommands } from './commands.js';

const GROUP_STYLE = {
  start:   [c.green,   '▸'],
  stats:   [c.cyan,    '▤'],
  share:   [c.magenta, '↗'],
  privacy: [c.yellow,  '◐'],
  online:  [c.blue,    '◎'],
  daemon:  [c.green,   '●'],
  fix:     [c.red,     '✚'],
};

const width = () => Math.max(60, Math.min(process.stdout.columns || 100, 110));

// Word-wrap `text` to `w` columns, continuation lines indented by `pad`.
function wrap(text, w, pad) {
  if (w < 20 || text.length <= w) return text;
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > w) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join(`\n${' '.repeat(pad)}`);
}

function banner() {
  const title = `${c.bold}${c.magenta}◆ claude-rpc${c.reset}`;
  const tag = `${c.dim}Discord Rich Presence for Claude Code${c.reset}`;
  const ver = `${c.gray}v${VERSION}${c.reset}`;
  return `\n  ${title}  ${tag}  ${ver}\n`;
}

export function renderHelp() {
  const cmds = visibleCommands();
  // Long synopses (recap's date forms) collapse to the bare name; `help <cmd>` has them.
  const MAX = 24;
  const label = (cmd) => {
    const full = cmd.name + (cmd.usage ? ` ${cmd.usage}` : '');
    return full.length > MAX ? cmd.name : full;
  };
  const colW = cmds.reduce((m, cmd) => Math.max(m, label(cmd).length), 0);
  const descW = width() - colW - 8;
  const lines = [banner()];

  lines.push(`  ${c.dim}Usage:${c.reset} ${c.bold}claude-rpc${c.reset} ${c.cyan}<command>${c.reset} ${c.dim}[options]${c.reset}\n`);

  for (const [key, title] of GROUPS) {
    const [color, icon] = GROUP_STYLE[key] || [c.cyan, '·'];
    const inGroup = cmds.filter((cmd) => cmd.group === key);
    if (!inGroup.length) continue;
    lines.push(`  ${color}${icon}${c.reset} ${c.bold}${title}${c.reset}`);
    for (const cmd of inGroup) {
      const shown = label(cmd);
      const usage = shown !== cmd.name ? `${c.dim}${cmd.usage}${c.reset}` : '';
      const head = `${c.cyan}${c.bold}${cmd.name}${c.reset}${usage ? ` ${usage}` : ''}`;
      const pad = ' '.repeat(colW - shown.length + 2);
      lines.push(`    ${head}${pad}${wrap(cmd.summary, descW, colW + 6)}`);
    }
    lines.push('');
  }

  const tips = [
    ['one command in detail', 'claude-rpc help <command>'],
    ['tab completion', 'claude-rpc completion install'],
    ['something off?', 'claude-rpc doctor --fix'],
    ['docs', 'https://claude-rpc.com/docs'],
  ];
  const tipW = tips.reduce((m, [k]) => Math.max(m, k.length), 0);
  for (const [k, v] of tips) lines.push(`  ${c.gray}${k.padEnd(tipW)}${c.reset}  ${c.cyan}${v}${c.reset}`);
  lines.push('');
  lines.push(`  ${c.gray}exit codes: 0 ok · 1 usage error · 2 system error · 3 wrong state${c.reset}`);
  lines.push('');
  return lines.join('\n');
}

export function renderCommandHelp(name) {
  const cmd = findCommand(name);
  if (!cmd) return null;
  const lines = [''];
  const viaAlias = cmd.name !== name ? `  ${c.dim}(\`${name}\` still works — it's \`claude-rpc ${ALIAS_HINT[name] || cmd.name}\` now)${c.reset}` : '';
  lines.push(`  ${c.bold}${c.magenta}◆ claude-rpc ${cmd.name}${c.reset}${viaAlias}`);
  lines.push(`    ${cmd.summary}`);
  lines.push('');
  lines.push(`  ${c.dim}Usage${c.reset}`);
  lines.push(`    ${c.bold}claude-rpc${c.reset} ${c.cyan}${cmd.name}${c.reset}${cmd.usage ? ` ${cmd.usage}` : ''}${cmd.flags?.length ? ` ${c.dim}[options]${c.reset}` : ''}`);
  lines.push('');

  const table = (title, rows) => {
    if (!rows.length) return;
    const w = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
    lines.push(`  ${c.dim}${title}${c.reset}`);
    for (const [k, d] of rows) lines.push(`    ${c.cyan}${k.padEnd(w)}${c.reset}  ${d}`);
    lines.push('');
  };
  table('Choices', (cmd.subs || []).map(([s, d]) => [s, d]));
  table('Options', (cmd.flags || []).map(([f, d, v]) => {
    const val = Array.isArray(v) ? ` <${v.join('|')}>` : v === 'file' ? ' [file]' : v ? ' <value>' : '';
    return [f + val, d];
  }));
  if (cmd.examples?.length) {
    lines.push(`  ${c.dim}Examples${c.reset}`);
    for (const ex of cmd.examples) lines.push(`    ${c.gray}$${c.reset} ${ex}`);
    lines.push('');
  }
  if (cmd.aliases?.length) {
    lines.push(`  ${c.gray}also answers to: ${cmd.aliases.join(', ')}${c.reset}`);
    lines.push('');
  }
  return lines.join('\n');
}
