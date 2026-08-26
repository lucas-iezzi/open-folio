#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

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

// Writes a fresh .env. A password/admin path are only meaningful for a live,
// publicly-reachable deployment — local access never needs either (see
// isLocalAccess()/requireAuth() in server.js), so both are optional here.
function writeEnv({ hash, adminPath } = {}) {
  const secret  = crypto.randomBytes(64).toString('hex');
  const apiKey  = crypto.randomBytes(32).toString('hex');
  const lines = [`PORT=3000`, `SESSION_SECRET=${secret}`, `API_KEY=${apiKey}`];
  if (hash) lines.splice(1, 0, `NODE_ENV=production`, `ADMIN_PASSWORD_HASH=${hash}`);
  if (adminPath) lines.push(`ADMIN_PATH=${adminPath}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
}

// ── Non-interactive mode: node scripts/setup.js --password=xxx [--admin-path=xxx] ──
// Used by the deploy carousel's "First-time server setup" step, run over SSH on a
// remote server — that's the one place a password (and optionally a custom admin
// path) actually get set.
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);

if (args.password !== undefined) {
  const pw = args.password;
  if (!pw || pw.length < 10) {
    console.error('Error: password must be at least 10 characters.');
    process.exit(1);
  }
  let adminPath;
  try {
    if (args['admin-path'] !== undefined && args['admin-path'] !== '') {
      adminPath = validateAdminPath(args['admin-path']);
    }
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
  bcrypt.hash(pw, 12).then(hash => {
    writeEnv({ hash, adminPath });
    console.log('.env created. Run: pm2 restart open-folio');
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(1); });
} else {
  // ── Local mode: no password needed — just generate a session secret + API key ──
  if (fs.existsSync(ENV_PATH)) {
    console.log('\n  .env already exists — nothing to do.');
    console.log('  (delete it first if you want to regenerate it)\n');
    process.exit(0);
  }
  writeEnv();
  console.log('\n  .env file created.');
  console.log('  Admin panel: http://localhost:3000/admin/dashboard  (no password needed locally)');
  console.log('  Run: npm start\n');
}
