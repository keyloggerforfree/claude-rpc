// Runs one transcript scan in a SHORT-LIVED child process for the daemon.
//
// Parsing transcripts churns through a lot of garbage (a cold scan JSON-parses
// every line of every transcript, 25MB+ files included). V8 and the allocator
// keep that memory after a GC, so an in-process scan left the always-on daemon
// sitting at 150-250MB for a presence card. In a child, all of it goes back to
// the OS when the child exits; the daemon just re-reads aggregate.json (which
// scan() writes) and stays near node's baseline.
//
// Output contract: one JSON line on stdout, { scanned, skipped, removed, total }.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { scan } from './scanner.js';
import { IS_PACKAGED, CANONICAL_EXE, ROOT } from './paths.js';
import { join } from 'node:path';

export function runScanWorker(force = false) {
  const { scanned, skipped, removed, total } = scan({ force });
  process.stdout.write(JSON.stringify({ scanned, skipped, removed, total }) + '\n');
}

// Same launch recipe as the daemon itself (ensure-daemon.spawnDaemonDetached):
// packaged → "<exe>" scan-worker, dev/npm → "<node>" "<abs scan-worker.js>".
// Resolves with the child's summary; rejects on spawn failure, a non-zero exit,
// unparseable output or `timeoutMs` — the caller then scans in-process instead.
export function scanInChild({ force = false, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const exe = (IS_PACKAGED && existsSync(CANONICAL_EXE)) ? CANONICAL_EXE : process.execPath;
    const args = IS_PACKAGED ? ['scan-worker'] : [join(ROOT, 'src', 'scan-worker.js')];
    if (force) args.push('--force');
    let out = '';
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`scan worker exited ${code}`)); return; }
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(e); }
    });
  });
}

const argv1 = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
if (argv1.endsWith('/src/scan-worker.js')) {
  runScanWorker(process.argv.includes('--force'));
}
