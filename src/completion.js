// Shell tab completion. Each script is a thin shim that asks
// `claude-rpc __complete <words…>` for candidates, so the command table in
// commands.js is the only list — new commands complete without reinstalling.
//
//   claude-rpc completion <bash|zsh|fish|powershell>   print the script
//   claude-rpc completion install [shell]              turn it on
//   claude-rpc completion uninstall                    turn it off everywhere
//
// install writes the script under <config dir>/completion/ and adds one
// marked line to the shell's rc file (fish needs no rc line: its completions
// dir autoloads). Re-running is a no-op; uninstall removes exactly the marked
// block.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { SHELLS, FILES } from './commands.js';

const BEGIN = '# >>> claude-rpc completion >>>';
const END = '# <<< claude-rpc completion <<<';

export function scriptFor(shell) {
  switch (shell) {
    case 'bash': return `# claude-rpc tab completion (bash)
_claude_rpc() {
  local cur=\${COMP_WORDS[COMP_CWORD]} line
  local -a words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  COMPREPLY=()
  while IFS= read -r line; do
    [ "$line" = "${FILES}" ] && { COMPREPLY=($(compgen -f -- "$cur")); return; }
    [ -n "$line" ] && COMPREPLY+=("\${line%%$'\\t'*}")
  done < <(claude-rpc __complete "\${words[@]}" 2>/dev/null)
}
complete -o nosort -F _claude_rpc claude-rpc 2>/dev/null || complete -F _claude_rpc claude-rpc
`;
    case 'zsh': return `#compdef claude-rpc
# claude-rpc tab completion (zsh)
_claude_rpc() {
  local -a lines items
  local l
  lines=("\${(@f)$(claude-rpc __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ "\${lines[1]}" == "${FILES}" ]]; then _files; return; fi
  for l in $lines; do
    [[ -z $l ]] && continue
    if [[ $l == *$'\\t'* ]]; then items+=("\${\${l%%$'\\t'*}//:/\\\\:}:\${l#*$'\\t'}")
    else items+=("\${l//:/\\\\:}"); fi
  done
  _describe -V 'claude-rpc' items
}
if (( ! $+functions[compdef] )); then autoload -Uz compinit && compinit; fi
compdef _claude_rpc claude-rpc
`;
    case 'fish': return `# claude-rpc tab completion (fish)
function __claude_rpc_complete
    set -l tokens (commandline -opc) (commandline -ct)
    set -l out (claude-rpc __complete $tokens[2..-1] 2>/dev/null)
    if test "$out[1]" = "${FILES}"
        __fish_complete_path (commandline -ct)
    else
        printf '%s\\n' $out
    end
end
complete -c claude-rpc -f -k -a '(__claude_rpc_complete)'
`;
    case 'powershell': return `# claude-rpc tab completion (PowerShell)
Register-ArgumentCompleter -Native -CommandName claude-rpc, claude-rpc.exe -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  # Words before the cursor; the one being typed goes via env because
  # Windows PowerShell drops empty-string arguments to native commands.
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 |
    Where-Object { $_.Extent.EndOffset -lt $cursorPosition } | ForEach-Object { $_.Extent.Text })
  $env:CLAUDE_RPC_COMP_CUR = $wordToComplete
  $out = @(& claude-rpc __complete @words 2>$null)
  Remove-Item Env:CLAUDE_RPC_COMP_CUR -ErrorAction SilentlyContinue
  if ($out.Count -gt 0 -and $out[0] -eq '${FILES}') { return }
  foreach ($l in $out) {
    if (-not $l) { continue }
    $p = $l -split "\`t", 2
    $tip = if ($p.Count -gt 1) { $p[1] } else { $p[0] }
    [System.Management.Automation.CompletionResult]::new($p[0], $p[0], 'ParameterValue', $tip)
  }
}
`;
    default: return null;
  }
}

// The shell the user is most likely typing in.
export function detectShell(env = process.env, platform = process.platform) {
  const sh = basename(env.SHELL || '').replace(/\.exe$/i, '');
  if (SHELLS.includes(sh)) return sh;
  if (sh === 'pwsh') return 'powershell';
  if (platform === 'win32') return 'powershell';
  return platform === 'darwin' ? 'zsh' : 'bash';
}

export function completionDir(configDir) {
  return join(configDir, 'completion');
}

// Where each shell's pieces live. `rc` null → no rc edit needed.
export function targets(shell, { configDir, env = process.env, home = homedir(), profilePath, platform = process.platform } = {}) {
  const dir = completionDir(configDir);
  switch (shell) {
    // macOS Terminal opens login shells, which read .bash_profile, not .bashrc.
    case 'bash': return { script: join(dir, 'claude-rpc.bash'), rc: join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc') };
    case 'zsh':  return { script: join(dir, 'claude-rpc.zsh'), rc: join(env.ZDOTDIR || home, '.zshrc') };
    case 'fish': return { script: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'fish', 'completions', 'claude-rpc.fish'), rc: null };
    case 'powershell': return { script: join(dir, 'claude-rpc.ps1'), rc: profilePath || null };
    default: return null;
  }
}

function sourceLine(shell, script) {
  if (shell === 'powershell') return `if (Test-Path '${script}') { . '${script}' }`;
  return `[ -f '${script}' ] && . '${script}'`;
}

// rc text with our marked block added (idempotent) or removed.
export function withBlock(text, line) {
  const clean = withoutBlock(text);
  const sep = clean && !clean.endsWith('\n') ? '\n' : '';
  return `${clean}${sep}${BEGIN}\n${line}\n${END}\n`;
}

export function withoutBlock(text) {
  const a = text.indexOf(BEGIN);
  if (a === -1) return text;
  const b = text.indexOf(END, a);
  if (b === -1) return text;
  let tail = text.slice(b + END.length);
  if (tail.startsWith('\r\n')) tail = tail.slice(2);
  else if (tail.startsWith('\n')) tail = tail.slice(1);
  return text.slice(0, a) + tail;
}

// PowerShell's $PROFILE path (CurrentUserCurrentHost), asked from the shell.
export async function powershellProfile() {
  const { spawnSync } = await import('node:child_process');
  for (const exe of ['pwsh', 'powershell']) {
    try {
      const r = spawnSync(exe, ['-NoProfile', '-NoLogo', '-Command', '$PROFILE'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const p = (r.stdout || '').trim();
      if (r.status === 0 && p) return p;
    } catch { /* not installed — try the next one */ }
  }
  return null;
}

export function isInstalled(shell, opts) {
  const t = targets(shell, opts);
  if (!t || !existsSync(t.script)) return false;
  if (!t.rc) return true;
  try { return readFileSync(t.rc, 'utf8').includes(BEGIN); } catch { return false; }
}

// Install for one shell. Returns { script, rc, changed }.
export function install(shell, opts) {
  const t = targets(shell, opts);
  if (!t) throw new Error(`unknown shell: ${shell}`);
  if (shell === 'powershell' && !t.rc) throw new Error('could not find your PowerShell $PROFILE');
  const body = scriptFor(shell);
  let changed = false;
  const prev = existsSync(t.script) ? readFileSync(t.script, 'utf8') : null;
  if (prev !== body) {
    mkdirSync(dirname(t.script), { recursive: true });
    writeFileSync(t.script, body);
    changed = true;
  }
  if (t.rc) {
    const before = existsSync(t.rc) ? readFileSync(t.rc, 'utf8') : '';
    const after = withBlock(before, sourceLine(shell, t.script));
    if (after !== before) {
      mkdirSync(dirname(t.rc), { recursive: true });
      writeFileSync(t.rc, after);
      changed = true;
    }
  }
  return { ...t, changed };
}

// Remove from every shell we may have touched. Returns the paths changed.
export function uninstall(opts) {
  const touched = [];
  for (const shell of SHELLS) {
    const t = targets(shell, opts);
    if (!t) continue;
    if (existsSync(t.script)) { try { unlinkSync(t.script); touched.push(t.script); } catch { /* locked — leave it */ } }
    if (t.rc && existsSync(t.rc)) {
      const before = readFileSync(t.rc, 'utf8');
      const after = withoutBlock(before);
      if (after !== before) { writeFileSync(t.rc, after); touched.push(t.rc); }
    }
  }
  return touched;
}
