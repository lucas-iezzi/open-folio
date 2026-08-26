#!/usr/bin/env node
'use strict';
// Reads or writes a single project row, or the whole settings table, on whichever
// machine this runs on. Invoked locally (in-process, via lib/project-sync.js directly)
// and remotely over SSH (this CLI, with JSON piped over stdin for writes) by
// /admin/deploy/sync-item, so a single project or the settings table can be synced
// without pushing/pulling the entire database file.
//
// Usage:
//   node scripts/sync-db-row.js --read-project <slug>
//   node scripts/sync-db-row.js --write-project     (JSON project row on stdin)
//   node scripts/sync-db-row.js --read-settings
//   node scripts/sync-db-row.js --write-settings     (JSON array of {key,value} on stdin)

const path = require('path');
const Database = require('better-sqlite3');
const { readProjectRow, upsertProjectRow, readAllSettings, writeAllSettings } = require('../lib/project-sync');

const dbPath = path.join(__dirname, '..', 'data', 'portfolio.db');
const [mode, arg] = process.argv.slice(2);

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

async function main() {
  if (mode === '--read-project') {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = readProjectRow(db, arg);
    db.close();
    if (!row) { process.stderr.write('not found'); process.exit(1); }
    process.stdout.write(JSON.stringify(row));
    return;
  }

  if (mode === '--write-project') {
    const raw = await readStdin();
    const db = new Database(dbPath);
    upsertProjectRow(db, JSON.parse(raw));
    db.close();
    process.stdout.write('ok');
    return;
  }

  if (mode === '--read-settings') {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = readAllSettings(db);
    db.close();
    process.stdout.write(JSON.stringify(rows));
    return;
  }

  if (mode === '--write-settings') {
    const raw = await readStdin();
    const db = new Database(dbPath);
    writeAllSettings(db, JSON.parse(raw));
    db.close();
    process.stdout.write('ok');
    return;
  }

  process.stderr.write('Usage: sync-db-row.js --read-project <slug> | --write-project | --read-settings | --write-settings');
  process.exit(1);
}

main().catch((e) => { process.stderr.write(e.message); process.exit(1); });
