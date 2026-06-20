#!/usr/bin/env node
'use strict';

const readline = require('readline');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log('\n🔧  Portfolio Setup\n');

  const password = await question('Choose an admin password: ');
  if (!password || password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }

  const confirm = await question('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  console.log('\nHashing password (this takes a moment)...');
  const hash = await bcrypt.hash(password, 12);
  const secret = crypto.randomBytes(64).toString('hex');

  const envPath = path.join(__dirname, '..', '.env');
  const apiKey = crypto.randomBytes(32).toString('hex');
  const envContent = [
    `PORT=3000`,
    `NODE_ENV=development`,
    `SESSION_SECRET=${secret}`,
    `ADMIN_PASSWORD_HASH=${hash}`,
    `API_KEY=${apiKey}`,
  ].join('\n') + '\n';

  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log('\n✅  .env file created.');
  console.log('   Admin panel: http://localhost:3000/admin/login');
  console.log('   Run: npm start\n');

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
