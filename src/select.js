// A small arrow-key menu for interactive commands. ↑/↓ (or j/k) move, 1–9
// jump, Enter picks, Esc / q / Ctrl-C cancels (→ null). Disabled options are
// shown dimmed with their reason and skipped. Only call on a TTY.

import { c } from './ui.js';

export function select({ title, options, initial = 0, input = process.stdin, output = process.stdout }) {
  const enabled = (i) => options[i] && !options[i].disabled;
  let at = enabled(initial) ? initial : options.findIndex((o) => !o.disabled);
  if (at === -1) return Promise.resolve(null);
  let drawn = 0;
  const labelW = options.reduce((m, o) => Math.max(m, o.label.length), 0);

  const draw = () => {
    if (drawn) output.write(`\x1b[${drawn}A`);
    const lines = [`  ${c.bold}${title}${c.reset}  ${c.gray}↑↓ move · enter pick · esc cancel${c.reset}`];
    options.forEach((o, i) => {
      const n = i < 9 ? `${i + 1}` : ' ';
      const hint = o.disabled ? o.disabled : (o.hint || '');
      if (o.disabled) lines.push(`  ${c.gray}  ${n}  ${o.label.padEnd(labelW)}  ${hint}${c.reset}`);
      else if (i === at) lines.push(`  ${c.magenta}❯${c.reset} ${c.bold}${n}  ${c.cyan}${o.label.padEnd(labelW)}${c.reset}  ${c.dim}${hint}${c.reset}`);
      else lines.push(`    ${c.dim}${n}${c.reset}  ${o.label.padEnd(labelW)}  ${c.dim}${hint}${c.reset}`);
    });
    for (const l of lines) output.write(`\x1b[2K${l}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const move = (d) => {
      for (let i = 1; i <= options.length; i++) {
        const j = (at + d * i + options.length * i) % options.length;
        if (enabled(j)) { at = j; break; }
      }
    };
    const done = (v) => {
      input.off('data', onKey);
      try { input.setRawMode(false); } catch { /* not a tty */ }
      input.pause();
      output.write('\x1b[?25h');
      // Collapse the menu to one line showing the choice.
      output.write(`\x1b[${drawn}A\x1b[0J`);
      output.write(`  ${c.bold}${title}${c.reset}  ${v === null ? `${c.gray}cancelled${c.reset}` : `${c.cyan}${options[v].label}${c.reset}`}\n`);
      resolve(v);
    };
    const onKey = (buf) => {
      const k = buf.toString();
      if (k === '\x03' || k === '\x1b' || k === 'q') return done(null);
      if (k === '\r' || k === '\n') return done(at);
      if (k === '\x1b[A' || k === 'k') move(-1);
      else if (k === '\x1b[B' || k === 'j' || k === '\t') move(1);
      else if (/^[1-9]$/.test(k) && enabled(Number(k) - 1)) { at = Number(k) - 1; draw(); return done(at); }
      draw();
    };
    output.write('\x1b[?25l');
    draw();
    try { input.setRawMode(true); } catch { /* not a tty */ }
    input.resume();
    input.on('data', onKey);
  });
}
