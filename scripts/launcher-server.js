#!/usr/bin/env node
'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { spawnSync, spawn } = require('child_process');
const crypto   = require('crypto');
const net      = require('net');

const ROOT          = path.join(__dirname, '..');
const ENV_PATH      = path.join(ROOT, '.env');
const CONFIG_PATH   = path.join(ROOT, '.launcher-config.json');
const SERVER_LOG    = path.join(ROOT, 'data', 'server.log');
const BACKUPS_DIR   = path.join(ROOT, 'data', 'backups');
const HTML_PATH     = path.join(ROOT, 'views', 'launcher.html');
const LAUNCHER_PORT = 3001;

let serverProc = null;

// ── Config & env helpers ──────────────────────────────────────────────────────

function readServerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function writeServerConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

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
  content = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + '\n' + key + '=' + value + '\n';
  if (!content.endsWith('\n')) content += '\n';
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

// ── System checks ─────────────────────────────────────────────────────────────

function checkDeps() {
  return fs.existsSync(path.join(ROOT, 'node_modules', 'express', 'package.json'));
}

function checkDataDir() {
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureBackupsDir() {
  checkDataDir();
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function backupTimestamp() {
  const d = new Date();
  return d.getFullYear()
    + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
    + '_' + String(d.getHours()).padStart(2, '0')
    + '-' + String(d.getMinutes()).padStart(2, '0');
}

// ── Port helpers ──────────────────────────────────────────────────────────────

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port);
  });
}

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { encoding: 'utf8' });
      for (const line of (r.stdout || '').trim().split('\n').filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') {
          spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
        }
      }
    } else {
      const r = spawnSync('sh', ['-c', `lsof -ti:${port}`], { encoding: 'utf8' });
      for (const pid of (r.stdout || '').trim().split('\n').filter(p => /^\d+$/.test(p.trim()))) {
        spawnSync('kill', ['-9', pid.trim()], { stdio: 'ignore' });
      }
    }
  } catch {}
}

// ── Command availability ──────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    const check = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(check, [cmd], { stdio: 'ignore' }).status === 0;
  } catch { return false; }
}

function scpPortArgs(sshPort) {
  return sshPort !== 22 ? ['-P', String(sshPort)] : [];
}

// ── Portfolio server management ───────────────────────────────────────────────
// The portfolio server runs detached so it survives if the launcher window closes.
// A PID file tracks it across launcher restarts.

const SERVER_PID_FILE = path.join(ROOT, 'data', 'server.pid');

function readServerPid() {
  try { return parseInt(fs.readFileSync(SERVER_PID_FILE, 'utf8').trim(), 10) || null; } catch { return null; }
}

function isServerRunning() {
  const pid = readServerPid();
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopServer() {
  const pid = readServerPid();
  if (pid) { try { process.kill(pid); } catch {} }
  try { fs.unlinkSync(SERVER_PID_FILE); } catch {}
  if (serverProc) { try { serverProc.kill(); } catch {}; serverProc = null; }
}

async function startServer(port) {
  stopServer();
  for (let i = 0; i < 15; i++) {
    if (await isPortFree(port)) break;
    if (i === 4) killPort(port);
    await delay(200);
  }
  checkDataDir();
  const logFd = fs.openSync(SERVER_LOG, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', logFd, logFd], env: Object.assign({}, process.env),
    detached: true,
  });
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(SERVER_PID_FILE, String(child.pid), 'utf8');
  child.on('exit', () => { if (serverProc === child) { serverProc = null; try { fs.unlinkSync(SERVER_PID_FILE); } catch {} } });
  serverProc = child;
}

// ── SSH key ───────────────────────────────────────────────────────────────────

function getOrCreateSshKey() {
  const sshDir    = path.join(os.homedir(), '.ssh');
  const candidates = [path.join(sshDir, 'id_ed25519.pub'), path.join(sshDir, 'id_rsa.pub')];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  try {
    if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(sshDir, 'id_ed25519');
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'open-folio'], { stdio: 'ignore' });
    if (fs.existsSync(keyPath + '.pub')) return fs.readFileSync(keyPath + '.pub', 'utf8').trim();
  } catch {}
  return null;
}

// ── SSH / rsync arg builders ──────────────────────────────────────────────────

function sshArgs(user, host, sshPort, command) {
  const args = ['-o', 'StrictHostKeyChecking=accept-new'];
  if (sshPort !== 22) args.push('-p', String(sshPort));
  args.push(`${user}@${host}`);
  if (command) args.push(command);
  return args;
}

function rsyncArgs(src, dest, sshPort) {
  const args = ['-avz'];
  if (sshPort !== 22) args.push('-e', `ssh -o StrictHostKeyChecking=accept-new -p ${sshPort}`);
  else args.push('-e', 'ssh -o StrictHostKeyChecking=accept-new');
  args.push(src, dest);
  return args;
}

// Returns a bash cd command for the remote project directory.
// Replaces leading ~ with $HOME so it expands correctly inside double quotes
// (bare ~ is not expanded when single-quoted in an SSH command string).
function remoteRpPrefix(rp) {
  const expanded = (rp || '~/portfolio').trim().replace(/^~/, '$HOME');
  return `cd "${expanded}"`;
}

// ── Browser open ──────────────────────────────────────────────────────────────

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function streamCommand(cmd, args, opts, send) {
  return new Promise((resolve) => {
    const { stdin: stdinData, ...spawnOpts } = opts;
    if (stdinData !== undefined) spawnOpts.stdio = ['pipe', 'pipe', 'pipe'];
    let proc;
    try {
      proc = spawn(cmd, args, { cwd: ROOT, ...spawnOpts });
    } catch (e) {
      send({ type: 'err', text: e.message });
      return resolve(1);
    }
    if (stdinData !== undefined && proc.stdin) { proc.stdin.write(stdinData, 'utf8'); proc.stdin.end(); }
    const onData = (type) => (d) =>
      d.toString().split('\n').forEach(l => { if (l.trim()) send({ type, text: l }); });
    if (proc.stdout) proc.stdout.on('data', onData('out'));
    if (proc.stderr) proc.stderr.on('data', onData('err'));
    proc.on('error', (e) => {
      const msg = e.code === 'ENOENT'
        ? `"${cmd}" not found — install it and try again`
        : e.message;
      send({ type: 'err', text: msg });
      resolve(1);
    });
    proc.on('close', resolve);
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── GET / ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(HTML_PATH));

// ── GET /api/status ───────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const env        = parseEnv();
  const port       = parseInt(env.PORT, 10) || 3000;
  const srvRunning = isServerRunning();
  const portFree   = await isPortFree(port);
  const aiProvider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  const keyEnvMap  = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
  const cfg        = readServerConfig().server || {};

  res.json({
    node:   { ok: parseInt(process.versions.node.split('.')[0], 10) >= 18, version: process.versions.node },
    deps:   { ok: checkDeps() },
    env:    { ok: fs.existsSync(ENV_PATH) },
    pw:     { ok: !!env.ADMIN_PASSWORD_HASH },
    server: { running: srvRunning, portFree, port, url: `http://localhost:${port}`, adminUrl: `http://localhost:${port}/admin/login` },
    ai: {
      ok: !!env[keyEnvMap[aiProvider]],
      provider: aiProvider,
      anthropicSet: !!env.ANTHROPIC_API_KEY,
      openaiSet:    !!env.OPENAI_API_KEY,
      geminiSet:    !!env.GEMINI_API_KEY,
    },
    serverConfig: cfg.host ? { host: cfg.host, user: cfg.user, sshPort: cfg.sshPort || 22, remotePath: cfg.remotePath || '~/open-folio' } : null,
    setupNeeded: !fs.existsSync(ENV_PATH) || !env.ADMIN_PASSWORD_HASH,
  });
});

// ── POST /api/server/start ────────────────────────────────────────────────────
app.post('/api/server/start', async (req, res) => {
  const env  = parseEnv();
  const port = parseInt(env.PORT, 10) || 3000;
  if (!checkDeps() || !fs.existsSync(ENV_PATH) || !env.ADMIN_PASSWORD_HASH) {
    return res.status(400).json({ error: 'Setup is not complete' });
  }
  await startServer(port);
  await delay(1400);
  res.json({ running: isServerRunning() });
});

// ── POST /api/server/stop ─────────────────────────────────────────────────────
app.post('/api/server/stop', (req, res) => {
  stopServer();
  res.json({ running: false });
});

// ── GET /api/server/log (SSE) ─────────────────────────────────────────────────
app.get('/api/server/log', (req, res) => {
  const send = sseSetup(res);
  if (!fs.existsSync(SERVER_LOG)) {
    send({ type: 'info', text: '(no log yet — start the server first)' });
  } else {
    const content = fs.readFileSync(SERVER_LOG, 'utf8').trimEnd();
    const lines   = content ? content.split('\n').slice(-150) : ['(log is empty)'];
    lines.forEach(l => send({ type: 'out', text: l }));
  }
  send({ type: 'done' });
  res.end();
});

// ── GET /api/ssh-key ──────────────────────────────────────────────────────────
app.get('/api/ssh-key', (req, res) => {
  res.json({ pubKey: getOrCreateSshKey() });
});

// ── POST /api/server-config ───────────────────────────────────────────────────
app.post('/api/server-config', (req, res) => {
  const { host, user, sshPort, remotePath } = req.body;
  if (!host) return res.status(400).json({ error: 'Host is required' });
  const port = parseInt(sshPort, 10);
  writeServerConfig({ server: {
    host:       String(host).trim(),
    user:       String(user || 'root').trim(),
    sshPort:    (port >= 1 && port <= 65535) ? port : 22,
    remotePath: String(remotePath || '~/open-folio').trim(),
  }});
  res.json({ ok: true });
});

// ── POST /api/setup ───────────────────────────────────────────────────────────
app.post('/api/setup', async (req, res) => {
  const { password, provider, apiKey, port } = req.body;
  if (!password || password.length < 10)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  let bcrypt;
  try { bcrypt = require('bcryptjs'); }
  catch { return res.status(500).json({ error: 'bcryptjs not found — run npm install' }); }

  const env  = parseEnv();
  const hash = await bcrypt.hash(password, 12);
  writeEnvKey('ADMIN_PASSWORD_HASH', hash);
  writeEnvKey('PORT', String(parseInt(port, 10) || 3000));
  if (!env.SESSION_SECRET) writeEnvKey('SESSION_SECRET', crypto.randomBytes(64).toString('hex'));
  if (!env.API_KEY)        writeEnvKey('API_KEY',        crypto.randomBytes(32).toString('hex'));
  if (!env.NODE_ENV)       writeEnvKey('NODE_ENV',       'development');
  const keyEnvMap = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
  if (provider && keyEnvMap[provider]) {
    if (apiKey) writeEnvKey(keyEnvMap[provider], apiKey);
    writeEnvKey('AI_PROVIDER', provider);
  }
  checkDataDir();
  res.json({ ok: true });
});

// ── POST /api/settings/password ───────────────────────────────────────────────
app.post('/api/settings/password', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 10)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  let bcrypt;
  try { bcrypt = require('bcryptjs'); }
  catch { return res.status(500).json({ error: 'bcryptjs not found — run npm install' }); }
  writeEnvKey('ADMIN_PASSWORD_HASH', await bcrypt.hash(password, 12));
  res.json({ ok: true });
});

// ── POST /api/settings/port ───────────────────────────────────────────────────
app.post('/api/settings/port', (req, res) => {
  const port = parseInt(req.body.port, 10);
  if (!port || port < 1 || port > 65535)
    return res.status(400).json({ error: 'Invalid port number' });
  writeEnvKey('PORT', String(port));
  res.json({ ok: true, port });
});

// ── POST /api/settings/ai-key ─────────────────────────────────────────────────
app.post('/api/settings/ai-key', (req, res) => {
  const { provider, key } = req.body;
  const keyEnvMap = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
  if (!keyEnvMap[provider]) return res.status(400).json({ error: 'Invalid provider' });
  if (key) writeEnvKey(keyEnvMap[provider], key);
  writeEnvKey('AI_PROVIDER', provider);
  res.json({ ok: true });
});

// ── GET /api/deploy/push (SSE) ────────────────────────────────────────────────
app.get('/api/deploy/push', async (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  const useRsync = commandExists('rsync');

  if (!useRsync) send({ type: 'info', text: 'rsync not found — using scp (built-in to Windows)' });

  send({ type: 'info', text: '→ Pushing database...' });
  const c1 = useRsync
    ? await streamCommand('rsync', rsyncArgs('data/portfolio.db', `${user}@${host}:${rp}/data/`, sshPort), {}, send)
    : await streamCommand('scp', [...scpPortArgs(sshPort), 'data/portfolio.db', `${user}@${host}:${rp}/data/portfolio.db`], {}, send);

  send({ type: 'info', text: '→ Pushing project images...' });
  const c2 = useRsync
    ? await streamCommand('rsync', rsyncArgs('public/images/projects/', `${user}@${host}:${rp}/public/images/projects/`, sshPort), {}, send)
    : await streamCommand('scp', ['-r', ...scpPortArgs(sshPort), 'public/images/projects', `${user}@${host}:${rp}/public/images/`], {}, send);

  send({ type: 'info', text: '→ Pushing logo images...' });
  const c3 = useRsync
    ? await streamCommand('rsync', rsyncArgs('public/images/logos/', `${user}@${host}:${rp}/public/images/logos/`, sshPort), {}, send)
    : await streamCommand('scp', ['-r', ...scpPortArgs(sshPort), 'public/images/logos', `${user}@${host}:${rp}/public/images/`], {}, send);

  const ok = c1 === 0 && c2 === 0 && c3 === 0;
  send({ type: ok ? 'done' : 'error', text: ok ? '✓ Push complete.' : '✗ Push finished with errors — check output above.' });
  res.end();
});

// ── GET /api/deploy/pull (SSE) — saves timestamped DB backup ─────────────────
app.get('/api/deploy/pull', async (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  const useRsync = commandExists('rsync');

  if (!useRsync) send({ type: 'info', text: 'rsync not found — using scp (built-in to Windows)' });

  ensureBackupsDir();
  const backupName = `server_${backupTimestamp()}.db`;
  const backupPath = path.join(BACKUPS_DIR, backupName);

  send({ type: 'info', text: `→ Downloading database backup from server...` });
  const code = useRsync
    ? await streamCommand('rsync', rsyncArgs(`${user}@${host}:${rp}/data/portfolio.db`, backupPath, sshPort), {}, send)
    : await streamCommand('scp', [...scpPortArgs(sshPort), `${user}@${host}:${rp}/data/portfolio.db`, backupPath], {}, send);

  send({ type: code === 0 ? 'done' : 'error', text: code === 0 ? `✓ Backup saved as data/backups/${backupName}` : '✗ Finished with errors — check output above.' });
  res.end();
});

// ── GET /api/deploy/pull-replace (SSE) — overwrites local with server ─────────
app.get('/api/deploy/pull-replace', async (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  const useRsync = commandExists('rsync');

  if (!useRsync) send({ type: 'info', text: 'rsync not found — using scp (built-in to Windows)' });

  // Auto-backup local DB before overwriting
  const localDb = path.join(ROOT, 'data', 'portfolio.db');
  if (fs.existsSync(localDb)) {
    ensureBackupsDir();
    const backupName = `pre-replace_${backupTimestamp()}.db`;
    try { fs.copyFileSync(localDb, path.join(BACKUPS_DIR, backupName)); } catch {}
    send({ type: 'info', text: `→ Local DB backed up as data/backups/${backupName}` });
  }

  // Stop local server first so the database file isn't locked
  if (isServerRunning()) {
    send({ type: 'info', text: '→ Stopping local server to release database lock...' });
    stopServer();
    await delay(600);
  }

  // Helper to clear a local dir before scp to avoid nested-directory issue
  const clearDir = (dir) => {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  };

  send({ type: 'info', text: '→ Replacing local database...' });
  const c1 = useRsync
    ? await streamCommand('rsync', rsyncArgs(`${user}@${host}:${rp}/data/portfolio.db`, 'data/portfolio.db', sshPort), {}, send)
    : await streamCommand('scp', [...scpPortArgs(sshPort), `${user}@${host}:${rp}/data/portfolio.db`, 'data/portfolio.db'], {}, send);

  send({ type: 'info', text: '→ Replacing local project images...' });
  let c2;
  if (useRsync) {
    c2 = await streamCommand('rsync', rsyncArgs(`${user}@${host}:${rp}/public/images/projects/`, 'public/images/projects/', sshPort), {}, send);
  } else {
    clearDir('public/images/projects');
    c2 = await streamCommand('scp', ['-r', ...scpPortArgs(sshPort), `${user}@${host}:${rp}/public/images/projects`, 'public/images/'], {}, send);
  }

  send({ type: 'info', text: '→ Replacing local logo images...' });
  let c3;
  if (useRsync) {
    c3 = await streamCommand('rsync', rsyncArgs(`${user}@${host}:${rp}/public/images/logos/`, 'public/images/logos/', sshPort), {}, send);
  } else {
    clearDir('public/images/logos');
    c3 = await streamCommand('scp', ['-r', ...scpPortArgs(sshPort), `${user}@${host}:${rp}/public/images/logos`, 'public/images/'], {}, send);
  }

  const ok = c1 === 0 && c2 === 0 && c3 === 0;
  send({ type: ok ? 'done' : 'error', text: ok ? '✓ Local content replaced. Start the server from the Home tab to see changes.' : '✗ Finished with errors — check output above.' });
  res.end();
});

// ── POST /api/deploy/ssh-terminal ─────────────────────────────────────────────
app.post('/api/deploy/ssh-terminal', (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const sshCmd = 'ssh ' + sshArgs(cfg.user, cfg.host, cfg.sshPort || 22).join(' ');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', sshCmd], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${sshCmd}"`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const terms = [['gnome-terminal', ['--', 'bash', '-c', sshCmd + '; bash']], ['xterm', ['-e', sshCmd]], ['konsole', ['-e', sshCmd]]];
      for (const [term, args] of terms) {
        if (spawnSync('which', [term], { encoding: 'utf8' }).status === 0) {
          spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
          break;
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/backups ──────────────────────────────────────────────────────────
app.get('/api/backups', (req, res) => {
  ensureBackupsDir();
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => { const st = fs.statSync(path.join(BACKUPS_DIR, f)); return { filename: f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ backups: files });
  } catch { res.json({ backups: [] }); }
});

// ── DELETE /api/backups/:filename ─────────────────────────────────────────────
app.delete('/api/backups/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  if (!name.endsWith('.db')) return res.status(400).json({ error: 'Invalid filename' });
  try { fs.unlinkSync(path.join(BACKUPS_DIR, name)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/deploy/restore-local ───────────────────────────────────────────
app.post('/api/deploy/restore-local', (req, res) => {
  const name = path.basename(req.body.filename || '');
  if (!name.endsWith('.db')) return res.status(400).json({ error: 'Invalid filename' });
  const src = path.join(BACKUPS_DIR, name);
  const dst = path.join(ROOT, 'data', 'portfolio.db');
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Backup not found' });
  const wasRunning = isServerRunning();
  if (wasRunning) stopServer();
  try { fs.copyFileSync(src, dst); res.json({ ok: true, wasRunning }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/deploy/restore-server (SSE) ─────────────────────────────────────
app.get('/api/deploy/restore-server', async (req, res) => {
  const name = path.basename(req.query.filename || '');
  if (!name.endsWith('.db')) return res.status(400).json({ error: 'Invalid filename' });
  const src = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(src)) return res.status(400).json({ error: 'Backup not found' });
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  const useRsync = commandExists('rsync');
  send({ type: 'info', text: `→ Pushing ${name} to server as portfolio.db...` });
  const code = useRsync
    ? await streamCommand('rsync', rsyncArgs(src, `${user}@${host}:${rp}/data/portfolio.db`, sshPort), {}, send)
    : await streamCommand('scp', [...scpPortArgs(sshPort), src, `${user}@${host}:${rp}/data/portfolio.db`], {}, send);
  send({ type: code === 0 ? 'done' : 'error', text: code === 0 ? '✓ Backup pushed to server.' : '✗ Failed — check output above.' });
  res.end();
});

// ── GET /api/deploy/compare ───────────────────────────────────────────────────
app.get('/api/deploy/compare', (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });

  let localProjects = [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(ROOT, 'data', 'portfolio.db'), { readonly: true });
    localProjects = db.prepare('SELECT slug, title FROM projects ORDER BY sort_order').all();
    db.close();
  } catch {}

  let remoteProjects = [], remoteError = null;
  try {
    const cmd = `${remoteRpPrefix(cfg.remotePath)} && node -e "try{const db=require('better-sqlite3')('data/portfolio.db',{readonly:true});console.log(JSON.stringify(db.prepare('SELECT slug,title FROM projects ORDER BY sort_order').all()));db.close();}catch(e){process.stderr.write(e.message);process.exit(1);}"`;
    const r = spawnSync('ssh', sshArgs(cfg.user, cfg.host, cfg.sshPort || 22, cmd), { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && r.stdout.trim()) remoteProjects = JSON.parse(r.stdout.trim());
    else remoteError = (r.stderr || 'Could not read remote database').trim();
  } catch (e) { remoteError = e.message; }

  const localSlugs = new Set(localProjects.map(p => p.slug));
  const remoteSlugs = new Set(remoteProjects.map(p => p.slug));
  res.json({
    local: localProjects, remote: remoteProjects,
    localOnly:  localProjects.filter(p => !remoteSlugs.has(p.slug)),
    remoteOnly: remoteProjects.filter(p => !localSlugs.has(p.slug)),
    both: localProjects.filter(p => remoteSlugs.has(p.slug)),
    remoteError,
  });
});

// ── GET /api/deploy/push-project (SSE) ───────────────────────────────────────
app.get('/api/deploy/push-project', async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  const useRsync = commandExists('rsync');

  let project;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(ROOT, 'data', 'portfolio.db'), { readonly: true });
    project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
    db.close();
  } catch (e) { send({ type: 'error', text: 'Could not read local DB: ' + e.message }); res.end(); return; }
  if (!project) { send({ type: 'error', text: `Project "${slug}" not found locally.` }); res.end(); return; }

  send({ type: 'info', text: `→ Pushing project data for "${project.title}"...` });
  const safeRp = rp.replace(/'/g, "'\\''");
  const importScript = `${remoteRpPrefix(rp)} && node -e "const db=require('better-sqlite3')('data/portfolio.db');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d);const cols=Object.keys(p);const ex=db.prepare('SELECT slug FROM projects WHERE slug=?').get(p.slug);if(ex){const uc=cols.filter(c=>c!=='slug');db.prepare('UPDATE projects SET '+uc.map(c=>c+'=?').join(',')+' WHERE slug=?').run([...uc.map(c=>p[c]),p.slug]);}else{db.prepare('INSERT INTO projects ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+'  )').run(cols.map(c=>p[c]));}db.close();console.log('ok');}catch(e){process.stderr.write(e.message);process.exit(1);}});"`;
  const dataCode = await streamCommand('ssh', sshArgs(cfg.user, host, sshPort, importScript), { stdin: JSON.stringify(project) }, send);
  if (dataCode !== 0) { send({ type: 'error', text: '✗ Failed to push project data.' }); res.end(); return; }

  const localImgDir = `public/images/projects/${slug}`;
  if (fs.existsSync(path.join(ROOT, localImgDir))) {
    send({ type: 'info', text: `→ Pushing images...` });
    const imgCode = useRsync
      ? await streamCommand('rsync', rsyncArgs(localImgDir + '/', `${user}@${host}:${rp}/public/images/projects/${slug}/`, sshPort), {}, send)
      : await streamCommand('scp', ['-r', ...scpPortArgs(sshPort), localImgDir, `${user}@${host}:${rp}/public/images/projects/`], {}, send);
    if (imgCode !== 0) { send({ type: 'error', text: '✗ Failed to push images.' }); res.end(); return; }
  }
  send({ type: 'done', text: `✓ "${project.title}" pushed to server.` }); res.end();
});

// ── GET /api/deploy/pull-project (SSE) ───────────────────────────────────────
app.get('/api/deploy/pull-project', async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  const useRsync = commandExists('rsync');

  send({ type: 'info', text: `→ Fetching "${slug}" from server...` });
  const safeRp = rp.replace(/'/g, "'\\''");
  const safeSlug = slug.replace(/'/g, "'\\''");
  const exportCmd = `${remoteRpPrefix(rp)} && node -e "const db=require('better-sqlite3')('data/portfolio.db',{readonly:true});const p=db.prepare('SELECT * FROM projects WHERE slug=?').get('${safeSlug}');db.close();if(!p){process.stderr.write('not found');process.exit(1);}console.log(JSON.stringify(p));"`;

  let projectJson = '';
  const exportCode = await new Promise(resolve => {
    const proc = spawn('ssh', sshArgs(cfg.user, host, sshPort, exportCmd), { cwd: ROOT });
    proc.stdout.on('data', d => projectJson += d.toString());
    proc.stderr.on('data', d => send({ type: 'err', text: d.toString().trim() }));
    proc.on('close', resolve);
  });
  if (exportCode !== 0 || !projectJson.trim()) { send({ type: 'error', text: '✗ Could not fetch project from server.' }); res.end(); return; }

  try {
    const project = JSON.parse(projectJson.trim());
    const Database = require('better-sqlite3');
    const db = new Database(path.join(ROOT, 'data', 'portfolio.db'));
    const cols = Object.keys(project);
    const existing = db.prepare('SELECT slug FROM projects WHERE slug = ?').get(project.slug);
    if (existing) {
      const uc = cols.filter(c => c !== 'slug');
      db.prepare(`UPDATE projects SET ${uc.map(c => c + '=?').join(',')} WHERE slug=?`).run([...uc.map(c => project[c]), project.slug]);
    } else {
      db.prepare(`INSERT INTO projects (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(cols.map(c => project[c]));
    }
    db.close();
    send({ type: 'info', text: '  Project data imported.' });
  } catch (e) { send({ type: 'error', text: '✗ Failed to import: ' + e.message }); res.end(); return; }

  const localImgDir = path.join(ROOT, 'public', 'images', 'projects', slug);
  send({ type: 'info', text: `→ Pulling images...` });
  let imgCode;
  if (useRsync) {
    imgCode = await streamCommand('rsync', rsyncArgs(`${user}@${host}:${rp}/public/images/projects/${slug}/`, `public/images/projects/${slug}/`, sshPort), {}, send);
  } else {
    try { if (fs.existsSync(localImgDir)) fs.rmSync(localImgDir, { recursive: true }); } catch {}
    imgCode = await streamCommand('scp', ['-r', ...scpPortArgs(sshPort), `${user}@${host}:${rp}/public/images/projects/${slug}`, path.join(ROOT, 'public/images/projects/')], {}, send);
  }
  send({ type: imgCode === 0 ? 'done' : 'error', text: imgCode === 0 ? `✓ "${slug}" pulled from server.` : '✗ Failed to pull images (data was imported).' });
  res.end();
});

// ── GET /api/deploy/clone-install (SSE) ──────────────────────────────────────
app.get('/api/deploy/clone-install', async (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const { host, user, remotePath: rp } = cfg;
  const sshPort = cfg.sshPort || 22;
  const send = sseSetup(res);
  send({ type: 'info', text: '→ Cloning open-folio to server...' });
  const cmd = `git clone https://github.com/lucas-iezzi/open-folio "${rp.trim().replace(/^~/, '$HOME')}" && ${remoteRpPrefix(rp)} && npm install --omit=dev`;
  const code = await streamCommand('ssh', sshArgs(cfg.user, host, sshPort, cmd), {}, send);
  send({ type: code === 0 ? 'done' : 'error', text: code === 0 ? '✓ Repository cloned and dependencies installed.' : '✗ Failed — check output above.' });
  res.end();
});

// ── GET /api/deploy/pm2-start (SSE) ──────────────────────────────────────────
app.get('/api/deploy/pm2-start', async (req, res) => {
  const cfg = readServerConfig().server;
  if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
  const send = sseSetup(res);
  send({ type: 'info', text: '→ Starting site with PM2...' });
  const cmd = `${remoteRpPrefix(cfg.remotePath)} && pm2 start scripts/ecosystem.config.js --env production && pm2 save && pm2 status`;
  const code = await streamCommand('ssh', sshArgs(cfg.user, cfg.host, cfg.sshPort || 22, cmd), {}, send);
  send({ type: code === 0 ? 'done' : 'error', text: code === 0 ? '✓ Site started.' : '✗ Failed — is PM2 installed? (npm install -g pm2)' });
  res.end();
});

// ── Remote SSH commands (SSE) ─────────────────────────────────────────────────
function remoteSSE(getCommand) {
  return async (req, res) => {
    const cfg = readServerConfig().server;
    if (!cfg || !cfg.host) return res.status(400).json({ error: 'No server configured' });
    const send = sseSetup(res);
    const cmd  = typeof getCommand === 'function' ? getCommand(cfg) : getCommand;
    const args = sshArgs(cfg.user, cfg.host, cfg.sshPort || 22, cmd);
    const code = await streamCommand('ssh', args, {}, send);
    send({ type: code === 0 ? 'done' : 'error', text: code === 0 ? '✓ Done.' : '✗ Finished with errors.' });
    res.end();
  };
}

app.get('/api/deploy/restart', remoteSSE('pm2 restart open-folio && pm2 status'));
app.get('/api/deploy/logs',    remoteSSE('pm2 logs open-folio --lines 60 --nostream'));
app.get('/api/deploy/status',  remoteSSE('pm2 status && echo "" && df -h / && echo "" && uptime'));
app.get('/api/deploy/update',  remoteSSE((cfg) => {
  return `${remoteRpPrefix(cfg.remotePath)} && git pull && npm install --omit=dev && pm2 restart open-folio && pm2 status`;
}));

// ── POST /api/launcher/quit ───────────────────────────────────────────────────
app.post('/api/launcher/quit', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

// ── Startup ───────────────────────────────────────────────────────────────────
// Portfolio server is detached — don't kill it when the launcher exits
process.on('SIGINT', () => { console.log('\n  Launcher closed. Portfolio server keeps running.\n'); process.exit(0); });

app.listen(LAUNCHER_PORT, '127.0.0.1', () => {
  const url = `http://localhost:${LAUNCHER_PORT}`;
  console.log(`\n  open-folio launcher  →  ${url}`);
  console.log('  Press Ctrl+C to stop.\n');
  openBrowser(url);
});
