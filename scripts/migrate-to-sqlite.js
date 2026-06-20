'use strict';
// One-time migration: imports data/projects.json → data/portfolio.db
// Safe to re-run — uses INSERT OR REPLACE, won't duplicate records.

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const JSON_PATH = path.join(__dirname, '..', 'data', 'projects.json');
const DB_PATH   = path.join(__dirname, '..', 'data', 'portfolio.db');

if (!fs.existsSync(JSON_PATH)) {
  console.log('No projects.json found — nothing to migrate.');
  process.exit(0);
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    slug         TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    subtitle     TEXT NOT NULL DEFAULT '',
    thumbnail    TEXT NOT NULL DEFAULT '',
    thumbnailAlt TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    sections     TEXT NOT NULL DEFAULT '[]'
  )
`);

const projects = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const insert = db.prepare(`
  INSERT OR REPLACE INTO projects (slug, title, subtitle, thumbnail, thumbnailAlt, sort_order, sections)
  VALUES (@slug, @title, @subtitle, @thumbnail, @thumbnailAlt, @sort_order, @sections)
`);

const run = db.transaction(rows => {
  for (const p of rows) {
    insert.run({
      slug:         p.slug         || '',
      title:        p.title        || '',
      subtitle:     p.subtitle     || '',
      thumbnail:    p.thumbnail    || '',
      thumbnailAlt: p.thumbnailAlt || '',
      sort_order:   p.order        ?? 0,
      sections:     JSON.stringify(p.sections || []),
    });
  }
});

run(projects);
console.log(`✓ Migrated ${projects.length} project(s) to ${DB_PATH}`);
