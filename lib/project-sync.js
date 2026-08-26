'use strict';
// Reads or writes a single project row, preserving its existing sort_order (or
// appending at the end for a brand-new slug) — shared by server.js (local, via the
// already-open db handle) and scripts/sync-db-row.js (remote, via a fresh connection
// over SSH), so one project can be synced without touching the rest of the table or
// reshuffling its ordering.

function readProjectRow(db, slug) {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) || null;
}

function upsertProjectRow(db, p) {
  if (!p || typeof p.slug !== 'string' || !p.slug) throw new Error('Invalid project payload — missing slug.');
  const existing = db.prepare('SELECT sort_order FROM projects WHERE slug = ?').get(p.slug);
  const sortOrder = existing
    ? existing.sort_order
    : db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM projects').get().n;

  db.prepare(`
    INSERT INTO projects (slug, title, subtitle, pageTitle, thumbnail, thumbnailAlt, sort_order, visible, sections, draft_data)
    VALUES (@slug, @title, @subtitle, @pageTitle, @thumbnail, @thumbnailAlt, @sort_order, @visible, @sections, @draft_data)
    ON CONFLICT(slug) DO UPDATE SET
      title        = excluded.title,
      subtitle     = excluded.subtitle,
      pageTitle    = excluded.pageTitle,
      thumbnail    = excluded.thumbnail,
      thumbnailAlt = excluded.thumbnailAlt,
      visible      = excluded.visible,
      sections     = excluded.sections,
      draft_data   = excluded.draft_data
  `).run({
    slug:         p.slug,
    title:        p.title || '',
    subtitle:     p.subtitle || '',
    pageTitle:    p.pageTitle || '',
    thumbnail:    p.thumbnail || '',
    thumbnailAlt: p.thumbnailAlt || '',
    sort_order:   sortOrder,
    visible:      p.visible ? 1 : 0,
    sections:     typeof p.sections === 'string' ? p.sections : JSON.stringify(p.sections || []),
    draft_data:   p.draft_data === undefined ? null : p.draft_data,
  });
}

function readAllSettings(db) {
  try { return db.prepare('SELECT key, value FROM settings').all(); }
  catch { return []; }
}

function writeAllSettings(db, rows) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction((entries) => { for (const { key, value } of entries) stmt.run(key, value); });
  tx(Array.isArray(rows) ? rows : []);
}

module.exports = { readProjectRow, upsertProjectRow, readAllSettings, writeAllSettings };
