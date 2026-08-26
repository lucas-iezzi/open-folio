#!/usr/bin/env node
'use strict';

/**
 * manage.js — Server Management Tool
 *
 * Run this on your web server via SSH to change credentials and settings
 * while the site is live.  Changes to .env take effect after restarting:
 *
 *   node manage.js
 *   pm2 restart open-folio     ← apply changes
 */

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const ROOT     = __dirname;
const ENV_PATH = path.join(ROOT, '.env');

// ── ANSI colors ───────────────────────────────────────────────────────────────
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

// ── Readline ──────────────────────────────────────────────────────────────────
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

function mask(s) {
  if (!s || s.length < 8) return C.dim + '(not set)' + C.reset;
  return C.gray + s.slice(0, 4) + '…' + s.slice(-4) + C.reset;
}

const RESERVED_ADMIN_PATHS = new Set([
  'projects', 'sandbox', 'api', 'robots.txt', 'logo-size.css', 'sandbox-active.css',
  'images', 'js', 'css', 'public', 'login', 'logout', 'dashboard',
]);
function validateAdminPath(raw) {
  const clean = String(raw).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(clean)) {
    throw new Error('Admin path must be 3-40 characters: lowercase letters, numbers, and hyphens only.');
  }
  if (clean !== 'admin' && RESERVED_ADMIN_PATHS.has(clean)) {
    throw new Error(`"${clean}" is a reserved path and can't be used.`);
  }
  return clean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function banner() {
  if (TTY) process.stdout.write('\x1b[2J\x1b[H');
  console.log();
  console.log(C.bold + '  ┌──────────────────────────────────────────────────────┐' + C.reset);
  console.log(C.bold + '  │        Server Management Tool                        │' + C.reset);
  console.log(C.bold + '  └──────────────────────────────────────────────────────┘' + C.reset);
  console.log();
}

async function pause() {
  await ask('\n  Press Enter to continue...');
}

function restartHint() {
  console.log('  ' + arrow('Apply changes: pm2 restart open-folio'));
}

// ── Non-interactive CLI mode ──────────────────────────────────────────────────
// Usage: node manage.js --set-password=xxx
//        node manage.js --set-admin-path=xxx
//        node manage.js --rotate-secret
//        node manage.js --rotate-api-key
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

async function runCli(bcrypt) {
  if (cliArgs['set-password'] !== undefined) {
    const pw = cliArgs['set-password'];
    if (!pw || pw.length < 10) { console.error('Error: password must be at least 10 characters.'); process.exit(1); }
    const hash = await bcrypt.hash(pw, 12);
    writeEnvKey('ADMIN_PASSWORD_HASH', hash);
    console.log('Password updated. Restart to apply: pm2 restart open-folio');
    process.exit(0);
  }
  if (cliArgs['set-admin-path'] !== undefined) {
    let clean;
    try { clean = validateAdminPath(cliArgs['set-admin-path']); }
    catch (e) { console.error('Error: ' + e.message); process.exit(1); }
    writeEnvKey('ADMIN_PATH', clean);
    console.log('Admin path updated. Restart to apply: pm2 restart open-folio');
    process.exit(0);
  }
  if ('rotate-secret' in cliArgs) {
    writeEnvKey('SESSION_SECRET', crypto.randomBytes(64).toString('hex'));
    console.log('Session secret rotated. Restart to apply: pm2 restart open-folio');
    process.exit(0);
  }
  if ('rotate-api-key' in cliArgs) {
    writeEnvKey('API_KEY', crypto.randomBytes(32).toString('hex'));
    console.log('API key rotated. Restart to apply: pm2 restart open-folio');
    process.exit(0);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ENV_PATH)) {
    console.log('\n  ' + cross('.env not found. Run node launcher.js on this machine first.\n'));
    rl.close();
    process.exit(1);
  }

  let bcrypt;
  try {
    bcrypt = require('bcryptjs');
  } catch {
    console.log('\n  ' + cross('bcryptjs not installed. Run: npm install\n'));
    rl.close();
    process.exit(1);
  }

  // Handle non-interactive CLI flags before entering the interactive loop
  if (Object.keys(cliArgs).length > 0) {
    await runCli(bcrypt);
    // runCli calls process.exit — only reaches here for unknown flags
    console.error('Unknown flag. Supported: --set-password=xxx, --set-admin-path=xxx, --rotate-secret, --rotate-api-key');
    rl.close();
    process.exit(1);
  }

  while (true) {
    banner();
    const env = parseEnv();

    // ── Status panel ─────────────────────────────────────────────────────────
    console.log(C.bold + '  Current Settings' + C.reset);
    console.log(hr());
    console.log('  Port                ' + C.cyan + (env.PORT || '3000') + C.reset);
    console.log('  Environment         ' + C.cyan + (env.NODE_ENV || 'development') + C.reset);
    console.log('  Admin password      ' + (env.ADMIN_PASSWORD_HASH
      ? C.green + 'set' + C.reset
      : C.red   + 'NOT SET — admin panel inaccessible remotely' + C.reset));
    console.log('  Admin path          ' + C.cyan + '/' + (env.ADMIN_PATH || 'admin') + C.reset
      + (env.ADMIN_PATH ? '' : C.dim + '  (default — no secret gate)' + C.reset));
    console.log('  Session secret      ' + mask(env.SESSION_SECRET));
    console.log('  REST API key        ' + mask(env.API_KEY));
    const curProv = (env.AI_PROVIDER || 'anthropic').toLowerCase();
    const provNames = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (ChatGPT)', gemini: 'Google Gemini' };
    const provKeyEnvs = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
    console.log('  AI provider         ' + C.cyan + (provNames[curProv] || curProv) + C.reset
      + '  key: ' + (env[provKeyEnvs[curProv]] ? C.green + 'set' + C.reset : C.dim + 'not set' + C.reset));
    console.log();

    // ── Menu ─────────────────────────────────────────────────────────────────
    console.log(C.bold + '  Options' + C.reset);
    console.log(hr());
    console.log('  ' + C.bold + '[1]' + C.reset + ' Change admin password     '
      + C.dim + '← the secret word for /admin/login' + C.reset);
    console.log('  ' + C.bold + '[2]' + C.reset + ' Rotate session secret     '
      + C.dim + '← signs out every active session' + C.reset);
    console.log('  ' + C.bold + '[3]' + C.reset + ' Rotate REST API key       '
      + C.dim + '← generates a new random key' + C.reset);
    console.log('  ' + C.bold + '[4]' + C.reset + ' Change port');
    console.log('  ' + C.bold + '[5]' + C.reset + ' Configure AI provider & key');
    console.log('  ' + C.bold + '[6]' + C.reset + ' Show full .env contents   '
      + C.dim + '← reveals secrets, use with care' + C.reset);
    console.log('  ' + C.bold + '[7]' + C.reset + ' Change admin secret path  '
      + C.dim + '← type this instead of "admin" to reach /admin/login' + C.reset);
    console.log('  ' + C.bold + '[q]' + C.reset + ' Quit');
    console.log();
    console.log('  ' + C.yellow + '!' + C.reset
      + C.dim + ' Changes take effect after:  pm2 restart open-folio' + C.reset);
    console.log();

    const choice = (await ask('  Enter choice: ')).trim().toLowerCase();
    console.log();

    // ── [1] Change admin password ─────────────────────────────────────────────
    if (choice === '1') {
      console.log(C.bold + '  Change Admin Password' + C.reset);
      console.log(hr());
      console.log('  This is the secret word you type at /admin/login.\n');

      let pw = '';
      while (true) {
        pw = await ask('  New password (min 10 characters): ');
        if (pw.length >= 10) break;
        console.log('  ' + warn('Must be at least 10 characters.'));
      }
      const pw2 = await ask('  Confirm password: ');
      if (pw !== pw2) {
        console.log('\n  ' + cross('Passwords do not match — nothing saved.'));
      } else {
        console.log('  ' + C.dim + 'Hashing…' + C.reset);
        const hash = await bcrypt.hash(pw, 12);
        writeEnvKey('ADMIN_PASSWORD_HASH', hash);
        console.log('  ' + tick('Password updated.'));
        restartHint();
      }
      await pause();

    // ── [2] Rotate session secret ─────────────────────────────────────────────
    } else if (choice === '2') {
      console.log(C.bold + '  Rotate Session Secret' + C.reset);
      console.log(hr());
      console.log('  ' + C.yellow + 'Warning:' + C.reset + ' everyone currently logged in will be signed out.\n');
      const confirm = (await ask('  Type "yes" to proceed, anything else to cancel: ')).trim().toLowerCase();
      if (confirm === 'yes') {
        writeEnvKey('SESSION_SECRET', crypto.randomBytes(64).toString('hex'));
        console.log('\n  ' + tick('Session secret rotated.'));
        restartHint();
      } else {
        console.log('  ' + C.dim + '(cancelled)' + C.reset);
      }
      await pause();

    // ── [3] Rotate REST API key ───────────────────────────────────────────────
    } else if (choice === '3') {
      console.log(C.bold + '  Rotate REST API Key' + C.reset);
      console.log(hr());
      console.log('  ' + C.yellow + 'Warning:' + C.reset + ' the current API_KEY will stop working immediately after restart.\n');
      const confirm = (await ask('  Type "yes" to proceed, anything else to cancel: ')).trim().toLowerCase();
      if (confirm === 'yes') {
        const newKey = crypto.randomBytes(32).toString('hex');
        writeEnvKey('API_KEY', newKey);
        console.log('\n  ' + tick('API key rotated.'));
        console.log('  New key: ' + C.cyan + newKey + C.reset);
        console.log('  ' + C.dim + 'Save this — it won\'t be shown again.' + C.reset);
        restartHint();
      } else {
        console.log('  ' + C.dim + '(cancelled)' + C.reset);
      }
      await pause();

    // ── [4] Change port ───────────────────────────────────────────────────────
    } else if (choice === '4') {
      console.log(C.bold + '  Change Port' + C.reset);
      console.log(hr());
      const cur = env.PORT || '3000';
      const input = (await ask('  New port [' + cur + ']: ')).trim();
      const newPort = parseInt(input, 10);
      if (!input) {
        console.log('  ' + C.dim + '(no change)' + C.reset);
      } else if (!newPort || newPort < 1 || newPort > 65535) {
        console.log('  ' + warn('Invalid port number.'));
      } else {
        writeEnvKey('PORT', String(newPort));
        console.log('  ' + tick('Port changed to ' + newPort + '.'));
        console.log('  ' + C.dim + 'Also update your Caddy reverse_proxy target if needed.' + C.reset);
        restartHint();
      }
      await pause();

    // ── [5] Configure AI provider & key ──────────────────────────────────────
    } else if (choice === '5') {
      console.log(C.bold + '  Configure AI Provider' + C.reset);
      console.log(hr());

      const provHints  = { anthropic: 'sk-ant-…', openai: 'sk-…', gemini: 'AIza…' };
      const provKeyMap = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
      const curActive  = (env.AI_PROVIDER || 'anthropic').toLowerCase();

      console.log('  [a] Anthropic (Claude)  ' + (curActive === 'anthropic' ? C.dim + '← active' + C.reset : ''));
      console.log('  [b] OpenAI (ChatGPT)    ' + (curActive === 'openai'    ? C.dim + '← active' + C.reset : ''));
      console.log('  [c] Google Gemini       ' + (curActive === 'gemini'    ? C.dim + '← active' + C.reset : ''));
      console.log('  [x] Cancel');
      console.log();

      const provChoice   = (await ask('  Choose provider: ')).trim().toLowerCase();
      const provMap      = { a: 'anthropic', b: 'openai', c: 'gemini' };
      const chosenProv   = provMap[provChoice];

      if (!chosenProv) {
        console.log('  ' + C.dim + '(cancelled)' + C.reset);
      } else {
        const keyEnv  = provKeyMap[chosenProv];
        const hasKey  = !!env[keyEnv];
        const hint    = hasKey ? ' [currently set — press Enter to keep]' : ' [press Enter to skip]';
        const newKey  = (await ask(
          '  ' + provNames[chosenProv] + ' API key' + hint + '\n'
          + '  Format: ' + provHints[chosenProv] + '\n  Key: '
        )).trim();

        if (newKey) {
          writeEnvKey(keyEnv, newKey);
          console.log('  ' + tick('API key saved.'));
        } else if (!hasKey) {
          console.log('  ' + C.dim + '(no key entered — skipped)' + C.reset);
        }

        writeEnvKey('AI_PROVIDER', chosenProv);
        console.log('  ' + tick('Active provider → ' + provNames[chosenProv] + '.'));
        restartHint();
      }
      await pause();

    // ── [6] Show full .env ────────────────────────────────────────────────────
    } else if (choice === '6') {
      console.log(C.bold + '  .env Contents' + C.reset + '  ' + C.red + C.bold + '(sensitive — make sure no one is watching)' + C.reset);
      console.log(hr());
      const raw = fs.readFileSync(ENV_PATH, 'utf8').trimEnd();
      console.log(C.dim + raw + C.reset);
      console.log();
      await pause();

    // ── [7] Change admin secret path ──────────────────────────────────────────
    } else if (choice === '7') {
      console.log(C.bold + '  Change Admin Secret Path' + C.reset);
      console.log(hr());
      console.log('  Instead of typing "admin" to reach the login page, visitors type this');
      console.log('  word instead — e.g. set it to "portal" and /portal takes them to');
      console.log('  /admin/login. Leave as "admin" to disable this (no secret needed).\n');

      const input = await ask('  New admin path [' + (env.ADMIN_PATH || 'admin') + ']: ');
      if (!input.trim()) {
        console.log('  ' + C.dim + '(no change)' + C.reset);
      } else {
        try {
          const clean = validateAdminPath(input);
          writeEnvKey('ADMIN_PATH', clean);
          console.log('  ' + tick('Admin path set to "' + clean + '".'));
          restartHint();
        } catch (e) {
          console.log('  ' + warn(e.message));
        }
      }
      await pause();

    // ── [q] Quit ──────────────────────────────────────────────────────────────
    } else if (choice === 'q' || choice === 'quit' || choice === 'exit') {
      console.log(C.dim + '  Goodbye.\n' + C.reset);
      rl.close();
      process.exit(0);

    } else {
      console.log('  ' + warn('Unknown option — enter a number or letter from the menu.'));
      await pause();
    }
  }
}

main().catch((e) => {
  console.error('\n  ' + cross('Fatal: ' + e.message));
  rl.close();
  process.exit(1);
});
