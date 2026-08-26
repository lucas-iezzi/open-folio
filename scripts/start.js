#!/usr/bin/env node
'use strict';

// Friendly terminal front-end for running the portfolio server — this is what
// Start.bat/Start.command hand off to once Node.js and dependencies are confirmed
// installed. Replaces the old separate launcher GUI (a second Express server on its
// own port): now there's just one process, one window, and no setup step, since
// server.js generates its own .env on first run.

const path       = require('path');
const fs         = require('fs');
const net        = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const ENV_PATH    = path.join(ROOT, '.env');

const TTY = !!process.stdout.isTTY;
const C = {
  reset:  TTY ? '\x1b[0m'  : '',
  bold:   TTY ? '\x1b[1m'  : '',
  dim:    TTY ? '\x1b[2m'  : '',
  green:  TTY ? '\x1b[32m' : '',
  yellow: TTY ? '\x1b[33m' : '',
  red:    TTY ? '\x1b[31m' : '',
  cyan:   TTY ? '\x1b[36m' : '',
  gray:   TTY ? '\x1b[90m' : '',
};

function parseEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    // No explicit host: matches how server.js itself binds (app.listen(PORT)).
    // Binding to 127.0.0.1 specifically can succeed on Windows even when the real
    // server already holds 0.0.0.0 on the same port, giving a false "free" reading.
    s.listen(port);
  });
}

// Force-frees a port held by a stale process (e.g. a previous run whose window was
// closed rather than stopped with Ctrl+C, which can leave it running on Windows).
// Never targets our own PID, though that shouldn't be possible since this process
// never binds the port itself.
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { encoding: 'utf8' });
      let killed = false;
      for (const line of (r.stdout || '').trim().split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0' && parseInt(pid, 10) !== process.pid) {
          spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
          killed = true;
        }
      }
      return killed;
    }
    const r = spawnSync('sh', ['-c', `lsof -ti:${port}`], { encoding: 'utf8' });
    const pids = (r.stdout || '').trim().split('\n').filter((p) => /^\d+$/.test(p.trim()));
    for (const pid of pids) if (parseInt(pid, 10) !== process.pid) spawnSync('kill', ['-9', pid.trim()], { stdio: 'ignore' });
    return pids.length > 0;
  } catch {
    return false;
  }
}

// Confirms the port is actually free before we try to bind it, reclaiming it from a
// stale process if needed, instead of spawning a child that's doomed to crash with
// EADDRINUSE — which used to show up as a confusing "server stopped unexpectedly"
// while the *old*, still-running process kept the site reachable the whole time.
async function ensurePortFree(port) {
  if (await isPortFree(port)) return true;
  status('!', C.yellow, `Port ${port} is already in use — probably a previous session that didn't close cleanly. Freeing it…`);
  killPort(port);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isPortFree(port)) return true;
  }
  return false;
}

async function waitUntilUp(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortFree(port))) return true; // something is now listening
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* not critical — user can open the URL manually */ }
}

function status(symbol, color, text) {
  console.log('  ' + color + symbol + C.reset + ' ' + text);
}

function banner() {
  console.log();
  console.log(C.bold + '  open-folio' + C.reset);
  console.log(C.gray + '  ' + '─'.repeat(42) + C.reset);
}

// Non-blocking informational checklist — Start.bat/Start.command already installed
// Node and dependencies before handing off here, so this is a confirmation, not a gate.
function printChecklist() {
  const nodeOk = parseInt(process.versions.node.split('.')[0], 10) >= 18;
  const depsOk = fs.existsSync(path.join(ROOT, 'node_modules', 'express', 'package.json'));

  status(nodeOk ? '✓' : '✗', nodeOk ? C.green : C.red, 'Node.js v' + process.versions.node + (nodeOk ? '' : ' — requires v18+'));
  status(depsOk ? '✓' : '✗', depsOk ? C.green : C.red, depsOk ? 'Dependencies installed' : 'Dependencies missing — run: npm install');
  console.log();

  return nodeOk && depsOk;
}

let child         = null;
let stopRequested = false;
let openedBrowser = false;

async function runServer() {
  const env  = parseEnv();
  const port = parseInt(env.PORT, 10) || 3000;

  const portFree = await ensurePortFree(port);
  if (!portFree) {
    status('✗', C.red, `Port ${port} is still in use by something else and couldn't be freed automatically.`);
    console.log(C.dim + `  Close whatever's using port ${port}, or change PORT in .env, then try again.` + C.reset);
    return { code: null, portConflict: true };
  }

  console.log(C.dim + '  Starting server…' + C.reset);
  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { OPENFOLIO_QUIET_STARTUP: '1' }),
  });

  let exited = false;
  child.once('exit', () => { exited = true; });

  // A grace period before trusting "the port is up" as *this* child succeeding — if
  // something else grabbed the port between our check above and now (rare, but
  // possible), that child fails fast, and we'd rather show its crash than a false
  // "Running" a moment before it.
  (async () => {
    await new Promise((r) => setTimeout(r, 400));
    if (stopRequested || exited) return;
    const up = await waitUntilUp(port, 15000);
    if (stopRequested || exited) return;
    if (!up) {
      status('!', C.yellow, 'Still starting — check the output above for errors.');
      return;
    }
    status('●', C.green, `Running — ${C.cyan}http://localhost:${port}${C.reset}`);
    console.log('    Admin: ' + C.cyan + `http://localhost:${port}/admin/dashboard` + C.reset
      + C.dim + ' (no password needed on this machine)' + C.reset);
    console.log();
    console.log(C.dim + '  Press Ctrl+C to stop.' + C.reset);
    console.log();
    if (!openedBrowser) { openBrowser(`http://localhost:${port}/admin/dashboard`); openedBrowser = true; }
  })();

  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, portConflict: false }));
  });
}

async function promptRestartOrQuit() {
  console.log();
  console.log('  ' + C.yellow + '!' + C.reset + ' Press ' + C.bold + 'R' + C.reset + ' to restart, or '
    + C.bold + 'Q' + C.reset + ' to quit.');

  if (!process.stdin.isTTY) return 'quit'; // non-interactive shell — nothing to prompt

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (buf) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(buf.toString().trim().toLowerCase() === 'r' ? 'restart' : 'quit');
    });
  });
}

process.on('SIGINT', () => {
  stopRequested = true;
  // The child shares this console, so it usually receives SIGINT on its own too —
  // kill it explicitly as well since that isn't guaranteed on every platform.
  if (child && !child.killed) { try { child.kill('SIGINT'); } catch {} }
});

async function main() {
  banner();
  if (!printChecklist()) {
    console.log('  ' + C.red + 'Fix the issue above, then run this again.' + C.reset);
    console.log();
    process.exitCode = 1;
    return;
  }

  for (;;) {
    const result = await runServer();

    if (stopRequested) {
      console.log();
      status('●', C.gray, 'Stopped.');
      console.log(C.dim + '  Goodbye!' + C.reset);
      console.log();
      return;
    }

    console.log();
    if (!result.portConflict) {
      status('✗', C.red, `Server stopped unexpectedly (exit code ${result.code}).`);
    }
    const choice = await promptRestartOrQuit();
    if (choice === 'quit') {
      console.log(C.dim + '  Goodbye!' + C.reset);
      console.log();
      return;
    }
    console.log();
  }
}

main();
