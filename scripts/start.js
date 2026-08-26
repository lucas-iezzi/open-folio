#!/usr/bin/env node
'use strict';

// Friendly terminal front-end for running the portfolio server — this is what
// Start.bat/Start.command hand off to once Node.js and dependencies are confirmed
// installed. Replaces the old separate launcher GUI (a second Express server on its
// own port): now there's just one process, one window, and no setup step, since
// server.js generates its own .env on first run.

const path     = require('path');
const fs       = require('fs');
const net      = require('net');
const { spawn } = require('child_process');

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
  const envOk  = fs.existsSync(ENV_PATH);

  status(nodeOk ? '✓' : '✗', nodeOk ? C.green : C.red, 'Node.js v' + process.versions.node + (nodeOk ? '' : ' — requires v18+'));
  status(depsOk ? '✓' : '✗', depsOk ? C.green : C.red, depsOk ? 'Dependencies installed' : 'Dependencies missing — run: npm install');
  status(envOk  ? '✓' : '·', envOk  ? C.green : C.dim,  envOk  ? 'Configuration found'    : 'No configuration yet — will be created automatically');
  console.log();

  return nodeOk && depsOk;
}

let child          = null;
let stopRequested  = false;
let openedBrowser  = false;

function runServer() {
  const env  = parseEnv();
  const port = parseInt(env.PORT, 10) || 3000;

  status('●', C.yellow, 'Starting…');
  child = spawn(process.execPath, [SERVER_PATH], { cwd: ROOT, stdio: 'inherit' });

  // If another instance is already running on this port, the port shows "occupied"
  // almost instantly (it's already bound) — much faster than spawning a whole new
  // Node process for *this* child, which then fails to bind and exits a bit later.
  // Without the grace period below, "Running" can print before that crash message
  // even shows up, which is a confusing thing to see.
  let exited = false;
  child.once('exit', () => { exited = true; });

  (async () => {
    await new Promise((r) => setTimeout(r, 400));
    if (stopRequested || exited) return;
    const up = await waitUntilUp(port, 15000);
    if (stopRequested || exited) return;
    if (!up) {
      status('!', C.yellow, 'Still starting — check the output above for errors.');
      return;
    }
    status('●', C.green, `Running at ${C.cyan}http://localhost:${port}${C.reset}`);
    console.log('    Admin panel: ' + C.cyan + `http://localhost:${port}/admin/dashboard` + C.reset
      + C.dim + '  (no password needed on this machine)' + C.reset);
    console.log();
    console.log(C.dim + '  Press Ctrl+C to stop.' + C.reset);
    console.log();
    if (!openedBrowser) { openBrowser(`http://localhost:${port}`); openedBrowser = true; }
  })();

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
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
    const { code } = await runServer();

    if (stopRequested) {
      console.log();
      status('●', C.gray, 'Stopped.');
      console.log(C.dim + '  Goodbye!' + C.reset);
      console.log();
      return;
    }

    console.log();
    status('✗', C.red, `Server stopped unexpectedly (exit code ${code}).`);
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
