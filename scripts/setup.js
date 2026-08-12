#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function writeEnv(password, hash) {
  const secret  = crypto.randomBytes(64).toString('hex');
  const apiKey  = crypto.randomBytes(32).toString('hex');
  const content = [
    `PORT=3000`,
    `NODE_ENV=production`,
    `SESSION_SECRET=${secret}`,
    `ADMIN_PASSWORD_HASH=${hash}`,
    `API_KEY=${apiKey}`,
  ].join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

// ── Non-interactive mode: node scripts/setup.js --password=xxx ────────────────
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
  bcrypt.hash(pw, 12).then(hash => {
    writeEnv(pw, hash);
    console.log('.env created. Run: pm2 restart open-folio');
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(1); });
} else {
  // ── Interactive mode ──────────────────────────────────────────────────────
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  async function main() {
    console.log('\n  Portfolio Setup\n');

    const password = await question('Choose an admin password: ');
    if (!password || password.length < 10) {
      console.error('Password must be at least 10 characters.');
      rl.close();
      process.exit(1);
    }

    const confirm = await question('Confirm password: ');
    if (password !== confirm) {
      console.error('Passwords do not match.');
      rl.close();
      process.exit(1);
    }

    console.log('\nHashing password (this takes a moment)...');
    const hash = await bcrypt.hash(password, 12);
    writeEnv(password, hash);

    console.log('\n  .env file created.');
    console.log('  Admin panel: http://localhost:3000/admin/login');
    console.log('  Run: npm start\n');
    rl.close();
  }

  main().catch((err) => { console.error(err); process.exit(1); });
}
