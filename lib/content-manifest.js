'use strict';
// Shared by server.js (local, in-process) and scripts/manifest.js (invoked over SSH on
// the remote server) so both sides compute "what images actually belong to real content"
// the exact same way. This is what content sync uses to tell real content apart from
// orphaned files left behind by deleted projects, failed uploads, etc.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// '/images/projects/slug/uuid.jpg' -> 'projects/slug/uuid.jpg' (matches the relative
// keys used for the on-disk file listing). Returns null for anything outside
// public/images/{projects,logos}/ (e.g. studio-temp paths, which aren't permanent content).
function normalizeRef(p) {
  if (!p || typeof p !== 'string') return null;
  const m = p.match(/^\/images\/(projects|logos)\/(.+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function collectProjectRefs(project, out) {
  if (!project || typeof project !== 'object') return;
  const t = normalizeRef(project.thumbnail);
  if (t) out.add(t);
  for (const s of (Array.isArray(project.sections) ? project.sections : [])) {
    for (const img of (Array.isArray(s.images) ? s.images : [])) {
      const r = normalizeRef(img && img.src);
      if (r) out.add(r);
    }
  }
}

// Every image path any project (including hidden/draft ones) actually points to, plus
// the two logo settings. This is "real content" — everything else on disk is an orphan.
function computeReferencedPaths(db) {
  const out = new Set();
  const rows = db.prepare('SELECT thumbnail, sections, draft_data FROM projects').all();
  for (const row of rows) {
    const t = normalizeRef(row.thumbnail);
    if (t) out.add(t);
    let sections = [];
    try { sections = JSON.parse(row.sections || '[]'); } catch { /* malformed — skip */ }
    collectProjectRefs({ thumbnail: null, sections }, out);
    if (row.draft_data) {
      try { collectProjectRefs(JSON.parse(row.draft_data), out); } catch { /* malformed — skip */ }
    }
  }
  let settingsRows = [];
  try {
    settingsRows = db.prepare("SELECT value FROM settings WHERE key IN ('logo_small','logo_mark')").all();
  } catch { /* settings table missing on very old DBs */ }
  for (const row of settingsRows) {
    const r = normalizeRef(row.value);
    if (r) out.add(r);
  }
  return out;
}

// Recursively lists files under public/images/ as 'projects/slug/file.jpg' -> {size, mtimeMs}.
function listFiles(baseDir) {
  const out = new Map();
  if (!fs.existsSync(baseDir)) return out;
  (function walk(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const st = fs.statSync(full);
        out.set(rel, { size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      }
    }
  })(baseDir, '');
  return out;
}

// dbPath: path to portfolio.db. imagesDir: path to public/images/ (parent of projects/ and logos/).
function buildManifest({ dbPath, imagesDir, logLimit = 50 }) {
  const files = listFiles(imagesDir);

  let referenced = new Set();
  let recentLog = [];
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      referenced = computeReferencedPaths(db);
      try {
        recentLog = db.prepare('SELECT path, action, ts FROM content_log ORDER BY ts DESC, id DESC LIMIT ?').all(logLimit);
      } catch { /* content_log table doesn't exist yet on this DB — fine */ }
    } finally {
      db.close();
    }
  }

  const orphaned = [];
  const missing  = [];
  for (const f of files.keys()) if (!referenced.has(f)) orphaned.push(f);
  for (const r of referenced) if (!files.has(r)) missing.push(r);

  const filesObj = {};
  for (const [k, v] of files) filesObj[k] = v;

  return {
    generatedAt: new Date().toISOString(),
    files:       filesObj,
    referenced:  [...referenced],
    orphaned,
    missing,
    recentLog,
  };
}

module.exports = { buildManifest, computeReferencedPaths, normalizeRef, listFiles };
