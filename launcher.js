#!/usr/bin/env node
'use strict';

/**
 * Portfolio Website Launcher
 * Interactive CLI for first-time setup, server management, and troubleshooting.
 * Usage: node launcher.js
 */

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const { spawnSync, spawn } = require('child_process');
const crypto   = require('crypto');
const net      = require('net');

const ROOT        = __dirname;
const ENV_PATH    = path.join(ROOT, '.env');
const SERVER_LOG  = path.join(ROOT, 'data', 'server.log');

let serverProc = null; // background server process handle

// ── ANSI colors ──────────────────────────────────────────────────────────────
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

const tick  = (s) => C.green  + '✓' + C.reset + ' ' + s;
const cross = (s) => C.red    + '✗' + C.reset + ' ' + s;
const warn  = (s) => C.yellow + '!' + C.reset + ' ' + s;
const arrow = (s) => C.cyan   + '→' + C.reset + ' ' + s;
const hr    = ()  => C.gray + '─'.repeat(58) + C.reset;

// ── Readline ─────────────────────────────────────────────────────────────────
const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));


// ── .env helpers ──────────────────────────────────────────────────────────────
function parseEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function writeEnvKey(key, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content = content.trimEnd() + '\n' + key + '=' + value + '\n';
  }
  if (!content.endsWith('\n')) content += '\n';
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

// ── System checks ─────────────────────────────────────────────────────────────
function checkNodeVersion() {
  return parseInt(process.versions.node.split('.')[0], 10) >= 18;
}

function checkDeps() {
  return fs.existsSync(path.join(ROOT, 'node_modules', 'express', 'package.json'));
}

function checkDataDir() {
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    // No host = binds to :: (dual-stack), same as Express — avoids false-positive
    // on Windows where 127.0.0.1 and :: are independent address families
    s.listen(port);
  });
}

function openBrowser(url) {
  const plat = process.platform;
  try {
    if (plat === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) {}
}

// ── Banner ────────────────────────────────────────────────────────────────────
function banner() {
  if (TTY) process.stdout.write('\x1b[2J\x1b[H');
  console.log();
  console.log(C.bold + '  ┌──────────────────────────────────────────────────────┐' + C.reset);
  console.log(C.bold + '  │        Portfolio Website Launcher                    │' + C.reset);
  console.log(C.bold + '  └──────────────────────────────────────────────────────┘' + C.reset);
  console.log();
}

// ── Setup wizard ──────────────────────────────────────────────────────────────
async function runSetup() {
  let bcrypt;
  try {
    bcrypt = require('bcryptjs');
  } catch {
    console.log('\n  ' + cross('bcryptjs not found. Run: npm install'));
    return false;
  }

  const env = parseEnv();
  console.log('\n' + C.bold + '  Setup Wizard' + C.reset);
  console.log(hr());
  console.log('  ' + C.dim + 'This creates or updates your .env configuration file.' + C.reset + '\n');

  // Admin password
  let pw = '';
  while (true) {
    pw = await ask('  Admin password (min 10 characters): ');
    if (pw.length >= 10) break;
    console.log('  ' + warn('Password must be at least 10 characters.'));
  }
  const pw2 = await ask('  Confirm password: ');
  if (pw !== pw2) {
    console.log('\n  ' + cross('Passwords do not match. Setup cancelled.'));
    return false;
  }
  console.log('  ' + C.dim + 'Hashing password...' + C.reset);
  const hash = await bcrypt.hash(pw, 12);
  writeEnvKey('ADMIN_PASSWORD_HASH', hash);

  // AI provider API key (optional during setup)
  console.log();
  console.log('  ' + C.bold + 'AI Provider (optional — you can configure this later in the launcher)' + C.reset);
  console.log('  [a] Anthropic (Claude) — sk-ant-…');
  console.log('  [b] OpenAI (ChatGPT)   — sk-…');
  console.log('  [c] Google Gemini      — AIza…');
  console.log('  [x] Skip for now');
  const provSetup = (await ask('  Choose AI provider: ')).trim().toLowerCase();
  const provSetupMap = { a: ['anthropic', 'ANTHROPIC_API_KEY'], b: ['openai', 'OPENAI_API_KEY'], c: ['gemini', 'GEMINI_API_KEY'] };
  if (provSetupMap[provSetup]) {
    const [provId, provKeyEnv] = provSetupMap[provSetup];
    const hasKey  = !!env[provKeyEnv];
    const keyHint = hasKey ? ' [currently set — press Enter to keep]' : '';
    const newKey  = (await ask('  API key' + keyHint + ': ')).trim();
    if (newKey) {
      writeEnvKey(provKeyEnv, newKey);
      writeEnvKey('AI_PROVIDER', provId);
      console.log('  ' + tick('AI key saved and ' + provId + ' set as active provider.'));
    } else if (hasKey) {
      writeEnvKey('AI_PROVIDER', provId);
      console.log('  ' + tick('Existing key kept, ' + provId + ' set as active provider.'));
    }
  } else {
    console.log('  ' + C.dim + '(skipped — AI features will be disabled until you add a key)' + C.reset);
  }

  // Port
  const defaultPort = env.PORT || '3000';
  const portInput   = (await ask('  Port [' + defaultPort + ']: ')).trim();
  const port        = parseInt(portInput, 10) || parseInt(defaultPort, 10) || 3000;
  writeEnvKey('PORT', String(port));

  // Auto-generate secrets if not already set
  if (!env.SESSION_SECRET) writeEnvKey('SESSION_SECRET', crypto.randomBytes(64).toString('hex'));
  if (!env.API_KEY)        writeEnvKey('API_KEY',        crypto.randomBytes(32).toString('hex'));
  if (!env.NODE_ENV)       writeEnvKey('NODE_ENV',       'development');

  checkDataDir();

  console.log('\n  ' + tick('.env saved.'));
  console.log('  ' + arrow('Port: ' + port + '  |  Admin: http://localhost:' + port + '/admin/login'));
  return true;
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────
async function preflight() {
  const env    = parseEnv();
  const port   = parseInt(env.PORT, 10) || 3000;
  const nodeOk = checkNodeVersion();
  const depsOk = checkDeps();
  const envOk  = fs.existsSync(ENV_PATH);
  const pwOk   = !!env.ADMIN_PASSWORD_HASH;
  const portFree   = await isPortFree(port);
  const srvRunning = isServerRunning();
  // Port "ok" if it's free OR it's taken by our own server process
  const portOk = portFree || srvRunning;
  const activeProvider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  const keyEnvMap = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
  const activeKeyEnv = keyEnvMap[activeProvider] || 'ANTHROPIC_API_KEY';
  const aiOk   = !!env[activeKeyEnv];
  const aiProvider = activeProvider;
  return { env, port, nodeOk, depsOk, envOk, pwOk, portOk, portFree, srvRunning, aiOk, aiProvider };
}

// ── Background server management ──────────────────────────────────────────────
function isServerRunning() {
  return serverProc !== null && serverProc.exitCode === null;
}

function stopServer() {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
}

async function startServer(port) {
  stopServer();
  // Poll until the port is free (up to 3 s); force-kill anything still holding it after 1 s
  for (let i = 0; i < 15; i++) {
    if (await isPortFree(port)) break;
    if (i === 4) killPort(port); // 1 s elapsed — force-kill any lingering process
    await delay(200);
  }
  checkDataDir();
  const logFd = fs.openSync(SERVER_LOG, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd:   ROOT,
    stdio: ['ignore', logFd, logFd],
    env:   Object.assign({}, process.env),
  });
  fs.closeSync(logFd);
  child.on('exit', () => { if (serverProc === child) serverProc = null; });
  serverProc = child;
}

function tailLog(n = 60) {
  if (!fs.existsSync(SERVER_LOG)) return '  (no log yet)';
  const content = fs.readFileSync(SERVER_LOG, 'utf8').trimEnd();
  if (!content) return '  (log is empty)';
  return content.split('\n').slice(-n).join('\n');
}

process.on('SIGINT', () => { stopServer(); rl.close(); process.exit(0); });
process.on('exit',   () => { stopServer(); });

// ── (deploy menu removed — use the Remote Server tab in the admin panel) ──────
async function deployMenu() {
  while (true) {
    const cfg     = readServerConfig();
    const server  = cfg.server || {};
    const host    = server.host || null;
    const user    = server.user || 'root';
    const sshPort = server.sshPort || 22;
    const rpath   = server.remotePath || '~/open-folio';
    const has     = !!host;
    const na      = has ? '' : '  ' + C.gray + '← configure server first' + C.reset;

    banner();
    console.log(C.bold + '  Deploy & Server Control' + C.reset);
    console.log(hr());

    if (has) {
      console.log('  ' + tick('Server: ' + C.cyan + user + '@' + host + (sshPort !== 22 ? ' -p ' + sshPort : '') + C.reset));
      console.log('  ' + arrow('Path:   ' + rpath));
    } else {
      console.log('  ' + warn('No server configured — choose [a] to add one.'));
    }
    console.log();

    console.log(C.gray + '  ── Connection ──────────────────────────────────' + C.reset);
    console.log('  ' + C.bold + '[a]' + C.reset + ' Configure server connection');
    console.log();
    console.log(C.gray + '  ── Content Sync ────────────────────────────────' + C.reset);
    console.log('  ' + C.bold + '[b]' + C.reset + ' Push content to server   (upload DB + images)' + na);
    console.log('  ' + C.bold + '[c]' + C.reset + ' Pull backup from server  (download DB locally)' + na);
    console.log('  ' + C.bold + '[d]' + C.reset + ' Show scp commands');
    console.log();
    console.log(C.gray + '  ── Remote Server ───────────────────────────────' + C.reset);
    console.log('  ' + C.bold + '[e]' + C.reset + ' SSH into server          (open interactive terminal)' + na);
    console.log('  ' + C.bold + '[f]' + C.reset + ' Restart site on server' + na);
    console.log('  ' + C.bold + '[g]' + C.reset + ' View server logs' + na);
    console.log('  ' + C.bold + '[h]' + C.reset + ' Update code on server    (git pull + restart)' + na);
    console.log('  ' + C.bold + '[i]' + C.reset + ' Check server status      (PM2 + disk + uptime)' + na);
    console.log();
    console.log(C.gray + '  ── Reference ───────────────────────────────────' + C.reset);
    console.log('  ' + C.bold + '[j]' + C.reset + ' Deployment checklist');
    console.log('  ' + C.bold + '[k]' + C.reset + ' SSH key setup         (show key to add to server)');
    console.log();
    console.log('  ' + C.bold + '[z]' + C.reset + ' Back to main menu');
    console.log();

    const choice = (await ask('  Enter choice: ')).trim().toLowerCase();
    console.log();

    // ── [a] Configure ────────────────────────────────────────────────────────
    if (choice === 'a') {
      console.log(C.bold + '  Configure Server Connection' + C.reset);
      console.log(hr());
      console.log('  ' + C.dim + 'Saved to .launcher-config.json — not committed to git.' + C.reset + '\n');

      const newHost = (await ask('  Server IP or hostname [' + (host || 'e.g. 1.2.3.4') + ']: ')).trim();
      if (!newHost) { console.log('\n  ' + warn('No hostname entered — no changes saved.')); await pause(); continue; }
      const newUser = (await ask('  SSH username [' + user + ']: ')).trim() || user;
      const rawPort = parseInt((await ask('  SSH port [' + sshPort + ']: ')).trim(), 10);
      const newPort = (rawPort >= 1 && rawPort <= 65535) ? rawPort : sshPort;
      const newPath = (await ask('  Remote project path [' + rpath + ']: ')).trim() || rpath;

      writeServerConfig({ server: { host: newHost, user: newUser, sshPort: newPort, remotePath: newPath } });
      console.log('\n  ' + tick('Server saved.'));
      const pubKey = getOrCreateSshKey();
      printSshSetup(pubKey, newUser, newHost);
      await pause();

    // ── [b] Push content ─────────────────────────────────────────────────────
    } else if (choice === 'b') {
      if (!has) { noServerMsg(); await pause(); continue; }
      console.log('  ' + arrow('Uploading database...'));
      runRsync('data/portfolio.db', `${user}@${host}:${rpath}/data/`, sshPort);
      console.log('\n  ' + arrow('Uploading project images...'));
      runRsync('public/images/projects/', `${user}@${host}:${rpath}/public/images/projects/`, sshPort);
      console.log('\n  ' + arrow('Uploading logo images...'));
      runRsync('public/images/logos/', `${user}@${host}:${rpath}/public/images/logos/`, sshPort);
      console.log('\n  ' + tick('Sync complete.'));
      await pause();

    // ── [c] Pull backup ──────────────────────────────────────────────────────
    } else if (choice === 'c') {
      if (!has) { noServerMsg(); await pause(); continue; }
      console.log('  ' + arrow('Downloading database from server...'));
      runRsync(`${user}@${host}:${rpath}/data/portfolio.db`, 'data/portfolio.db.bak', sshPort);
      console.log('\n  ' + arrow('Downloading logo images from server...'));
      runRsync(`${user}@${host}:${rpath}/public/images/logos/`, 'public/images/logos/', sshPort);
      console.log('\n  ' + tick('Backup saved — DB → data/portfolio.db.bak, logos synced locally.'));
      await pause();

    // ── [d] Show sync commands ───────────────────────────────────────────────
    } else if (choice === 'd') {
      const sh = has ? (sshPort !== 22 ? ` -e "ssh -p ${sshPort}"` : '') : '';
      const sc = has ? (sshPort !== 22 ? `-p ${sshPort} ` : '') : '';
      const conn = has ? `${user}@${host}` : 'USER@SERVER_IP';
      const rp   = has ? rpath : '~/open-folio';

      console.log(C.bold + '  Sync Commands' + C.reset + '  ' + C.dim + '(run on your LOCAL computer)' + C.reset);
      console.log(hr());
      console.log(C.bold + '\n  Upload DB:' + C.reset);
      console.log('  ' + C.cyan + `scp ${sc}data/portfolio.db ${conn}:${rp}/data/` + C.reset);
      console.log(C.bold + '\n  Upload project images:' + C.reset);
      console.log('  ' + C.cyan + `scp ${sc}-r public/images/projects ${conn}:${rp}/public/images/` + C.reset);
      console.log(C.bold + '\n  Upload logo images:' + C.reset);
      console.log('  ' + C.cyan + `scp ${sc}-r public/images/logos ${conn}:${rp}/public/images/` + C.reset);
      console.log(C.bold + '\n  Download DB (backup):' + C.reset);
      console.log('  ' + C.cyan + `scp ${sc}${conn}:${rp}/data/portfolio.db data/portfolio.db.bak` + C.reset);
      console.log(C.bold + '\n  Download logos (backup):' + C.reset);
      console.log('  ' + C.cyan + `scp ${sc}-r ${conn}:${rp}/public/images/logos public/images/` + C.reset);
      console.log(C.bold + '\n  SSH:' + C.reset);
      console.log('  ' + C.cyan + `ssh ${sc}${conn}` + C.reset);
      console.log(C.gray + '\n  Tip: use the admin panel Remote Server tab for one-click push/pull with live progress.' + C.reset);
      console.log();
      await pause();

    // ── [e] Interactive SSH ──────────────────────────────────────────────────
    } else if (choice === 'e') {
      if (!has) { noServerMsg(); await pause(); continue; }
      console.log('  ' + C.dim + `Connecting to ${user}@${host}… type "exit" to return to the launcher.` + C.reset + '\n');
      rl.pause();
      spawnSync('ssh', sshArgs(user, host, sshPort), { cwd: ROOT, stdio: 'inherit' });
      rl.resume();
      console.log('\n  ' + C.dim + '(back in launcher)' + C.reset);
      await pause();

    // ── [f] Restart site ─────────────────────────────────────────────────────
    } else if (choice === 'f') {
      if (!has) { noServerMsg(); await pause(); continue; }
      console.log('  ' + arrow(`Restarting portfolio on ${host}...`));
      runRemote(user, host, sshPort, 'pm2 restart open-folio && echo "" && pm2 status');
      await pause();

    // ── [g] View logs ────────────────────────────────────────────────────────
    } else if (choice === 'g') {
      if (!has) { noServerMsg(); await pause(); continue; }
      console.log('  ' + C.dim + `Fetching logs from ${host}…` + C.reset + '\n');
      runRemote(user, host, sshPort, 'pm2 logs open-folio --lines 60 --nostream');
      await pause();

    // ── [h] Update code ──────────────────────────────────────────────────────
    } else if (choice === 'h') {
      if (!has) { noServerMsg(); await pause(); continue; }
      const safeRpath = rpath.replace(/'/g, "'\\''");
      const cmd = `cd '${safeRpath}' && git pull && npm install --omit=dev && pm2 restart open-folio && echo "" && pm2 status`;
      console.log('  ' + arrow('Running on server: git pull → npm install → pm2 restart'));
      runRemote(user, host, sshPort, cmd);
      await pause();

    // ── [i] Server status ────────────────────────────────────────────────────
    } else if (choice === 'i') {
      if (!has) { noServerMsg(); await pause(); continue; }
      const cmd = 'pm2 status && echo "" && df -h / && echo "" && uptime';
      console.log('  ' + C.dim + `Checking ${host}…` + C.reset + '\n');
      runRemote(user, host, sshPort, cmd);
      await pause();

    // ── [j] Deployment checklist ─────────────────────────────────────────────
    } else if (choice === 'j') {
      const conn = has ? `${user}@${host}` : 'USER@SERVER_IP';
      const rp   = has ? rpath : '~/open-folio';

      console.log(C.bold + '  Deployment Checklist' + C.reset);
      console.log(hr());
      console.log('  1. Finish portfolio locally — http://localhost:' + (parseEnv().PORT || '3000') + '\n');
      console.log('  2. Get a server — Ubuntu 22.04 VPS (~$4–7/mo): Hetzner, DigitalOcean, Vultr\n');
      console.log('  3. Set up the server (SSH in, then run):');
      console.log(C.gray + '       curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -' + C.reset);
      console.log(C.gray + '       sudo apt-get install -y nodejs && sudo npm install -g pm2' + C.reset);
      console.log(C.gray + '       # Install Caddy: caddyserver.com/docs/install' + C.reset);
      console.log(C.gray + '       git clone YOUR_GITHUB_REPO ' + rp + C.reset);
      console.log(C.gray + '       cd ' + rp + ' && npm install && node launcher.js' + C.reset + '\n');
      console.log('  4. Sync content — use the admin panel Remote Server tab → Push to server, or run:');
      console.log(C.cyan + '       scp data/portfolio.db ' + conn + ':' + rp + '/data/' + C.reset);
      console.log(C.cyan + '       scp -r public/images/projects ' + conn + ':' + rp + '/public/images/' + C.reset);
      console.log(C.cyan + '       scp -r public/images/logos ' + conn + ':' + rp + '/public/images/' + C.reset + '\n');
      console.log('  5. Start with PM2 (on server):');
      console.log(C.gray + '       pm2 start server.js --name open-folio' + C.reset);
      console.log(C.gray + '       pm2 save && pm2 startup' + C.reset + '\n');
      console.log('  6. Domain + HTTPS — DNS A record: your-domain.com → ' + (host || 'SERVER_IP'));
      console.log(C.gray + '       /etc/caddy/Caddyfile:  your-domain.com { reverse_proxy localhost:3000 }' + C.reset);
      console.log(C.gray + '       sudo systemctl restart caddy' + C.reset);
      console.log();
      console.log('  After launch, manage the server from this Deploy menu (options e–i).');
      console.log(hr());
      await pause();

    // ── [k] SSH key setup ────────────────────────────────────────────────────
    } else if (choice === 'k') {
      const pubKey = getOrCreateSshKey();
      printSshSetup(pubKey, user, host);
      await pause();

    } else if (choice === 'z' || choice === 'back') {
      return;
    } else {
      console.log('  ' + warn('Enter a letter from the menu above, or z to go back.'));
      await pause();
    }
  }
}

// ── Kill process on port ──────────────────────────────────────────────────────
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { encoding: 'utf8' });
      const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
      let killed = false;
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') {
          spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
          killed = true;
        }
      }
      return killed;
    } else {
      const r = spawnSync('sh', ['-c', `lsof -ti:${port}`], { encoding: 'utf8' });
      const pids = (r.stdout || '').trim().split('\n').filter(p => /^\d+$/.test(p.trim()));
      for (const pid of pids) spawnSync('kill', ['-9', pid.trim()], { stdio: 'ignore' });
      return pids.length > 0;
    }
  } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  banner();

  // First-time setup: no .env exists
  if (!fs.existsSync(ENV_PATH)) {
    console.log('  ' + warn('No .env file found — running first-time setup.\n'));
    const ok = await runSetup();
    if (!ok) { rl.close(); process.exit(1); }
    console.log('\n  ' + C.dim + 'Setup complete. Loading launcher...' + C.reset);
    await delay(1200);
    banner();
  }

  // Main menu loop
  while (true) {
    const { env, port, nodeOk, depsOk, envOk, pwOk, portOk, portFree, srvRunning, aiOk, aiProvider } = await preflight();
    const ready = nodeOk && depsOk && envOk && pwOk;

    // Status
    console.log(C.bold + '  System Status' + C.reset);
    console.log(hr());
    console.log('  ' + (nodeOk ? tick('Node.js v' + process.versions.node)  : cross('Node.js v' + process.versions.node + ' — requires v18+')));
    console.log('  ' + (depsOk ? tick('Dependencies installed')              : cross('Dependencies missing — choose [2] to install')));
    console.log('  ' + (envOk  ? tick('.env file found')                     : cross('.env not found — choose [6] to run setup')));
    console.log('  ' + (pwOk   ? tick('Admin password configured')           : cross('Admin password not set — run setup')));
    if (srvRunning) {
      console.log('  ' + tick('Server running — ' + C.cyan + 'http://localhost:' + port + C.reset));
    } else if (!portFree) {
      console.log('  ' + warn('Port ' + port + ' is in use by another process'));
    } else {
      console.log('  ' + C.dim + '  Server not running' + C.reset);
    }
    const providerNames = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini' };
    const providerLabel = providerNames[aiProvider] || aiProvider;
    console.log('  ' + (aiOk ? tick('AI enabled — ' + providerLabel) : warn('No AI key set — AI features disabled (use [2] to configure)')));
    console.log();

    // URLs
    console.log(C.bold + '  Site' + C.reset);
    console.log(hr());
    console.log('  ' + arrow('Portfolio:  http://localhost:' + port));
    console.log('  ' + arrow('Admin:      http://localhost:' + port + '/admin/login'));
    console.log();

    // Menu
    console.log(C.bold + '  Options' + C.reset);
    console.log(hr());
    if (ready) {
      console.log('  ' + C.bold + '[1]' + C.reset + (srvRunning ? ' Restart server' : ' Start server'));
    } else {
      console.log('  ' + C.gray + '[1] Start server  (fix issues above first)' + C.reset);
    }
    if (srvRunning) {
      console.log('  ' + C.bold + '[s]' + C.reset + ' Stop server');
    }
    console.log('  ' + C.bold + '[l]' + C.reset + ' View server log');
    if (!depsOk) {
      console.log('  ' + C.bold + '[2]' + C.reset + ' Install dependencies  ' + C.dim + '(npm install)' + C.reset);
    } else {
      console.log('  ' + C.bold + '[2]' + C.reset + ' Configure AI provider & API key');
    }
    console.log('  ' + C.bold + '[3]' + C.reset + ' Change admin password    ' + C.dim + '← the secret word for /admin/login' + C.reset);
    console.log('  ' + C.bold + '[4]' + C.reset + ' Change port');
    console.log('  ' + C.bold + '[5]' + C.reset + ' Re-run full setup');
    console.log('  ' + C.bold + '[q]' + C.reset + ' Quit');
    console.log();

    const choice = (await ask('  Enter choice: ')).trim().toLowerCase();
    console.log();

    if (choice === '1') {
      if (!ready) {
        console.log('  ' + warn('Fix the issues above before starting the server.'));
        await pause();
      } else {
        let canStart = true;
        if (!portFree && !srvRunning) {
          console.log('  ' + arrow('Port ' + port + ' in use — stopping foreign process...'));
          canStart = killPort(port);
          if (canStart) { await delay(600); }
          else { console.log('  ' + warn('Could not stop the process. Close it manually and try again.')); await pause(); }
        }
        if (canStart) {
          const wasRunning = srvRunning;
          console.log('  ' + arrow(wasRunning ? 'Restarting server...' : 'Starting server...'));
          await startServer(port);
          await delay(1200);
          if (isServerRunning()) {
            console.log('  ' + tick('Server running — http://localhost:' + port));
            if (!wasRunning) {
              const ob = (await ask('  Open browser? (Y/n): ')).trim().toLowerCase();
              if (!ob.startsWith('n')) openBrowser('http://localhost:' + port);
            }
          } else {
            console.log('  ' + cross('Server failed to start. Choose [l] to view the log.'));
          }
          await pause();
        }
      }

    } else if (choice === 's') {
      if (!srvRunning) {
        console.log('  ' + warn('Server is not running.'));
      } else {
        stopServer();
        console.log('  ' + tick('Server stopped.'));
      }
      await pause();

    } else if (choice === 'l') {
      console.log(C.bold + '  Server Log' + C.reset + (isServerRunning() ? '  ' + C.green + '(running)' + C.reset : ''));
      console.log(hr());
      console.log(tailLog());
      console.log(hr());
      await pause();

    } else if (choice === '2') {
      if (!depsOk) {
        console.log('  ' + arrow('Running npm install...'));
        const r = spawnSync('npm', ['install'], {
          cwd: ROOT, stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        if (r.status === 0) {
          console.log('\n  ' + tick('Dependencies installed.'));
        } else {
          console.log('\n  ' + cross('npm install failed. Check the output above.'));
        }
        await pause();
      } else {
        console.log();
        console.log('  ' + C.bold + 'Choose an AI provider:' + C.reset);
        const providerKeyMap = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
        const providerHints  = { anthropic: 'sk-ant-…', openai: 'sk-…', gemini: 'AIza…' };
        const providerDisplayNames = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (ChatGPT)', gemini: 'Google Gemini' };
        const curProvider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
        console.log('  [a] Anthropic (Claude)  ' + (curProvider === 'anthropic' ? C.dim + '← active' + C.reset : ''));
        console.log('  [b] OpenAI (ChatGPT)    ' + (curProvider === 'openai'    ? C.dim + '← active' + C.reset : ''));
        console.log('  [c] Google Gemini       ' + (curProvider === 'gemini'    ? C.dim + '← active' + C.reset : ''));
        console.log('  [x] Cancel');
        console.log();
        const provChoice = (await ask('  Choose provider: ')).trim().toLowerCase();
        const provMap = { a: 'anthropic', b: 'openai', c: 'gemini' };
        const chosenProvider = provMap[provChoice];
        if (!chosenProvider) {
          console.log('  ' + C.dim + '(cancelled)' + C.reset);
        } else {
          const keyEnv = providerKeyMap[chosenProvider];
          const hint   = providerHints[chosenProvider];
          const curKey = env[keyEnv] ? ' [currently set — press Enter to keep]' : ' [press Enter to skip]';
          const newKey = (await ask('  ' + providerDisplayNames[chosenProvider] + ' API key' + curKey + '\n  Hint: ' + hint + '\n  Key: ')).trim();
          if (newKey) {
            writeEnvKey(keyEnv, newKey);
            console.log('  ' + tick('API key saved.'));
          } else if (!env[keyEnv]) {
            console.log('  ' + C.dim + '(no key set — skipped)' + C.reset);
          }
          writeEnvKey('AI_PROVIDER', chosenProvider);
          console.log('  ' + tick('Active provider set to: ' + providerDisplayNames[chosenProvider] + '. Restart the server to apply.'));
        }
        await pause();
      }

    } else if (choice === '3') {
      let bcrypt;
      try { bcrypt = require('bcryptjs'); }
      catch { console.log('  ' + cross('bcryptjs not found — run npm install')); await pause(); continue; }

      let pw = '';
      while (true) {
        pw = await ask('  New admin password (min 10 characters): ');
        if (pw.length >= 10) break;
        console.log('  ' + warn('Must be at least 10 characters.'));
      }
      const pw2 = await ask('  Confirm: ');
      if (pw !== pw2) {
        console.log('  ' + cross('Passwords do not match.'));
      } else {
        console.log('  ' + C.dim + 'Hashing...' + C.reset);
        const hash = await bcrypt.hash(pw, 12);
        writeEnvKey('ADMIN_PASSWORD_HASH', hash);
        console.log('  ' + tick('Password updated. Restart the server to apply.'));
      }
      await pause();

    } else if (choice === '4') {
      const input = (await ask('  New port number [' + port + ']: ')).trim();
      const newPort = parseInt(input, 10);
      if (!newPort || newPort < 1 || newPort > 65535) {
        console.log('  ' + warn('Invalid port number.'));
      } else {
        writeEnvKey('PORT', String(newPort));
        console.log('  ' + tick('Port changed to ' + newPort + '.'));
      }
      await pause();

    } else if (choice === '5') {
      const ok = await runSetup();
      if (ok) console.log('\n  ' + arrow('Setup complete.'));
      await pause();

    } else if (choice === 'q' || choice === 'quit' || choice === 'exit') {
      if (isServerRunning()) {
        const stop = (await ask('  Server is running — stop it before quitting? (Y/n): ')).trim().toLowerCase();
        if (!stop.startsWith('n')) stopServer();
      }
      console.log(C.dim + '  Goodbye.\n' + C.reset);
      rl.close();
      process.exit(0);

    } else {
      console.log('  ' + warn('Unknown option — enter a number or letter from the menu above.'));
      await pause();
    }

    banner();
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function pause() { await ask('\n  Press Enter to continue...'); }

main().catch((e) => {
  console.error('\n  ' + cross('Fatal error: ' + e.message));
  process.exit(1);
});
