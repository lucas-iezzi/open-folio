'use strict';
require('dotenv').config();

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const session   = require('express-session');
const bcrypt    = require('bcryptjs');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const crypto    = require('crypto');
const os            = require('os');
const { spawnSync, spawn } = require('child_process');
const Database  = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);

// ── Startup validation ────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD_HASH) {
  console.error('\n⚠️  Missing environment variables.');
  console.error('   Run: node scripts/setup.js\n');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const IMAGES_BASE = path.join(__dirname, 'public', 'images', 'projects');
const DB_PATH     = path.join(__dirname, 'data', 'portfolio.db');

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    slug         TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    subtitle     TEXT NOT NULL DEFAULT '',
    pageTitle    TEXT NOT NULL DEFAULT '',
    thumbnail    TEXT NOT NULL DEFAULT '',
    thumbnailAlt TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    sections     TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS visits (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    path     TEXT    NOT NULL,
    type     TEXT    NOT NULL DEFAULT 'page',
    ip_hash  TEXT    NOT NULL DEFAULT '',
    ip       TEXT    NOT NULL DEFAULT '',
    referrer TEXT    NOT NULL DEFAULT '',
    ua       TEXT    NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS visits_ts   ON visits(ts);
  CREATE INDEX IF NOT EXISTS visits_path ON visits(path);

  CREATE TABLE IF NOT EXISTS geo_cache (
    ip      TEXT    PRIMARY KEY,
    country TEXT    NOT NULL DEFAULT '',
    country_code TEXT NOT NULL DEFAULT '',
    city    TEXT    NOT NULL DEFAULT '',
    org     TEXT    NOT NULL DEFAULT '',
    ts      INTEGER NOT NULL DEFAULT 0
  );
`);

// Migrations for existing DBs
{
  const cols = db.pragma('table_info(projects)').map(c => c.name);
  if (!cols.includes('pageTitle')) {
    db.exec(`ALTER TABLE projects ADD COLUMN pageTitle TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.includes('visible')) {
    db.exec(`ALTER TABLE projects ADD COLUMN visible INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.includes('draft_data')) {
    db.exec(`ALTER TABLE projects ADD COLUMN draft_data TEXT`);
  }
}
{
  const vcols = db.pragma('table_info(visits)').map(c => c.name);
  if (!vcols.includes('ip')) {
    db.exec(`ALTER TABLE visits ADD COLUMN ip TEXT NOT NULL DEFAULT ''`);
  }
}

// Sandbox tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sandbox_sessions (
    session_id    TEXT PRIMARY KEY,
    config        TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sandbox_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    config      TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sandbox_redo (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    config     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sandbox_styles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    config     TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);
// Migrate: add reference_html column if missing
{
  const scols = db.pragma('table_info(sandbox_sessions)').map(c => c.name);
  if (!scols.includes('reference_html')) {
    db.exec('ALTER TABLE sandbox_sessions ADD COLUMN reference_html TEXT');
  }
}

// Global key-value settings table (logo paths, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
function getLogos() {
  return {
    logoSmallSrc: getSetting('logo_small') || null,
    logoMarkSrc:  getSetting('logo_mark')  || null,
  };
}

// One-time migration: populate logo settings from files already on disk (pre-upload-UI installs).
// Safe to re-run — skips any slot that already has a DB entry.
(function seedLegacyLogos() {
  const logoDir = path.join(__dirname, 'public', 'images', 'logos');
  if (!fs.existsSync(logoDir)) return;
  if (getSetting('logo_small') && getSetting('logo_mark')) return;

  const files = fs.readdirSync(logoDir)
    .filter(n => /\.(png|jpe?g|gif|webp|svg)$/i.test(n))
    .sort();
  if (files.length === 0) return;

  // Classify by filename keyword; fall back to filesystem order
  const classify = n => {
    const l = n.toLowerCase();
    if (/\b(image|icon|small)\b/.test(l)) return 'small';
    if (/\b(name|mark|word|logotype|wordmark)\b/.test(l)) return 'mark';
    return null;
  };

  let smallFile = null, markFile = null;
  const unclassified = [];
  for (const f of files) {
    const c = classify(f);
    if (c === 'small' && !smallFile) smallFile = f;
    else if (c === 'mark' && !markFile) markFile = f;
    else unclassified.push(f);
  }
  for (const f of unclassified) {
    if (!smallFile) smallFile = f;
    else if (!markFile) markFile = f;
  }

  if (!getSetting('logo_small') && smallFile)
    setSetting('logo_small', '/images/logos/' + smallFile);
  if (!getSetting('logo_mark') && markFile)
    setSetting('logo_mark', '/images/logos/' + markFile);
})();

// Seed site name/tagline from old hardcoded defaults (one-time migration).
if (!getSetting('site_name'))    setSetting('site_name', 'lucas\niezzi');
if (!getSetting('site_tagline')) setSetting('site_tagline', 'I am a creative problem solver crafting products that are engineered for enjoyment');

function rowToProject(row) {
  return {
    slug:         row.slug,
    title:        row.title,
    subtitle:     row.subtitle,
    pageTitle:    row.pageTitle || '',
    thumbnail:    row.thumbnail,
    thumbnailAlt: row.thumbnailAlt,
    order:        row.sort_order,
    visible:      row.visible !== 0,
    sections:     JSON.parse(row.sections || '[]'),
    draft_data:   row.draft_data || null,
  };
}

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      styleSrc:       ["'self'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:", "blob:"],
      scriptSrc:      ["'self'"],
      formAction:     ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
    },
  },
  hsts: IS_PROD ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
}));

// Block directory listing and dotfile access
app.use((req, res, next) => {
  if (/\/\./.test(req.path)) return res.status(404).end();
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Strict limit on login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many attempts. Please wait 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// General limiter for all routes
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const sandboxPromptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many sandbox requests. Please wait a moment.',
});

const matchStyleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many style-match requests. Please wait a moment.',
});

app.use(generalLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));

// ── Sessions ──────────────────────────────────────────────────────────────────
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'sid',
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ── View engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  dotfiles: 'deny',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

// ── CSRF helpers ──────────────────────────────────────────────────────────────
function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const token =
    req.body?._csrf ||
    req.headers['x-csrf-token'];
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }
  next();
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated === true) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  req.session.returnTo = req.originalUrl;
  res.redirect(302, '/admin/login');
}

// ── Data helpers ──────────────────────────────────────────────────────────────
const _selectAll    = db.prepare('SELECT * FROM projects');
const _selectSorted = db.prepare('SELECT * FROM projects ORDER BY sort_order ASC');
const _selectPublic = db.prepare('SELECT * FROM projects WHERE visible = 1 ORDER BY sort_order ASC');
const _deleteAll    = db.prepare('DELETE FROM projects');
const _upsert       = db.prepare(`
  INSERT INTO projects (slug, title, subtitle, pageTitle, thumbnail, thumbnailAlt, sort_order, visible, sections, draft_data)
  VALUES (@slug, @title, @subtitle, @pageTitle, @thumbnail, @thumbnailAlt, @sort_order, @visible, @sections, @draft_data)
  ON CONFLICT(slug) DO UPDATE SET
    title        = excluded.title,
    subtitle     = excluded.subtitle,
    pageTitle    = excluded.pageTitle,
    thumbnail    = excluded.thumbnail,
    thumbnailAlt = excluded.thumbnailAlt,
    sort_order   = excluded.sort_order,
    visible      = excluded.visible,
    sections     = excluded.sections,
    draft_data   = excluded.draft_data
`);

function loadProjects() {
  return _selectAll.all().map(rowToProject);
}

function saveProjects(projects) {
  db.transaction(rows => {
    _deleteAll.run();
    for (const p of rows) {
      _upsert.run({
        slug:         p.slug,
        title:        p.title        || '',
        subtitle:     p.subtitle     || '',
        pageTitle:    p.pageTitle    || '',
        thumbnail:    p.thumbnail    || '',
        thumbnailAlt: p.thumbnailAlt || '',
        sort_order:   p.order        ?? 0,
        visible:      p.visible === false ? 0 : 1,
        sections:     JSON.stringify(p.sections || []),
        draft_data:   typeof p.draft_data === 'string' ? p.draft_data : null,
      });
    }
  })(projects);
}

function sortedProjects() {
  return _selectSorted.all().map(rowToProject);
}

function publicProjects() {
  return _selectPublic.all().map(rowToProject);
}

// ── Visit tracking ────────────────────────────────────────────────────────────
const _insertVisit = db.prepare(`
  INSERT INTO visits (ts, path, type, ip_hash, ip, referrer, ua)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// TODO: consider deduplicating visits so a single visitor navigating across
// multiple pages in a session only counts as one visit, not one per page.
function recordVisit(req, type = 'page') {
  try {
    const ip   = req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '';
    const hash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
    const ref  = (req.headers['referer'] || req.headers['referrer'] || '').slice(0, 200);
    const ua   = (req.headers['user-agent'] || '').slice(0, 200);
    _insertVisit.run(Date.now(), req.path, type, hash, ip, ref, ua);
  } catch { /* never let tracking errors surface to users */ }
}

function getActivityStats() {
  const now    = Date.now();
  const DAY    = 86400000;
  const WEEK   = 7  * DAY;
  const MONTH  = 30 * DAY;

  const countSince = db.prepare('SELECT COUNT(*) as n FROM visits WHERE ts >= ?');

  const topPages = db.prepare(`
    SELECT path, COUNT(*) as views
    FROM visits WHERE type = 'page'
    GROUP BY path ORDER BY views DESC LIMIT 20
  `).all();

  const topApi = db.prepare(`
    SELECT path, COUNT(*) as views
    FROM visits WHERE type = 'api'
    GROUP BY path ORDER BY views DESC LIMIT 10
  `).all();

  const recent = db.prepare(`
    SELECT ts, path, type, ip, referrer, ua
    FROM visits ORDER BY ts DESC LIMIT 100
  `).all();

  return {
    totals: {
      today: countSince.get(now - DAY).n,
      week:  countSince.get(now - WEEK).n,
      month: countSince.get(now - MONTH).n,
      all:   countSince.get(0).n,
    },
    topPages,
    topApi,
    recent,
  };
}

// Sanitize a slug: lowercase alphanumeric + hyphens only, no leading/trailing hyphens
function sanitizeSlug(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Safe path inside images/projects directory (prevents traversal)
function safeImageDir(slug) {
  const safeSlug = sanitizeSlug(slug);
  if (!safeSlug) throw new Error('Invalid slug');
  const dir = path.resolve(IMAGES_BASE, safeSlug);
  if (!dir.startsWith(IMAGES_BASE + path.sep)) {
    throw new Error('Invalid slug');
  }
  return { dir, safeSlug };
}

// ── File upload ───────────────────────────────────────────────────────────────
const ALLOWED_MIME     = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_FILE_BYTES   = 20 * 1024 * 1024; // 20 MB
const STUDIO_TEMP_BASE = path.join(__dirname, 'public', 'images', 'studio-temp');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const { dir } = safeImageDir(req.params.slug || 'temp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Only JPEG, PNG, GIF and WebP images are allowed.'), { status: 400 }));
  },
});

// Studio upload — images land in studio-temp/<tempId>/; max 3.5MB per image
const studioStorage = multer.diskStorage({
  destination(req, file, cb) {
    const tempId = req.session.studio?.tempId;
    if (!tempId || !/^[a-f0-9-]{36}$/.test(tempId)) return cb(new Error('No studio session'));
    const dir = path.join(STUDIO_TEMP_BASE, tempId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const STUDIO_IMAGE_MIMES = new Set(['image/jpeg','image/png','image/gif','image/webp']);
const STUDIO_TEXT_MIMES  = new Set(['text/plain','text/markdown','text/x-markdown','text/csv','application/json']);

const studioUpload = multer({
  storage: studioStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (STUDIO_IMAGE_MIMES.has(file.mimetype) || STUDIO_TEXT_MIMES.has(file.mimetype) || file.mimetype.startsWith('text/')) {
      return cb(null, true);
    }
    cb(Object.assign(new Error('Unsupported file type. Upload images or text files (.txt, .md, .csv, .json).'), { status: 415 }));
  },
});

// Logo upload — stores files on disk in public/images/logos/
const LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'image/gif']);
const logoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(__dirname, 'public', 'images', 'logos');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, crypto.randomBytes(10).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) { cb(null, LOGO_MIMES.has(file.mimetype)); },
});

// Import Style upload — stores files in memory, max 10 MB each
const IMPORT_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const importStyleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.fieldname === 'imageFile') return cb(null, IMPORT_IMAGE_MIMES.has(file.mimetype));
    if (file.fieldname === 'htmlFile') {
      const ok = /\.(html?|css)$/i.test(file.originalname) || file.mimetype.startsWith('text/');
      return cb(null, !!ok);
    }
    cb(null, false);
  },
});

// ── LLM helpers ───────────────────────────────────────────────────────────────
const PROJECT_SCHEMA = `{
  "slug": "kebab-case-url-slug (2-5 words)",
  "title": "Short card label for the homepage grid (2-5 words)",
  "pageTitle": "Full H1 heading on the project page",
  "subtitle": "One compelling sentence below the title",
  "thumbnail": "exact filename of the best hero image (e.g. photo.jpg), or empty string",
  "thumbnailAlt": "descriptive alt text for the thumbnail",
  "sections": [
    {
      "heading": "Section heading",
      "body": "Section body text. Use \\n for paragraph breaks.",
      "images": [{ "src": "exact filename", "alt": "descriptive alt text" }]
    }
  ]
}`;

const STUDIO_SYSTEM_PROMPT = `You are an AI assistant helping create portfolio project pages for Lucas Iezzi, a product designer and engineer.

Given a project description and uploaded files, generate a structured project page.

Return ONLY valid JSON — no markdown fences, no explanation. The response must be directly parseable by JSON.parse().

Return this exact shape:
{
  "project": ${PROJECT_SCHEMA},
  "summary": "1-2 sentence overview of what you created: how many sections, what they cover, which images you placed where."
}

Rules:
- Return ONLY the JSON — nothing else
- image src values: use ONLY the exact filename (e.g. "abc123.jpg") — never a full path
- Only reference filenames explicitly listed in the prompt
- Organise into 3-6 sections with a clear narrative arc (Overview → Process → Results)
- Write in a professional, engaging portfolio voice
- Keep the project concise: each section body should be a single short paragraph (2-4 sentences). Focus on what was done and why it matters — not granular technical details or step-by-step breakdowns
- thumbnail: most visually striking image, ideally a hero shot; empty string if none
- Do not invent technical details not present in the description`;

const STUDIO_REFINE_PROMPT = `You are an AI assistant helping refine a portfolio project page for Lucas Iezzi.

You are in an ongoing conversation. The user will send feedback, questions, or requests about the current project page.

Decide whether the feedback requires regenerating the page JSON, or whether you can respond conversationally.

Return ONLY valid JSON — no markdown fences, no explanation.

If you can respond without changing the page (questions, clarifications, general feedback):
{"message": "Your conversational response.", "regenerate": false}

If the feedback requires changes to the page content, structure, text, or image placement:
{"message": "Brief natural-language summary of what you changed.", "regenerate": true, "project": ${PROJECT_SCHEMA}}

When regenerating:
- image src values: use ONLY the exact filename — never a full path
- Only reference filenames that were provided in the original prompt
- Preserve all sections not mentioned in the feedback
- Follow the same schema rules as the initial generation
- Keep all section bodies concise: one short paragraph (2-4 sentences) per section — focus on what was done and why it matters, not granular technical details

Decide to regenerate when the user: asks to change text, move/add/remove sections or images, update title/subtitle/slug, or makes any structural request.
Decide NOT to regenerate when the user: asks a question about the current page, gives general positive feedback, or says something unrelated to page changes.`;

// ── AI provider registry ──────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: {
    name:    'Anthropic (Claude)',
    keyEnv:  'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-…',
    models: {
      fast:    { id: 'claude-haiku-4-5-20251001', label: 'Haiku — fast'      },
      smart:   { id: 'claude-sonnet-4-6',         label: 'Sonnet — balanced' },
      quality: { id: 'claude-opus-4-8',            label: 'Opus — quality'   },
    },
  },
  openai: {
    name:    'OpenAI (ChatGPT)',
    keyEnv:  'OPENAI_API_KEY',
    keyHint: 'sk-…',
    models: {
      fast:    { id: 'gpt-4o-mini', label: 'GPT-4o mini — fast'    },
      smart:   { id: 'gpt-4o',     label: 'GPT-4o — balanced'     },
      quality: { id: 'gpt-4o',     label: 'GPT-4o — quality'      },
    },
  },
  gemini: {
    name:    'Google Gemini',
    keyEnv:  'GEMINI_API_KEY',
    keyHint: 'AIza…',
    models: {
      fast:    { id: 'gemini-2.0-flash', label: 'Flash 2.0 — fast'    },
      smart:   { id: 'gemini-1.5-pro',   label: 'Pro 1.5 — balanced' },
      quality: { id: 'gemini-1.5-pro',   label: 'Pro 1.5 — quality'  },
    },
  },
};

function getActiveProvider() {
  const p = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  return PROVIDERS[p] ? p : 'anthropic';
}

function getModelId(tier = 'fast', providerKey = null) {
  const p = providerKey || getActiveProvider();
  return PROVIDERS[p]?.models[tier]?.id || PROVIDERS[p]?.models.fast.id;
}

function hasActiveKey() {
  return !!process.env[PROVIDERS[getActiveProvider()].keyEnv];
}

// callAI — convenience wrapper for non-Studio AI calls; uses active provider + tier
async function callAI({ messages, systemPrompt = '', tier = 'fast' }) {
  const p = getActiveProvider();
  return callLLM({ provider: p, model: getModelId(tier, p), messages, systemPrompt });
}

async function callLLM({ provider, model, messages, systemPrompt = STUDIO_SYSTEM_PROMPT }) {
  const p = provider || getActiveProvider();

  if (p === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({ model, max_tokens: 4096, system: systemPrompt, messages });
    return response.content[0].text;
  }

  if (p === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in .env');
    const oaMsgs = [];
    if (systemPrompt) oaMsgs.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      if (typeof m.content === 'string') {
        oaMsgs.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        oaMsgs.push({
          role: m.role,
          content: m.content.map(b => {
            if (b.type === 'text')  return { type: 'text', text: b.text };
            if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
            return { type: 'text', text: JSON.stringify(b) };
          }),
        });
      }
    }
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4096, messages: oaMsgs }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI API error ${resp.status}`);
    }
    const data = await resp.json();
    return data.choices[0].message.content;
  }

  if (p === 'gemini') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in .env');
    const contents = messages.map(m => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
      return {
        role,
        parts: m.content.map(b => {
          if (b.type === 'text')  return { text: b.text };
          if (b.type === 'image') return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
          return { text: JSON.stringify(b) };
        }),
      };
    });
    const body = { contents };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Gemini API error ${resp.status}`);
    }
    const data = await resp.json();
    return data.candidates[0].content.parts[0].text;
  }

  throw new Error(`Unknown AI provider: "${p}"`);
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('LLM did not return valid JSON. Try again or rephrase your description.');
  }
}

// ── UI Sandbox ────────────────────────────────────────────────────────────────

const SANDBOX_SYSTEM_PROMPT = `You are a visual design assistant for a portfolio website sandbox. Given a user's request, return ONLY a valid JSON object — no prose, no markdown, no code fences:

{
  "ops": [array of mutation operations],
  "applied": ["short description of each change applied"],
  "explanation": null
}

If the request cannot be fulfilled, set explanation to a one-sentence message and return ops: [].

━━━ PRIMARY TOOL: customCSS ━━━
Path "customCSS" accepts a raw CSS string injected into the preview at high priority. Use it for ANY visual or style change — fonts, colors, spacing, layout tweaks, animations.

IMPORTANT: When setting customCSS, include ALL existing customCSS from the current config PLUS your new rules (to preserve previous changes). Combine everything into one value.

CSS selectors for this portfolio:
  body                    — page background and base text color/font
  .site-name              — the name in the hero (default: "lucas iezzi")
  .hero-text              — tagline paragraph under the name
  .hero-text .highlight   — highlighted word within the tagline
  .hero                   — hero section wrapper
  .container              — content container (7% horizontal padding)
  nav, .site-nav          — navigation bar
  .nav-links-desktop a    — nav link items
  .project-grid           — CSS grid of project cards
  .project-card           — individual project card (anchor element)
  .project-card-image     — card image container div
  .project-card-image img — card image element
  .project-card-title     — title text below each card
  footer                  — page footer
  .nav-logo-small         — small logo slot in nav
  .nav-logo-mark          — logomark slot in nav
  .hero-logo-small        — small logo slot in hero
  .hero-logo-mark         — logomark slot in hero

Example — change the tagline to a serif font at 1.2rem:
  { "op": "set", "path": "customCSS", "value": ".hero-text { font-family: Georgia, serif; font-size: 1.2rem; }" }

Always combine ALL CSS changes into a SINGLE customCSS op. Never split CSS across multiple ops.
Do NOT wrap CSS in <style> tags — raw CSS rules only.

━━━ TEXT CONTENT OVERRIDES ━━━
  text.heroTagline  — overrides the tagline paragraph text (max 500 chars)
                      Default: "I am a creative problem solver crafting products that are engineered for enjoyment"
  text.heroName     — overrides the name displayed in the hero; use \\n for a line break (max 100 chars)
                      Default: "lucas\\niezzi"

━━━ LAYOUT SHORTCUTS ━━━
Color tokens (hex strings):
  tokens.background, tokens.text, tokens.accent, tokens.surface

nav.visible (boolean), hero.visible (boolean)
hero.layout ("left"|"center"|"right"), hero.nameSize ("small"|"medium"|"large"|"huge")

━━━ LOGO CONTROLS ━━━
Logo images are uploaded in Admin → Settings. These ops control their visibility and placement:
  logo.showSmall (boolean)  — show the small logo (icon-sized)
  logo.smallPos ("nav"|"hero") — where to place the small logo
  logo.showMark (boolean)   — show the logomark (larger brand mark)
  logo.markPos ("nav"|"hero") — where to place the logomark
Default: both logos hidden. To show the logomark centered above the hero name: set logo.showMark=true, logo.markPos="hero".
To show the small logo in the nav: set logo.showSmall=true, logo.smallPos="nav".

projects.layout.type ("grid"|"horizontal-scroll"|"vertical-scroll"|"full-screen")
projects.layout.columns (1-6, grid only), projects.layout.gap (0-64 px), projects.layout.scrollSnap (boolean)

projects.item.showTitle (boolean), projects.item.titlePosition ("below"|"overlay")
projects.item.titleOnHover (boolean), projects.item.showDescription (boolean)
projects.item.imageFilter ("none"|"grayscale"|"sepia"|"blur")
projects.item.imageFilterOnHover ("none"|"grayscale"|"sepia"|"blur"|"color")
projects.item.borderRadius (0-32), projects.item.shadow (boolean)
projects.item.aspectRatio ("auto"|"1/1"|"4/3"|"16/9"|"3/2")

━━━ PER-PAGE CSS (project pages only) ━━━
Path "pageCSS.<slug>" sets CSS that ONLY applies to one specific project page (not the homepage, not other projects). <slug> is the URL slug of the project (e.g. "pageCSS.golf-ball-picker").

The user message includes "Current page: ..." telling you where the user is:
  • "Current page: homepage" → you are editing the homepage
  • "Current page: project:golf-ball-picker" → you are editing project page "golf-ball-picker"

When on a PROJECT PAGE and the user wants a change ONLY FOR THAT PAGE: use "pageCSS.<slug>".
When on a PROJECT PAGE and the user wants a SITE-WIDE change: use "customCSS" or tokens.*.
When on the HOMEPAGE: always use "customCSS" or tokens.* (no pageCSS needed).

Important: When setting pageCSS.<slug>, include ALL existing pageCSS[slug] content PLUS new rules (same as customCSS — preserve existing to avoid wiping prior changes).

CSS classes on project pages:
  .project-title           — H1 title at top of project page
  .project-subtitle        — subtitle paragraph below title
  .project-header          — wrapper around title + subtitle
  .project-section         — each content section
  .project-section__heading — section headings (H2)
  .project-section__body   — section body text
  .project-section-images  — image row container within a section

━━━ RULES ━━━
1. Use customCSS for any site-wide font, spacing, color, or style change.
2. Use pageCSS.<slug> for changes the user wants only on the current project page.
3. For site-wide color changes (dark mode, etc.), set tokens.* AND use customCSS for elements tokens don't cover.
4. To change text CONTENT (not style): use text.heroTagline or text.heroName (homepage only).
5. Impossible requests (adding new pages, new sections, changing project images/data): set explanation and return ops: [].
6. Always populate applied[] with brief descriptions of what changed.`;

const SANDBOX_DEFAULT_CONFIG = {
  version: 1,
  tokens: { background: '#ffffff', text: '#1a1b1f', accent: '#1a1b1f', surface: '#f5f5f5' },
  nav:     { visible: true },
  hero:    { visible: true, layout: 'left', nameSize: 'large' },
  logo:    { showSmall: false, smallPos: 'nav', showMark: false, markPos: 'hero' },
  projects: {
    layout: { type: 'grid', columns: 4, gap: 16, scrollSnap: false },
    item: {
      showTitle: true, titlePosition: 'below', titleOnHover: false,
      showDescription: false,
      imageFilter: 'none', imageFilterOnHover: 'none',
      borderRadius: 0, shadow: false, aspectRatio: '3/2',
    },
  },
  text: { heroTagline: '', heroName: '' },
  customCSS: '',
  pageCSS: {},
};

const SANDBOX_ALLOWED_PATHS = {
  'tokens.background':               { type: 'color' },
  'tokens.text':                     { type: 'color' },
  'tokens.accent':                   { type: 'color' },
  'tokens.surface':                  { type: 'color' },
  'nav.visible':                     { type: 'boolean' },
  'hero.visible':                    { type: 'boolean' },
  'hero.layout':                     { type: 'enum', values: ['left', 'center', 'right'] },
  'hero.nameSize':                   { type: 'enum', values: ['small', 'medium', 'large', 'huge'] },
  'projects.layout.type':            { type: 'enum', values: ['grid', 'horizontal-scroll', 'vertical-scroll', 'full-screen'] },
  'projects.layout.columns':         { type: 'integer', min: 1, max: 6 },
  'projects.layout.gap':             { type: 'integer', min: 0, max: 64 },
  'projects.layout.scrollSnap':      { type: 'boolean' },
  'projects.item.showTitle':         { type: 'boolean' },
  'projects.item.titlePosition':     { type: 'enum', values: ['below', 'overlay'] },
  'projects.item.titleOnHover':      { type: 'boolean' },
  'projects.item.showDescription':   { type: 'boolean' },
  'projects.item.imageFilter':       { type: 'enum', values: ['none', 'grayscale', 'sepia', 'blur'] },
  'projects.item.imageFilterOnHover':{ type: 'enum', values: ['none', 'grayscale', 'sepia', 'blur', 'color'] },
  'projects.item.borderRadius':      { type: 'integer', min: 0, max: 32 },
  'projects.item.shadow':            { type: 'boolean' },
  'projects.item.aspectRatio':       { type: 'enum', values: ['auto', '1/1', '4/3', '16/9', '3/2'] },
  'customCSS':                       { type: 'css-string', maxLength: 20000 },
  'text.heroTagline':                { type: 'text-string', maxLength: 500 },
  'text.heroName':                   { type: 'text-string', maxLength: 100 },
  'logo.showSmall':                  { type: 'boolean' },
  'logo.smallPos':                   { type: 'enum', values: ['nav', 'hero'] },
  'logo.showMark':                   { type: 'boolean' },
  'logo.markPos':                    { type: 'enum', values: ['nav', 'hero'] },
};

function validateSandboxOp(op) {
  if (!op || op.op !== 'set' || typeof op.path !== 'string') return false;

  // Dynamic per-page CSS: pageCSS.<slug> where slug is a-z0-9-
  if (/^pageCSS\.[a-z0-9-]{1,80}$/.test(op.path)) {
    return typeof op.value === 'string' && op.value.length <= 20000;
  }

  const rule = SANDBOX_ALLOWED_PATHS[op.path];
  if (!rule) return false;
  const v = op.value;
  if (rule.type === 'color')       return typeof v === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(v);
  if (rule.type === 'boolean')     return typeof v === 'boolean';
  if (rule.type === 'enum')        return rule.values.includes(v);
  if (rule.type === 'integer')     return Number.isInteger(v) && v >= rule.min && v <= rule.max;
  if (rule.type === 'css-string')  return typeof v === 'string' && v.length <= (rule.maxLength || 20000);
  if (rule.type === 'text-string') return typeof v === 'string' && v.length <= (rule.maxLength || 500);
  return false;
}

function applySandboxOp(config, op) {
  const parts = op.path.split('.');
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = op.value;
}

function getSandboxSession(sid) {
  const row = db.prepare('SELECT config FROM sandbox_sessions WHERE session_id = ?').get(sid);
  if (!row) {
    const def = JSON.stringify(SANDBOX_DEFAULT_CONFIG);
    db.prepare('INSERT INTO sandbox_sessions (session_id, config) VALUES (?, ?)').run(sid, def);
    return def;
  }
  return row.config;
}

function sandboxUndoCount(sid) {
  return db.prepare('SELECT COUNT(*) as c FROM sandbox_revisions WHERE session_id = ?').get(sid)?.c || 0;
}
function sandboxRedoCount(sid) {
  return db.prepare('SELECT COUNT(*) as c FROM sandbox_redo WHERE session_id = ?').get(sid)?.c || 0;
}

// Translate sandbox config into CSS overrides. Pass slug for project-page-specific CSS.
function buildSandboxPreviewCSS(config, slug) {
  const lines = [];
  const t      = config.tokens;
  const layout = config.projects.layout;
  const item   = config.projects.item;

  // Color tokens
  lines.push(`body { background-color: ${t.background}; color: ${t.text}; }`);
  lines.push(`.site-name { color: ${t.text}; }`);  // overrides hardcoded #4b4e58

  // Nav
  if (!config.nav.visible) {
    lines.push(`.site-nav, #nav-menu { display: none !important; }`);
  }

  // Hero
  if (!config.hero.visible) {
    lines.push(`.hero { display: none !important; }`);
  } else {
    if (config.hero.layout === 'center') lines.push(`.hero { text-align: center; }`);
    else if (config.hero.layout === 'right') lines.push(`.hero { text-align: right; }`);
    const nameSize = { small: '1.4rem', medium: '2rem', large: '2.5rem', huge: '4.5rem' };
    lines.push(`.site-name { font-size: ${nameSize[config.hero.nameSize] || '2.5rem'} !important; }`);
  }

  // Project grid layout
  if (layout.type === 'grid') {
    lines.push(`.project-grid { grid-template-columns: repeat(${layout.columns || 4}, 1fr); gap: ${layout.gap || 16}px; }`);
  } else if (layout.type === 'horizontal-scroll') {
    const snap = layout.scrollSnap ? 'scroll-snap-type: x mandatory;' : '';
    const snapItem = layout.scrollSnap ? 'scroll-snap-align: start;' : '';
    lines.push(`.project-grid { display: flex; flex-direction: row; overflow-x: auto; overflow-y: hidden; gap: ${layout.gap || 16}px; width: 100vw; position: relative; left: 50%; margin-left: -50vw; padding: 16px 7%; box-sizing: border-box; ${snap} }`);
    lines.push(`.project-grid article { flex-shrink: 0; width: clamp(240px, 30vw, 420px); ${snapItem} }`);
  } else if (layout.type === 'vertical-scroll') {
    lines.push(`.project-grid { display: flex; flex-direction: column; gap: ${layout.gap || 16}px; }`);
    lines.push(`.project-grid article { width: 100%; }`);
  } else if (layout.type === 'full-screen') {
    const snap = layout.scrollSnap ? 'scroll-snap-type: x mandatory;' : '';
    const snapItem = layout.scrollSnap ? 'scroll-snap-align: start;' : '';
    lines.push(`.project-grid { display: flex; flex-direction: row; overflow-x: auto; overflow-y: hidden; gap: 0; padding: 0; width: 100vw; position: relative; left: 50%; margin-left: -50vw; height: 100vh; ${snap} }`);
    lines.push(`.project-grid article { flex-shrink: 0; width: 100vw; height: 100%; ${snapItem} }`);
    lines.push(`.project-grid .project-card { display: block; width: 100%; height: 100%; position: relative; }`);
    lines.push(`.project-grid .project-card-image { width: 100%; height: 100%; aspect-ratio: unset; border-radius: 0 !important; margin-bottom: 0; }`);
    lines.push(`.project-grid .project-card-image img { width: 100%; height: 100%; object-fit: cover; }`);
    lines.push(`.project-grid .project-card-title { position: absolute; bottom: 0; left: 0; right: 0; margin: 0; padding: 32px 20px 16px; background: linear-gradient(transparent, rgba(0,0,0,0.6)); color: #fff !important; text-align: left; font-size: 1.25rem; }`);
  }

  // Item styles (skip overrides that full-screen already hardcodes)
  if (layout.type !== 'full-screen') {
    if (item.borderRadius !== undefined) lines.push(`.project-card-image { border-radius: ${item.borderRadius}px; }`);
    if (item.aspectRatio && item.aspectRatio !== 'auto') lines.push(`.project-card-image { aspect-ratio: ${item.aspectRatio}; }`);
  }
  if (item.shadow) lines.push(`.project-card-image { box-shadow: 0 4px 20px rgba(0,0,0,0.15); }`);
  if (!item.showTitle) lines.push(`.project-card-title { display: none !important; }`);

  if (item.titlePosition === 'overlay' && layout.type !== 'full-screen') {
    lines.push(`.project-card-image { position: relative; overflow: hidden; }`);
    lines.push(`.project-card-title { position: absolute; bottom: 0; left: 0; right: 0; margin: 0; padding: 32px 20px 16px; background: linear-gradient(transparent, rgba(0,0,0,0.6)); color: #fff !important; text-align: left; font-size: 0.875rem; font-weight: 500; }`);
    if (item.titleOnHover) {
      lines.push(`.project-card-title { opacity: 0; transition: opacity 0.25s; }`);
      lines.push(`.project-card:hover .project-card-title { opacity: 1; }`);
    }
  } else if (item.titleOnHover && layout.type !== 'full-screen') {
    lines.push(`.project-card-title { opacity: 0; transition: opacity 0.25s; }`);
    lines.push(`.project-card:hover .project-card-title { opacity: 1; }`);
  }

  // Image filters
  const filterMap = { grayscale: 'grayscale(100%)', sepia: 'sepia(100%)', blur: 'blur(5px)', none: '' };
  const baseFilter  = filterMap[item.imageFilter] || '';
  const hoverFilter = item.imageFilterOnHover === 'color' ? '' : (filterMap[item.imageFilterOnHover] || '');
  if (baseFilter) lines.push(`.project-card-image img { filter: ${baseFilter}; transition: filter 0.3s ease; }`);
  if (item.imageFilterOnHover && item.imageFilterOnHover !== 'none' && item.imageFilterOnHover !== item.imageFilter) {
    lines.push(`.project-card:hover .project-card-image img { filter: ${hoverFilter}; }`);
  }

  // Logo visibility — controlled by sandbox; elements are hidden by default in style.css
  const logo = config.logo || {};
  if (logo.showSmall) {
    const pos = logo.smallPos === 'hero' ? 'hero' : 'nav';
    lines.push(`.${pos}-logo-small { display: flex !important; }`);
  }
  if (logo.showMark) {
    const pos = logo.markPos === 'nav' ? 'nav' : 'hero';
    lines.push(`.${pos}-logo-mark { display: flex !important; }`);
  }

  // Global raw CSS (appended last so it wins specificity battles)
  if (config.customCSS) lines.push(config.customCSS);

  // Per-page CSS — only injected when rendering the matching project page
  if (slug && config.pageCSS && config.pageCSS[slug]) lines.push(config.pageCSS[slug]);

  return lines.join('\n');
}

// ── Match-Style helpers ───────────────────────────────────────────────────────

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^0\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;   // IPv6 link-local
  if (/^fc00:/i.test(h) || /^fd/i.test(h)) return true; // IPv6 unique local
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  return false;
}

function extractInlineCss(html) {
  const parts = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) parts.push(m[1]);
  return parts.join('\n');
}

function extractCssLinkHrefs(html, baseUrl) {
  const hrefs = [];
  const re = /<link[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel=["']?stylesheet["']?/i.test(tag)) continue;
    const hm = tag.match(/href=["']([^"']+)["']/i);
    if (!hm) continue;
    try { hrefs.push(new URL(hm[1], baseUrl).href); } catch {}
  }
  return hrefs;
}

const MATCH_STYLE_SYSTEM_PROMPT = `You are a design translator. Analyze one or more design references — which may include a reference image (screenshot, Figma export, or any design visual), CSS/HTML from a website URL, and/or CSS from an uploaded HTML or CSS file — and produce a portfolio configuration that captures the overall visual style. Respond with ONLY valid JSON — no markdown, no prose, no code fences.

When given an image: extract the visual style from what you see — color palette, typography character, spacing density, card shapes, shadows, and overall aesthetic feel.
When given CSS/HTML: extract precise color, font, and layout values.
When given both: CSS values take precedence for exact colors and measurements; the image provides overall context and fills gaps.

Portfolio CSS structure you are targeting:

CSS VARIABLES (override with :root { } in customCSS):
  --color-bg:      page/body background (default #ffffff)
  --color-text:    main text color (default #1a1b1f)
  --color-accent:  accent/link color (default #1a1b1f)
  --color-surface: card/panel background (default #f5f5f5)
  --d-name-size:   hero name font-size (default 40px)
  --d-name-weight: hero name font-weight (default 500)
  --d-bio-size:    tagline font-size (default 24px)
  --d-bio-lh:      tagline line-height (default 1.333)
  --d-card-size:   card label font-size (default 19.2px)
  --d-hero-top:    space above hero (default 20px)
  --d-hero-bot:    space below tagline (default 40px)
  --d-section-gap: space between sections (default 48px)

KEY SELECTORS:
  body                    — page background, font-family, base color
  .site-name              — hero name h1 (Montserrat, 40px, 500)
  .hero-text              — tagline paragraph (Montserrat, 24px, 400)
  .hero-text .highlight   — highlighted word span inside tagline
  .hero                   — hero section wrapper
  .container              — content wrapper (7% horizontal padding)
  nav, .site-nav          — top navigation bar
  .nav-links-desktop a    — nav link anchors
  .project-grid           — CSS grid of project cards
  .project-card           — individual card anchor element
  .project-card-image     — card image container div
  .project-card-image img — card image element
  .project-card-title     — text label below each card
  footer                  — page footer

DESIGN TOKEN OPS (4 color tokens, always include all 4):
  { "op": "set", "path": "tokens.background", "value": "#xxxxxx" }
  { "op": "set", "path": "tokens.text",       "value": "#xxxxxx" }
  { "op": "set", "path": "tokens.accent",     "value": "#xxxxxx" }
  { "op": "set", "path": "tokens.surface",    "value": "#xxxxxx" }

CUSTOM CSS OP:
  { "op": "set", "path": "customCSS", "value": "/* raw CSS */" }

Use customCSS for everything beyond the 4 color tokens:
  • @import url("...") web fonts — if the reference uses a Google Font or CDN font, import it
  • font-family overrides on body, .site-name, .hero-text, nav
  • :root overrides for --d-name-size, --d-bio-size, etc.
  • border-radius, box-shadow, hover effects on .project-card-image
  • nav styling (background, border, padding)
  • Letter-spacing, text-transform, font-weight adjustments
  • Any other visual detail from the reference

FONT RULE: If the reference uses a recognizable Google Font (Inter, Lato, Poppins, DM Sans, Playfair Display, etc.), add @import url("https://fonts.googleapis.com/css2?family=...") and override font-family on body. The portfolio currently uses Montserrat — match the reference's typographic character.

RESPONSE FORMAT:
{
  "ops": [
    { "op": "set", "path": "tokens.background", "value": "#..." },
    { "op": "set", "path": "tokens.text",       "value": "#..." },
    { "op": "set", "path": "tokens.accent",     "value": "#..." },
    { "op": "set", "path": "tokens.surface",    "value": "#..." },
    { "op": "set", "path": "customCSS",         "value": "/* comprehensive CSS */" }
  ],
  "applied": ["2-4 brief descriptions of what changed"],
  "explanation": null
}

RULES:
1. Always include all 4 color token ops — extract the dominant palette from the CSS, HTML, and/or image
2. Always include a customCSS op — make it comprehensive to match the reference's character
3. customCSS must be under 15000 characters; strip base64 data URIs if found
4. Target only the selectors listed above
5. Set explanation to null on success; only use it if you have no usable design information in any of the provided inputs`;

const VERIFY_STYLE_SYSTEM_PROMPT = `You are a design verification assistant. A portfolio style was just imported from a reference design. Your job is to check whether the applied color tokens accurately match the reference and make corrections if needed.

Focus only on the 4 color tokens — do not change customCSS or layout settings:
  tokens.background — page/body background
  tokens.text       — main text color
  tokens.accent     — accent, links, or primary brand color
  tokens.surface    — card/panel background color

Compare the applied tokens against the reference (image and/or CSS). If any colors are visually wrong or inaccurate, return corrected ops. If the colors are accurate, return an empty ops array.

Respond with ONLY valid JSON:
{
  "ops": [{ "op": "set", "path": "tokens.X", "value": "#xxxxxx" }],
  "applied": ["brief description of corrections, or empty array if none needed"],
  "explanation": null
}`;

const DEPLOY_ASSISTANT_PROMPT = `You are a friendly, patient deployment assistant for an open-source Node.js portfolio website called open-folio. Help users — including those with no server experience — get their portfolio live on the internet and keep it running smoothly.

PORTFOLIO TECH STACK:
- Node.js 18+ Express server (entry point: server.js)
- SQLite database at data/portfolio.db
- Project images at public/images/projects/, logos at public/images/logos/
- Configuration in .env file (generated by: node launcher.js on the local machine)
- Dependencies installed with: npm install
- PM2 ecosystem config: scripts/ecosystem.config.js

RECOMMENDED SELF-HOSTING STACK (~$4-7/month):
- Server: VPS running Ubuntu 22.04 LTS (Hetzner Cloud, DigitalOcean, Vultr)
- Process manager: PM2 - keeps site running, restarts on crash/reboot
- Reverse proxy + HTTPS: Caddy - automatic SSL certificates, simple config
- Domain: any registrar (Namecheap, Cloudflare, Google Domains)

REMOTE SERVER TAB (this admin panel):
The "Remote Server" tab in the admin panel (only visible when running locally) provides built-in tools to manage the live server - no terminal required for most tasks:
- Server Credentials: save host/user/SSH port/remote path, test the SSH connection
- Server Setup: step-by-step buttons to update packages, install Node.js, PM2, clone the repo, install deps, start with PM2 - each button runs that command over SSH and shows the output
- Content Sync: Push (local to server), Pull (server to local), Compare (diff without changes), Backup (download everything from server)
- Server Commands: Restart site, View logs, Check status, Pull code updates (git pull + npm install + restart)
- SSH Key Setup: instructions for adding your local SSH key to the server (required for passwordless connections)
- AI Assistant: this chat - ask anything about server setup, troubleshooting, provider-specific differences, etc.

The Remote Server tab connects to the live server using SSH and rsync via the local machine's built-in ssh/rsync commands. It requires SSH key authentication (no password prompts). The SSH key setup instructions are in the "Server Credentials" card.

MANAGE.JS (server-side tool):
manage.js is a server management CLI to run on the live server via SSH (or the server provider's web console):
  node manage.js
It can change admin password, rotate session secret, rotate API key, change port, configure AI provider, and show the .env contents. Changes take effect after: pm2 restart open-folio

LAUNCHER (local machine):
launcher.js is the local setup and control tool. Its main purpose is:
  [1] Start/restart the local server
  [2] Configure AI provider & API key
  [3] Change admin password
  [4] Change port
  [5] Re-run full setup
The launcher no longer has a deploy/server tab - all remote server management is done from the "Remote Server" tab in the admin panel.

KEY SETUP COMMANDS (Ubuntu server - manual if needed):
  # Install Node.js 22:
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # Install PM2:
  sudo npm install -g pm2

  # Clone and install:
  git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git ~/open-folio
  cd ~/open-folio && npm install

  # First-time setup on server (interactive - sets admin password, etc.):
  node manage.js

  # Start with PM2:
  pm2 start scripts/ecosystem.config.js --env production
  pm2 save && pm2 startup

CADDY CONFIG (/etc/caddy/Caddyfile on the server):
  your-domain.com {
    reverse_proxy localhost:3000
  }
  sudo systemctl restart caddy

DNS SETUP (in your domain registrar):
  A record: @ -> YOUR_SERVER_IP
  A record: www -> YOUR_SERVER_IP (optional)
  Wait 5-15 minutes for propagation.

PROVIDER-SPECIFIC NOTES:
- Hetzner Cloud: firewall rules must be configured in their web console; allow ports 22, 80, 443
- DigitalOcean: Droplets have ufw disabled by default; enable with: sudo ufw allow 22,80,443/tcp && sudo ufw enable
- Vultr: similar to DigitalOcean; check their firewall settings in the control panel
- Some providers (AWS, GCP) use non-standard SSH key formats or different default usernames (ubuntu, ec2-user, etc.)
- Hetzner and DigitalOcean let you add SSH keys during server creation - easiest approach

COMMON ISSUES:
- "Permission denied (publickey)" on SSH: the SSH key was not added to the server; use SSH Key Setup in the Credentials card, or add it via the provider's web console
- Site won't start: run node manage.js on the server to verify .env exists; check PM2 logs with: pm2 logs open-folio --lines 50
- Can't reach site in browser: open firewall (sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable); also check Caddy is running
- HTTPS not working: wait a few minutes; verify DNS A record points to the correct IP; check "sudo systemctl status caddy"
- Port conflict on server: sudo lsof -i :3000 (or ss -tlnp | grep 3000)
- "rsync not found" on Windows: use Git Bash (bundled with Git for Windows) - the Remote Server tab calls rsync directly, so Git Bash's rsync must be in the PATH

Be concise, encouraging, and give exact copy-paste commands. Break complex steps into numbered sub-steps. When a user's server provider works differently from the standard setup, explain the provider-specific differences clearly.

SSH COMMAND TOOL:
You can run commands directly on the user's server to help diagnose problems. When you want to run a command, include this marker anywhere in your response (on its own line):
[SSH_CMD: <command>]
The user will be shown the command and asked to confirm before it runs. You will automatically receive the output. Use this for diagnosis — prefer read-only commands (pm2 status, cat, ls, systemctl status, journalctl, df, free, etc.) unless a fix genuinely requires writing. Only request one command per message. Do not request a command unless it will meaningfully help diagnose or fix the user's issue.`;

// ── Build the first user message for the LLM — images as base64, text files as content blocks.
// Images are resized to ≤1568px before encoding (Anthropic's recommended max; saves tokens).
async function buildFirstMessage(description, uploadedFiles, tempId, tags = {}) {
  const sharp   = require('sharp');
  const content = [];

  const images    = uploadedFiles.filter(f => STUDIO_IMAGE_MIMES.has(f.mimeType) || f.fileType === 'image');
  const textFiles = uploadedFiles.filter(f => !STUDIO_IMAGE_MIMES.has(f.mimeType) && f.fileType !== 'image');

  if (images.length > 0) {
    content.push({
      type: 'text',
      text: `Here are ${images.length} image(s) for this project. Each is labelled with its filename — use the exact filename in your JSON output:`,
    });
    for (const f of images) {
      const filePath = f.permanentPath || path.join(STUDIO_TEMP_BASE, tempId, f.filename);
      if (!fs.existsSync(filePath)) continue;
      // Resize to max 1568px on the long edge, convert to JPEG for consistent encoding
      const resized = await sharp(filePath)
        .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const data  = resized.toString('base64');
      const label = tags[f.filename] ? `${f.filename} — ${tags[f.filename]}` : f.filename;
      content.push({ type: 'text', text: `Image: ${label}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    }
  }

  for (const f of textFiles) {
    const filePath = path.join(STUDIO_TEMP_BASE, tempId, f.filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const text  = fs.readFileSync(filePath, 'utf8');
      const label = tags[f.filename]
        ? `${f.originalName} (${tags[f.filename]})`
        : f.originalName;
      content.push({
        type: 'text',
        text: `--- Context file: ${label} ---\n${text.slice(0, 50000)}\n---`,
      });
    } catch { /* skip unreadable */ }
  }

  content.push({
    type: 'text',
    text: `Project description:\n${description}\n\nGenerate the project page JSON now.`,
  });

  return { role: 'user', content };
}

// ── robots.txt ────────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin/\nDisallow: /admin\n');
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// TODO: add an About page (GET /about) with its own view and nav link.
app.get('/', (req, res) => {
  recordVisit(req, 'page');
  const activeStyle = db.prepare('SELECT config FROM sandbox_styles WHERE is_active = 1 LIMIT 1').get();
  let sandboxHeroName = null, sandboxHeroTagline = null;
  if (activeStyle) {
    const cfg = JSON.parse(activeStyle.config);
    const t = cfg.text || {};
    if (t.heroName) {
      sandboxHeroName = t.heroName.split('\n')
        .map(l => l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))
        .join('<br>');
    }
    if (t.heroTagline) sandboxHeroTagline = t.heroTagline;
  }
  const _dbName = getSetting('site_name');
  const siteHeroName = _dbName
    ? _dbName.split('\n').map(l => l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')).join('<br>')
    : null;
  const siteTagline = getSetting('site_tagline') || null;
  res.render('index', { projects: publicProjects(), sandboxHeroName, sandboxHeroTagline, siteHeroName, siteTagline, ...getLogos() });
});

// Serves the currently-active sandbox style as an external stylesheet.
// ?page=<slug> includes page-specific CSS for that project on top of the global rules.
// Using an external file avoids needing 'unsafe-inline' in style-src CSP.
// GET /logo-size.css — nav logo size as a CSS custom property (no-store so changes take effect immediately)
app.get('/logo-size.css', (req, res) => {
  const size = Math.max(26, Math.min(104, parseInt(getSetting('logo_nav_size')) || 52));
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`:root { --logo-nav-size: ${size}px; }`);
});

app.get('/sandbox-active.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const activeStyle = db.prepare('SELECT config FROM sandbox_styles WHERE is_active = 1 LIMIT 1').get();
  if (!activeStyle) return res.send('/* no active style */');
  const slug = (req.query.page && /^[a-z0-9-]{1,80}$/.test(req.query.page)) ? req.query.page : null;
  const css = buildSandboxPreviewCSS(JSON.parse(activeStyle.config), slug);
  res.send(css);
});

app.get('/projects/:slug', (req, res, next) => {
  const slug = sanitizeSlug(req.params.slug);
  const project = loadProjects().find(p => p.slug === slug);
  if (!project) return next(); // fall through to 404
  recordVisit(req, 'page');
  const hasSandboxStyle = !!db.prepare('SELECT id FROM sandbox_styles WHERE is_active = 1 LIMIT 1').get();
  res.render('project', { project, hasSandboxStyle, ...getLogos() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN AUTH ROUTES  (no requireAuth — these are the login/logout gates)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/admin', (req, res) => {
  if (req.session.authenticated) return res.redirect('/admin/dashboard');
  res.redirect('/admin/login');
});

app.get('/admin/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/admin/dashboard');
  const tok = process.env.ADMIN_ACCESS_TOKEN;
  if (tok && req.query.token !== tok) return res.status(404).end();
  res.render('admin/login', { error: null, csrfToken: getCsrfToken(req), ...getLogos() });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { password, _csrf } = req.body;

  // CSRF check on login form
  if (!_csrf || _csrf !== req.session.csrfToken) {
    return res.status(403).render('admin/login', {
      error: 'Invalid request. Please try again.',
      csrfToken: getCsrfToken(req),
      ...getLogos(),
    });
  }

  const valid = typeof password === 'string' &&
    await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);

  if (!valid) {
    // Constant-time delay to prevent timing attacks
    await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    return res.render('admin/login', {
      error: 'Incorrect password.',
      csrfToken: getCsrfToken(req),
      ...getLogos(),
    });
  }

  // Regenerate session on privilege elevation (session fixation prevention)
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { message: 'Session error.' });
    req.session.authenticated = true;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    const returnTo = req.session.returnTo || '/admin/dashboard';
    delete req.session.returnTo;
    res.redirect(302, returnTo);
  });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD & PROJECT MANAGEMENT  (all require auth)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Export all projects as JSON ───────────────────────────────────────────────
app.get('/admin/projects/export', requireAuth, (req, res) => {
  const projects = loadProjects();
  res.setHeader('Content-Disposition', 'attachment; filename="projects.json"');
  res.type('application/json').send(JSON.stringify(projects, null, 2));
});

// ── Export portfolio as single self-contained HTML file ───────────────────────
function _he(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _imageToDataUri(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const ext = path.extname(absPath).slice(1).toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function buildExportHtml(projects, sandboxCss, logos, heroName, heroTagline) {
  const PUBLIC = path.join(__dirname, 'public');
  const styleCss = (() => { try { return fs.readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8'); } catch { return ''; } })();

  function imgUri(src) {
    if (!src) return null;
    return _imageToDataUri(path.join(PUBLIC, src.replace(/^\//, '')));
  }

  const logoSmallUri = logos.logoSmallSrc ? imgUri(logos.logoSmallSrc) : null;
  const logoMarkUri  = logos.logoMarkSrc  ? imgUri(logos.logoMarkSrc)  : null;
  const escBody = (str) => _he(str || '').replace(/\n/g, '<br>');

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${_he(heroName || 'Portfolio')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
${styleCss}
</style>
<style>
${sandboxCss}
.project-export-section { border-top: 1px solid #eee; padding-top: 48px; margin-top: 48px; }
.export-back { display:inline-block; margin-bottom:24px; font-size:13px; color:#999; text-decoration:none; }
.export-back:hover { color:#333; }
</style>
</head>
<body>
<nav class="site-nav" role="navigation" aria-label="Main navigation">
  <div class="container">
    <div class="nav-inner">
      <div class="nav-logo-small">${logoSmallUri ? `<a href="#top"><img src="${logoSmallUri}" alt="Logo" draggable="false"></a>` : ''}</div>
      <div class="nav-logo-mark">${logoMarkUri ? `<a href="#top"><img src="${logoMarkUri}" alt="Logomark" draggable="false"></a>` : ''}</div>
      <div class="nav-right"><div class="nav-links-desktop"><a href="#top">Home</a></div></div>
    </div>
  </div>
</nav>
<main id="top">
  <div class="container">
    <section class="hero" aria-label="Introduction">
      ${logoSmallUri ? `<div class="hero-logo-small"><img src="${logoSmallUri}" alt="Logo" draggable="false"></div>` : ''}
      ${logoMarkUri ? `<div class="hero-logo-mark"><img src="${logoMarkUri}" alt="Logomark" draggable="false"></div>` : ''}
      <h1 class="site-name">${heroName || 'Your Name'}</h1>
      <p class="hero-text">${_he(heroTagline) || 'Portfolio'}</p>
    </section>
`;

  if (projects.length > 0) {
    html += `    <section aria-label="Portfolio projects">
      <div class="project-grid" role="list">
`;
    for (const p of projects) {
      const thumbUri = p.thumbnail ? imgUri(p.thumbnail) : null;
      html += `        <article role="listitem">
          <a class="project-card" href="#project-${_he(p.slug)}" aria-label="${_he(p.title)}">
            <div class="project-card-image">
              ${thumbUri ? `<img src="${thumbUri}" alt="${_he(p.thumbnailAlt || p.title)}" loading="lazy">` : '<div class="project-card-placeholder" aria-hidden="true"></div>'}
            </div>
            <h2 class="project-card-title">${_he(p.title)}</h2>
          </a>
        </article>
`;
    }
    html += `      </div>
    </section>
`;
  }

  html += `  </div>
</main>
`;

  for (const p of projects) {
    html += `<section id="project-${_he(p.slug)}" class="project-export-section">
  <div class="container">
    <a href="#top" class="export-back">← Back to top</a>
    <header class="project-header">
      <h1 class="project-title">${_he(p.pageTitle || p.title)}</h1>
      ${p.subtitle ? `<p class="project-subtitle">${_he(p.subtitle)}</p>` : ''}
    </header>
  </div>
`;
    for (const section of (p.sections || [])) {
      html += `  <div class="container">
    <section class="project-section">
`;
      if (section.heading) html += `      <h2 class="project-section__heading">${_he(section.heading)}</h2>\n`;
      if (section.body)    html += `      <div class="project-section__body">${escBody(section.body)}</div>\n`;

      if (section.images && section.images.length > 0) {
        const cols = (section.cols && section.cols > 0) ? section.cols : 0;
        const rows = [];
        if (cols > 0) {
          for (let i = 0; i < section.images.length; i += cols) rows.push(section.images.slice(i, i + cols));
        } else {
          rows.push(section.images);
        }
        for (const rowImgs of rows) {
          html += `      <div class="project-section-images">\n`;
          for (const img of rowImgs) {
            if (img.src) {
              const uri = imgUri(img.src);
              if (uri) html += `        <img src="${uri}" alt="${_he(img.alt || section.heading || p.title)}"${img.alt ? ` title="${_he(img.alt)}"` : ''} loading="lazy">\n`;
            }
          }
          html += `      </div>\n`;
        }
      }

      html += `    </section>
  </div>
`;
    }
    html += `</section>\n`;
  }

  html += `</body>\n</html>`;
  return html;
}

app.get('/admin/export-html', requireAuth, (req, res) => {
  const isLocal = /^(localhost|127\.0\.0\.1|::1|\[::1\]|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(req.hostname);
  if (!isLocal) return res.status(403).send('Only available from local access.');

  const projects = publicProjects();
  const activeStyle = db.prepare('SELECT config FROM sandbox_styles WHERE is_active = 1 LIMIT 1').get();
  const config = activeStyle ? JSON.parse(activeStyle.config) : JSON.parse(getSandboxSession(req.session.id));
  const sandboxCss = buildSandboxPreviewCSS(config);
  const heroName    = config.text?.heroName    || getSetting('site_name')    || '';
  const heroTagline = config.text?.heroTagline || getSetting('site_tagline') || '';

  const html = buildExportHtml(projects, sandboxCss, getLogos(), heroName, heroTagline);
  res.setHeader('Content-Disposition', 'attachment; filename="portfolio.html"');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── Import projects from JSON (merge: update existing slugs, create new ones) ─
app.post('/admin/projects/import', requireAuth, requireCsrf, (req, res) => {
  let incoming = req.body;
  if (!Array.isArray(incoming)) incoming = [incoming];
  if (!incoming.length) return res.status(400).json({ error: 'Empty import.' });

  const projects = loadProjects();
  let created = 0, updated = 0;
  let nextOrder = projects.reduce((m, p) => Math.max(m, p.order ?? 0), -1) + 1;

  for (const raw of incoming.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue;
    const slug = sanitizeSlug(raw.slug || raw.title || '');
    if (!slug) continue;

    const project = {
      slug,
      title:        (raw.title     || '').slice(0, 200),
      subtitle:     (raw.subtitle  || '').slice(0, 300),
      pageTitle:    (raw.pageTitle || '').slice(0, 200),
      thumbnail:    validateImagePath(raw.thumbnail),
      thumbnailAlt: (raw.thumbnailAlt || raw.title || '').slice(0, 200),
      sections:     sanitizeSections(raw.sections),
    };

    const idx = projects.findIndex(p => p.slug === slug);
    if (idx !== -1) {
      projects[idx] = { ...projects[idx], ...project };
      updated++;
    } else {
      project.order = nextOrder++;
      projects.push(project);
      created++;
    }
  }

  saveProjects(projects);
  res.json({ ok: true, created, updated });
});

// ── Deploy helpers ────────────────────────────────────────────────────────────
const LAUNCHER_CONFIG_PATH = path.join(__dirname, '.launcher-config.json');

function readServerConfig() {
  try { return JSON.parse(fs.readFileSync(LAUNCHER_CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeServerConfig(cfg) {
  fs.writeFileSync(LAUNCHER_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

const requireLocal = (req, res, next) => {
  if (!/^(localhost|127\.0\.0\.1|::1|\[::1\]|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(req.hostname))
    return res.status(403).json({ error: 'Only available from localhost.' });
  next();
};

function commandExists(cmd) {
  try {
    const check = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(check, [cmd], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch { return false; }
}

// Convert a local absolute path to a form rsync (MSYS2/Git Bash on Windows) accepts.
// On non-Windows this is a no-op.
function toRsyncLocal(p) {
  if (process.platform !== 'win32') return p;
  // C:\Users\foo\bar -> /c/Users/foo/bar
  return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
}

function sshExec(cfg, command, timeoutMs = 60000) {
  const { host, user, sshPort = 22 } = cfg;
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (Number(sshPort) !== 22) args.push('-p', String(sshPort));
  args.push(`${user}@${host}`, command);
  const r = spawnSync('ssh', args, { timeout: timeoutMs, encoding: 'utf8', cwd: __dirname });
  return { ok: r.status === 0 && !r.error, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), err: r.error ? r.error.message : null };
}

function rsyncRun(src, dest, sshPort = 22, extra = [], timeoutMs = 120000) {
  const args = ['-avz'];
  if (Number(sshPort) !== 22) args.push('-e', `ssh -p ${sshPort}`);
  args.push(...extra, src, dest);
  const r = spawnSync('rsync', args, { timeout: timeoutMs, encoding: 'utf8', cwd: __dirname });
  return { ok: r.status === 0 && !r.error, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), err: r.error ? r.error.message : null };
}

function shEsc(s) { return String(s).replace(/'/g, "'\\''"); }
// Expand leading ~ to $HOME so the remote bash shell resolves it correctly.
// Single-quoted paths suppress tilde expansion; double-quoting with $HOME works.
function xrp(rp) { return String(rp).startsWith('~') ? '$HOME' + String(rp).slice(1) : String(rp); }

const SSH_CMDS = {
  apt_update:       ()             => 'sudo apt-get update && sudo apt-get upgrade -y',
  node_install:     ()             => 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs && node --version',
  pm2_install:      ()             => 'sudo npm install -g pm2 && pm2 --version',
  npm_install:      (rp)           => `cd "${xrp(rp)}" && npm install --omit=dev`,
  pm2_start:        (rp)           => `cd "${xrp(rp)}" && (pm2 describe portfolio > /dev/null 2>&1 && pm2 delete portfolio --silent); (pm2 describe open-folio > /dev/null 2>&1 && pm2 restart open-folio || pm2 start scripts/ecosystem.config.js --env production) && pm2 save`,
  restart:          ()             => 'pm2 restart open-folio',
  status:           ()             => '(which pm2 > /dev/null 2>&1 && pm2 status) || echo "⚠  pm2 not installed — run the Install PM2 setup step first"; echo ""; df -h / ; echo ""; uptime',
  logs:             ()             => 'pm2 logs open-folio --lines 80 --nostream',
  git_pull:         (rp)           => `cd "${xrp(rp)}" && git pull && npm install --omit=dev && pm2 restart open-folio`,
  git_clone:        (rp, url)      => `git clone '${shEsc(url)}' "${xrp(rp)}"`,
  ufw_setup:        ()             => 'sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable && sudo ufw status',
  caddy_install:    ()             => "sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt update && sudo apt install caddy -y && sudo systemctl enable caddy && sudo systemctl start caddy && caddy version",
  caddy_configure:  (rp, domain)   => `printf '${shEsc(domain)} {\\n  reverse_proxy localhost:3000\\n}\\n' | sudo tee /etc/caddy/Caddyfile && sudo systemctl reload caddy && sudo systemctl status caddy --no-pager`,
  server_setup:     (rp, password) => `cd "${xrp(rp)}" && node scripts/setup.js --password='${shEsc(password)}'`,
  manage_password:  (rp, password) => `cd "${xrp(rp)}" && node manage.js --set-password='${shEsc(password)}' && pm2 restart open-folio`,
};

// ── Settings helpers ──────────────────────────────────────────────────────────
const EDITABLE_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_PROVIDER']);

function updateEnvFile(key, value) {
  const envPath = path.join(__dirname, '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* file missing */ }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.replace(/\n*$/, '') + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
  process.env[key] = value;
}

function aiStatus() {
  const active = getActiveProvider();
  const providerInfo = {};
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    providerInfo[id] = { name: cfg.name, hasKey: !!process.env[cfg.keyEnv], isActive: id === active };
  }
  return { active, providers: providerInfo };
}

app.get('/admin/dashboard', requireAuth, (req, res) => {
  // Allow inline <script> for the CSRF-token-dependent sandbox styles code.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  // Show Deploy tab only when accessed locally (localhost or direct IP, not via a real domain)
  const isLocalAccess = /^(localhost|127\.0\.0\.1|::1|\[::1\]|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(req.hostname);
  res.render('admin/index', {
    projects:      sortedProjects(),
    activity:      getActivityStats(),
    csrfToken:     getCsrfToken(req),
    flash:         req.query.msg || null,
    aiStatus:      aiStatus(),
    providers:     PROVIDERS,
    isLocalAccess,
    siteName:      getSetting('site_name')    || '',
    siteTagline:   getSetting('site_tagline') || '',
    logoNavSize:      parseInt(getSetting('logo_nav_size')) || 52,
    serverConfig:     readServerConfig().server || {},
    hasAccessToken:   !!process.env.ADMIN_ACCESS_TOKEN,
    ...getLogos(),
  });
});

// POST /admin/settings/api-key — write a key/provider setting to .env
app.post('/admin/settings/api-key', requireAuth, requireCsrf, (req, res) => {
  const { key, value, activate } = req.body;
  if (!EDITABLE_KEYS.has(key)) {
    return res.status(400).json({ error: 'Unknown key.' });
  }
  // AI_PROVIDER is a config value, not a secret — different validation
  if (key === 'AI_PROVIDER') {
    if (!PROVIDERS[value]) return res.status(400).json({ error: 'Unknown provider.' });
    updateEnvFile('AI_PROVIDER', value);
    return res.json({ ok: true });
  }
  if (typeof value !== 'string' || value.trim().length < 8) {
    return res.status(400).json({ error: 'Key value is too short.' });
  }
  try {
    updateEnvFile(key, value.trim());
    if (activate) {
      const provider = Object.keys(PROVIDERS).find(p => PROVIDERS[p].keyEnv === key);
      if (provider) updateEnvFile('AI_PROVIDER', provider);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings/api-key]', err.message);
    res.status(500).json({ error: 'Could not save key.' });
  }
});

// POST /admin/settings/logo — upload small logo or logomark image
app.post('/admin/settings/logo', requireAuth, requireCsrf, logoUpload.single('image'), (req, res) => {
  const type = req.body.type;
  if (type !== 'small' && type !== 'mark') return res.status(400).json({ error: 'Invalid logo type.' });
  if (!req.file) return res.status(400).json({ error: 'No valid image file received.' });

  const settingKey = type === 'small' ? 'logo_small' : 'logo_mark';
  const oldPath = getSetting(settingKey);
  if (oldPath) {
    try { fs.unlinkSync(path.join(__dirname, 'public', oldPath.replace(/^\//, ''))); } catch {}
  }
  const webPath = '/images/logos/' + req.file.filename;
  setSetting(settingKey, webPath);
  res.json({ ok: true, src: webPath });
});

// DELETE /admin/settings/logo/:type — remove a logo image
app.delete('/admin/settings/logo/:type', requireAuth, requireCsrf, (req, res) => {
  const type = req.params.type;
  if (type !== 'small' && type !== 'mark') return res.status(400).json({ error: 'Invalid type.' });
  const settingKey = type === 'small' ? 'logo_small' : 'logo_mark';
  const oldPath = getSetting(settingKey);
  if (oldPath) {
    try { fs.unlinkSync(path.join(__dirname, 'public', oldPath.replace(/^\//, ''))); } catch {}
    deleteSetting(settingKey);
  }
  res.json({ ok: true });
});

// POST /admin/settings/logo-size — persist nav logo size (26–104 px)
app.post('/admin/settings/logo-size', requireAuth, requireCsrf, (req, res) => {
  const size = Math.max(26, Math.min(104, parseInt(req.body.size)));
  if (isNaN(size)) return res.status(400).json({ error: 'Invalid size.' });
  setSetting('logo_nav_size', String(size));
  res.json({ ok: true });
});

// POST /admin/settings/password — change the admin login password
app.post('/admin/settings/password', requireAuth, requireCsrf, async (req, res) => {
  const { current, newPassword } = req.body;
  if (typeof current !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  }
  const valid = await bcrypt.compare(current, process.env.ADMIN_PASSWORD_HASH);
  if (!valid) {
    await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  updateEnvFile('ADMIN_PASSWORD_HASH', hash);
  res.json({ ok: true });
});

// POST /admin/settings/access-token — set or clear the secret access word
app.post('/admin/settings/access-token', requireAuth, requireCsrf, (req, res) => {
  const { token } = req.body;
  if (typeof token !== 'string') return res.status(400).json({ error: 'Invalid request.' });
  const clean = token.trim();
  if (clean && clean.length < 6) return res.status(400).json({ error: 'Token must be at least 6 characters, or leave blank to disable.' });
  updateEnvFile('ADMIN_ACCESS_TOKEN', clean);
  res.json({ ok: true });
});

// ── Remote Server / Deploy routes (local access only) ────────────────────────
app.get('/admin/deploy/config', requireAuth, requireLocal, (req, res) => {
  res.json({ server: readServerConfig().server || {} });
});

app.post('/admin/deploy/config', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { host, user, sshPort, remotePath } = req.body;
  if (!host || !user) return res.status(400).json({ error: 'host and user are required.' });
  const port = Math.max(1, Math.min(65535, parseInt(sshPort) || 22));
  const cfg = readServerConfig();
  cfg.server = { host: String(host).trim(), user: String(user).trim(), sshPort: port, remotePath: String(remotePath || '~/open-folio').trim() };
  writeServerConfig(cfg);
  res.json({ ok: true });
});

app.post('/admin/deploy/test', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const r = sshExec(srv, 'echo "OK" && uname -a && uptime', 15000);
  res.json(r);
});

app.post('/admin/deploy/clear-known-host', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const r = spawnSync('ssh-keygen', ['-R', srv.host], { encoding: 'utf8', timeout: 10000 });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  res.json({ ok: r.status === 0 || out.includes('not found'), output: out });
});

app.get('/admin/deploy/local-pubkey', requireAuth, requireLocal, (req, res) => {
  const home    = os.homedir();
  const sshDir  = path.join(home, '.ssh');
  const keyTypes = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
  for (const kt of keyTypes) {
    const pubFile = path.join(sshDir, kt + '.pub');
    if (fs.existsSync(pubFile)) {
      return res.json({ ok: true, key: fs.readFileSync(pubFile, 'utf8').trim(), file: pubFile });
    }
  }
  // No key found — generate ed25519
  if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { recursive: true });
  const keyFile = path.join(sshDir, 'id_ed25519');
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-C', 'open-folio', '-f', keyFile, '-N', ''], { encoding: 'utf8', timeout: 15000 });
  const pubFile = keyFile + '.pub';
  if (r.status === 0 && fs.existsSync(pubFile)) {
    return res.json({ ok: true, key: fs.readFileSync(pubFile, 'utf8').trim(), file: pubFile, generated: true });
  }
  res.status(500).json({ ok: false, error: 'No SSH key found and key generation failed.' });
});

app.post('/admin/deploy/ssh-run', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { command, repoUrl, domain, password } = req.body;
  if (!SSH_CMDS[command]) return res.status(400).json({ error: 'Unknown command.' });
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const rp = srv.remotePath || '~/open-folio';
  let cmd;
  if (command === 'git_clone') {
    if (!repoUrl || !repoUrl.trim()) return res.status(400).json({ error: 'repoUrl required for git_clone.' });
    cmd = SSH_CMDS.git_clone(rp, repoUrl.trim());
  } else if (command === 'caddy_configure') {
    if (!domain || !domain.trim()) return res.status(400).json({ error: 'domain required for caddy_configure.' });
    const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9][a-z0-9\-\.]*\.[a-z]{2,}$/.test(cleanDomain)) return res.status(400).json({ error: 'Invalid domain format.' });
    cmd = SSH_CMDS.caddy_configure(rp, cleanDomain);
  } else if (command === 'server_setup' || command === 'manage_password') {
    if (!password || String(password).length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    cmd = SSH_CMDS[command](rp, String(password));
  } else {
    cmd = SSH_CMDS[command](rp);
  }
  const slowCmds = new Set(['apt_update', 'node_install', 'caddy_install', 'server_setup']);
  const timeout = slowCmds.has(command) ? 180000 : 60000;
  const result = sshExec(srv, cmd, timeout);
  res.json({ ...result, output: [result.stdout, result.stderr].filter(Boolean).join('\n') });
});

// Same as ssh-run but streams output line-by-line as NDJSON for live terminal preview
app.post('/admin/deploy/ssh-run-stream', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { command, repoUrl, domain, password } = req.body;
  if (!SSH_CMDS[command]) return res.status(400).json({ error: 'Unknown command.' });
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const rp = srv.remotePath || '~/open-folio';
  let cmd;
  if (command === 'git_clone') {
    if (!repoUrl || !repoUrl.trim()) return res.status(400).json({ error: 'repoUrl required for git_clone.' });
    cmd = SSH_CMDS.git_clone(rp, repoUrl.trim());
  } else if (command === 'caddy_configure') {
    if (!domain || !domain.trim()) return res.status(400).json({ error: 'domain required for caddy_configure.' });
    const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9][a-z0-9\-\.]*\.[a-z]{2,}$/.test(cleanDomain)) return res.status(400).json({ error: 'Invalid domain format.' });
    cmd = SSH_CMDS.caddy_configure(rp, cleanDomain);
  } else if (command === 'server_setup' || command === 'manage_password') {
    if (!password || String(password).length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    cmd = SSH_CMDS[command](rp, String(password));
  } else {
    cmd = SSH_CMDS[command](rp);
  }

  const { host, user, sshPort = 22 } = srv;
  const sshArgs = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (Number(sshPort) !== 22) sshArgs.push('-p', String(sshPort));
  sshArgs.push(`${user}@${host}`, cmd);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const slowCmds = new Set(['apt_update', 'node_install', 'caddy_install', 'server_setup']);
  const timeoutMs = slowCmds.has(command) ? 180000 : 60000;
  // stdin must be 'ignore' (not the default 'pipe') so Windows OpenSSH
  // doesn't keep the connection open waiting for stdin EOF.
  const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: __dirname });
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };
  proc.stdout.on('data', (chunk) => send({ text: chunk.toString() }));
  proc.stderr.on('data', (chunk) => send({ text: chunk.toString() }));
  proc.on('close', (code) => { clearTimeout(timer); send({ done: true, ok: code === 0 }); res.end(); });
  proc.on('error', (err) => { clearTimeout(timer); send({ text: err.message, done: true, ok: false }); res.end(); });
  req.on('close', () => { clearTimeout(timer); proc.kill(); });
});

app.post('/admin/deploy/sync', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { direction } = req.body;
  if (direction !== 'push' && direction !== 'pull') return res.status(400).json({ error: 'Invalid direction.' });
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const { host, user, sshPort = 22, remotePath = '~/open-folio' } = srv;
  const remote = `${user}@${host}`;
  const items = [
    { label: 'Database',       local: 'data/portfolio.db',          server: `${remote}:${remotePath}/data/` },
    { label: 'Project images', local: 'public/images/projects/',    server: `${remote}:${remotePath}/public/images/projects/` },
    { label: 'Logo images',    local: 'public/images/logos/',       server: `${remote}:${remotePath}/public/images/logos/` },
  ];
  const results = items.map(({ label, local, server }) => ({
    label,
    ...(direction === 'push'
      ? rsyncRun(local, server, sshPort)
      : rsyncRun(server, local, sshPort)),
  }));
  res.json({ ok: results.every(r => r.ok), results });
});

app.post('/admin/deploy/compare', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const rp = srv.remotePath || '~/open-folio';

  // Use SSH to list remote files — no rsync dependency, works on all platforms.
  // xrp() converts leading ~ to $HOME; double-quoting lets bash expand it.
  const erp    = xrp(rp);
  const dbCmd  = `stat -c '%s' "${erp}/data/portfolio.db" 2>/dev/null || echo __missing__`;
  const imgCmd = `find "${erp}/public/images" -type f -printf '%P\t%s\n' 2>/dev/null | sort`;

  const dbResult  = sshExec(srv, dbCmd,  20000);
  const imgResult = sshExec(srv, imgCmd, 30000);

  if (!dbResult.ok && !imgResult.ok) {
    return res.json({ ok: false, error: `SSH failed: ${dbResult.stderr || dbResult.err || 'connection error'}`, items: [] });
  }

  const items = [];

  // ── Database ────────────────────────────────────────────────────────────────
  const localDbPath   = path.join(__dirname, 'data', 'portfolio.db');
  const localDbExists = fs.existsSync(localDbPath);
  const remoteDbRaw   = (dbResult.stdout || '').trim();

  if (remoteDbRaw === '__missing__' && localDbExists) {
    items.push({ id: 'db', label: 'Portfolio database', hint: 'Not on server yet', direction: 'push' });
  } else if (remoteDbRaw !== '__missing__' && !localDbExists) {
    items.push({ id: 'db', label: 'Portfolio database', hint: 'Not on local machine', direction: 'pull' });
  } else if (localDbExists && remoteDbRaw !== '__missing__') {
    const localSize  = fs.statSync(localDbPath).size;
    const remoteSize = parseInt(remoteDbRaw, 10) || 0;
    if (localSize !== remoteSize) {
      items.push({ id: 'db', label: 'Portfolio database', hint: `Sizes differ — Local: ${(localSize/1024).toFixed(1)} KB / Server: ${(remoteSize/1024).toFixed(1)} KB`, direction: 'both' });
    }
  }

  // ── Images ──────────────────────────────────────────────────────────────────
  const localImgBase = path.join(__dirname, 'public', 'images');

  const remoteFiles = new Map();
  for (const line of (imgResult.stdout || '').split('\n')) {
    const tab = line.lastIndexOf('\t');
    if (tab < 0) continue;
    const relPath = line.slice(0, tab).replace(/\\/g, '/').trim();
    const size    = parseInt(line.slice(tab + 1), 10) || 0;
    if (relPath) remoteFiles.set(relPath, size);
  }

  function walkLocal(dir, base) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walkLocal(path.join(dir, entry.name), rel));
      else out.push({ path: rel, size: fs.statSync(path.join(dir, entry.name)).size });
    }
    return out;
  }
  const localFiles = new Map(walkLocal(localImgBase, '').map(f => [f.path, f.size]));

  function groupOf(relPath) {
    const parts = relPath.split('/');
    if (parts[0] === 'projects' && parts.length >= 2) return `projects/${parts[1]}`;
    if (parts[0] === 'logos') return 'logos';
    return parts[0] || 'other';
  }
  // Per-group stats: localOnly = on local but not server, remoteOnly = on server but not local, diff = both exist but differ
  const groupStats = new Map();
  function getStat(g) {
    if (!groupStats.has(g)) groupStats.set(g, { localOnly: 0, remoteOnly: 0, diff: 0 });
    return groupStats.get(g);
  }
  for (const [relPath, localSize] of localFiles) {
    const remoteSize = remoteFiles.get(relPath);
    if (remoteSize === undefined) getStat(groupOf(relPath)).localOnly++;
    else if (remoteSize !== localSize) getStat(groupOf(relPath)).diff++;
  }
  for (const [relPath] of remoteFiles) {
    if (!localFiles.has(relPath)) getStat(groupOf(relPath)).remoteOnly++;
  }

  for (const [groupId, stat] of groupStats) {
    const isProject = groupId.startsWith('projects/');
    const label = isProject ? groupId.slice('projects/'.length) : (groupId === 'logos' ? 'Logo images' : groupId);
    let direction, hint;
    if (stat.localOnly > 0 && stat.remoteOnly === 0 && stat.diff === 0) {
      direction = 'push';
      hint = `${stat.localOnly} file${stat.localOnly === 1 ? '' : 's'} only on local machine`;
    } else if (stat.remoteOnly > 0 && stat.localOnly === 0 && stat.diff === 0) {
      direction = 'pull';
      hint = `${stat.remoteOnly} file${stat.remoteOnly === 1 ? '' : 's'} only on server`;
    } else {
      direction = 'both';
      const parts = [];
      if (stat.localOnly)  parts.push(`${stat.localOnly} local-only`);
      if (stat.remoteOnly) parts.push(`${stat.remoteOnly} server-only`);
      if (stat.diff)       parts.push(`${stat.diff} differ`);
      hint = parts.join(', ');
    }
    items.push({ id: `images/${groupId}`, label, hint, direction });
  }

  res.json({ ok: true, items });
});

app.post('/admin/deploy/sync-item', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { itemId, direction } = req.body;
  if (direction !== 'push' && direction !== 'pull') return res.status(400).json({ error: 'Invalid direction.' });
  if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId required.' });
  if (!/^(db|images\/logos|images\/projects\/[a-z0-9][a-z0-9\-]*)$/.test(itemId)) return res.status(400).json({ error: 'Invalid itemId.' });

  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const { host, user, sshPort = 22, remotePath = '~/open-folio' } = srv;
  const remote = `${user}@${host}`;

  let localPath, serverPath;
  if (itemId === 'db') {
    localPath  = 'data/portfolio.db';
    serverPath = `${remote}:${remotePath}/data/`;
  } else {
    const rel  = itemId.replace(/^images\//, '');
    localPath  = `public/images/${rel}/`;
    serverPath = `${remote}:${remotePath}/public/images/${rel}/`;
  }

  const result = direction === 'push'
    ? rsyncRun(localPath, serverPath, sshPort)
    : rsyncRun(serverPath, localPath, sshPort);

  res.json({ ok: result.ok, output: [result.stdout, result.stderr].filter(Boolean).join('\n'), err: result.err });
});

app.post('/admin/deploy/backup', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const { host, user, sshPort = 22, remotePath = '~/open-folio' } = srv;
  const remote = `${user}@${host}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir     = path.join(__dirname, 'data', 'backups', ts);
  const backupImgDir  = path.join(backupDir, 'images');
  fs.mkdirSync(backupImgDir, { recursive: true });
  // Convert to Unix-style paths for rsync on Windows (MSYS2/Git Bash)
  const destDb  = toRsyncLocal(backupDir)  + '/';
  const destImg = toRsyncLocal(backupImgDir) + '/';
  const results = [
    { label: 'Database', ...rsyncRun(`${remote}:${remotePath}/data/portfolio.db`, destDb,  sshPort) },
    { label: 'Images',   ...rsyncRun(`${remote}:${remotePath}/public/images/`,    destImg, sshPort) },
  ];
  res.json({ ok: results.every(r => r.ok), backupPath: path.relative(__dirname, backupDir), results });
});

app.post('/admin/deploy/open-terminal', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const { host, user, sshPort = 22 } = srv;
  const portArgs = Number(sshPort) !== 22 ? ['-p', String(sshPort)] : [];
  const target   = `${user}@${host}`;
  try {
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "ssh ${portArgs.join(' ')} ${target}"`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      const sshCmd = `ssh ${portArgs.join(' ')} ${target}`;
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', sshCmd], { detached: true, stdio: 'ignore', shell: true }).unref();
    } else {
      const sshArgs = [...portArgs, target];
      const candidates = ['x-terminal-emulator', 'gnome-terminal', 'xfce4-terminal', 'xterm'];
      let launched = false;
      for (const t of candidates) {
        try { spawnSync('which', [t], { stdio: 'ignore' }); } catch { continue; }
        const r = spawnSync('which', [t], { encoding: 'utf8' });
        if (r.status === 0) {
          spawn(t, ['-e', 'ssh', ...sshArgs], { detached: true, stdio: 'ignore' }).unref();
          launched = true; break;
        }
      }
      if (!launched) return res.status(400).json({ error: 'No terminal emulator found. Copy the SSH command and paste it in your terminal.' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/deploy/backups', requireAuth, requireLocal, (req, res) => {
  const backupsDir = path.join(__dirname, 'data', 'backups');
  if (!fs.existsSync(backupsDir)) return res.json({ backups: [] });
  const entries = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const ts    = d.name;
      const full  = path.join(backupsDir, ts);
      const hasDb = fs.existsSync(path.join(full, 'portfolio.db'));
      const hasImg = fs.existsSync(path.join(full, 'images'));
      const parts = [];
      if (hasDb)  parts.push('database');
      if (hasImg) parts.push('images');
      return { path: ts, label: ts.replace('T', ' ').replace(/-/g, (m, o) => o > 10 ? ':' : '-').slice(0, 19), contents: parts.join(' + ') || 'empty' };
    })
    .sort((a, b) => b.path.localeCompare(a.path));
  res.json({ backups: entries });
});

app.post('/admin/deploy/push-backup', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { path: backupTs } = req.body;
  if (!backupTs || !/^[\w\-:T.]+$/.test(backupTs)) return res.status(400).json({ error: 'Invalid backup path.' });
  const backupDir = path.join(__dirname, 'data', 'backups', backupTs);
  if (!fs.existsSync(backupDir)) return res.status(400).json({ error: 'Backup not found.' });
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const { host, user, sshPort = 22, remotePath = '~/open-folio' } = srv;
  const remote  = `${user}@${host}`;
  const results = [];
  const dbPath  = path.join(backupDir, 'portfolio.db');
  const imgPath = path.join(backupDir, 'images');
  if (fs.existsSync(dbPath))  results.push({ label: 'Database', ...rsyncRun(toRsyncLocal(dbPath), `${remote}:${remotePath}/data/`, sshPort) });
  if (fs.existsSync(imgPath)) results.push({ label: 'Images',   ...rsyncRun(toRsyncLocal(imgPath) + '/', `${remote}:${remotePath}/public/images/`, sshPort) });
  res.json({ ok: results.every(r => r.ok), results });
});

// ── Site identity (name + tagline) ────────────────────────────────────────────
app.post('/admin/settings/site-info', requireAuth, requireCsrf, (req, res) => {
  const { siteName, siteTagline } = req.body;
  if (typeof siteName === 'string')    setSetting('site_name',    siteName.slice(0, 100));
  if (typeof siteTagline === 'string') setSetting('site_tagline', siteTagline.slice(0, 500));
  res.json({ ok: true });
});

// ── New project form ──────────────────────────────────────────────────────────
app.get('/admin/projects/new', requireAuth, (req, res) => {
  res.render('admin/project-form', {
    project: null,
    csrfToken: getCsrfToken(req),
    error: null,
    ...getLogos(),
  });
});

// ── Create project ────────────────────────────────────────────────────────────
app.post('/admin/projects', requireAuth, requireCsrf, (req, res) => {
  const projects = loadProjects();
  const { title, subtitle, pageTitle, thumbnail, thumbnailAlt } = req.body;
  const rawSlug = req.body.slug || title || '';
  const slug = sanitizeSlug(rawSlug);
  let sections = [];

  try { sections = JSON.parse(req.body.sectionsJson || '[]'); } catch { /* invalid json */ }

  if (!slug) {
    return res.status(400).json({ error: 'Slug is required.' });
  }
  if (projects.find(p => p.slug === slug)) {
    return res.status(409).json({ error: 'A project with that slug already exists.' });
  }

  const maxOrder = projects.reduce((m, p) => Math.max(m, p.order ?? 0), -1);
  const project = {
    slug,
    title:        (title     || '').slice(0, 200),
    subtitle:     (subtitle  || '').slice(0, 300),
    pageTitle:    (pageTitle || '').slice(0, 200),
    thumbnail:    validateImagePath(thumbnail),
    thumbnailAlt: (thumbnailAlt || title || '').slice(0, 200),
    order:        maxOrder + 1,
    sections:     sanitizeSections(sections),
  };

  projects.push(project);
  saveProjects(projects);
  res.json({ ok: true, slug });
});

// ── Edit project form ─────────────────────────────────────────────────────────
app.get('/admin/projects/:slug/edit', requireAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const project = loadProjects().find(p => p.slug === slug);
  if (!project) return res.status(404).render('404');
  res.render('admin/project-form', {
    project,
    csrfToken: getCsrfToken(req),
    error: null,
    ...getLogos(),
  });
});

// ── Studio edit mode ──────────────────────────────────────────────────────────
app.get('/admin/projects/:slug/studio', requireAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const project = loadProjects().find(p => p.slug === slug);
  if (!project) return res.status(404).render('404');

  const editProject = project;
  const tempId = crypto.randomUUID();
  fs.mkdirSync(path.join(STUDIO_TEMP_BASE, tempId), { recursive: true });
  req.session.studio = {
    tempId,
    editSlug:       slug,
    uploadedFiles:  [],
    description:    '',
    history:        [],
    chatHistory:    [],
    currentProject: editProject,
  };

  // Scan the project image folder so the sidebar shows ALL uploaded images
  const imgDir = path.join(__dirname, 'public', 'images', 'projects', slug);
  let folderImages = [];
  try {
    folderImages = fs.readdirSync(imgDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .map(f => `/images/projects/${slug}/${f}`);
  } catch { /* folder not created yet */ }

  const safeJson = JSON.stringify(editProject)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const safeFolderImages = JSON.stringify(folderImages)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

  const _ap2 = getActiveProvider();
  res.render('admin/studio', {
    csrfToken:          getCsrfToken(req),
    tempId:             req.session.studio.tempId,
    mode:               'edit',
    editSlug:           slug,
    previewProject:     editProject,
    initialProjectJson: safeJson,
    folderImagesJson:   safeFolderImages,
    aiProvider:         _ap2,
    aiProviderName:     PROVIDERS[_ap2].name,
    aiModels:           PROVIDERS[_ap2].models,
    hasAI:              hasActiveKey(),
    ...getLogos(),
  });
});

app.post('/admin/projects/:slug/save-draft-edits', requireAuth, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!db.prepare('SELECT slug FROM projects WHERE slug = ?').get(slug)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const studio = req.session.studio;
  // Accept project from request body (client always sends it); fall back to session
  const proj = (req.body?.project && typeof req.body.project === 'object')
    ? req.body.project
    : studio?.currentProject;
  if (!proj) return res.status(400).json({ error: 'No project data.' });

  // Keep session in sync so publish works in the same session
  if (studio) studio.currentProject = proj;

  const draftData = JSON.stringify({
    title:        (proj.title        || '').slice(0, 200),
    subtitle:     (proj.subtitle     || '').slice(0, 300),
    pageTitle:    (proj.pageTitle    || '').slice(0, 200),
    thumbnail:    proj.thumbnail     || '',
    thumbnailAlt: (proj.thumbnailAlt || '').slice(0, 200),
    sections:     sanitizeSections(proj.sections, { allowTemp: true }),
  });
  db.prepare('UPDATE projects SET draft_data = ? WHERE slug = ?').run(draftData, slug);
  res.json({ ok: true });
});

app.post('/admin/projects/:slug/publish-edits', requireAuth, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.slug === slug);
  if (idx === -1) return res.status(404).json({ error: 'Not found.' });

  const studio = req.session.studio;
  const proj = (req.body?.project && typeof req.body.project === 'object')
    ? req.body.project
    : studio?.currentProject;
  if (!proj) return res.status(400).json({ error: 'No project data.' });

  // If client sent no sections, fall back to session project sections so we never wipe content
  if (!Array.isArray(proj.sections) || proj.sections.length === 0) {
    const sessionSections = studio?.currentProject?.sections;
    if (Array.isArray(sessionSections) && sessionSections.length > 0) {
      proj.sections = sessionSections;
    }
  }

  const sanitized = sanitizeSections(proj.sections);

  projects[idx] = {
    ...projects[idx],
    title:        (proj.title        || '').slice(0, 200),
    subtitle:     (proj.subtitle     || '').slice(0, 300),
    pageTitle:    (proj.pageTitle    || '').slice(0, 200),
    thumbnail:    validateImagePath(proj.thumbnail) || projects[idx].thumbnail,
    thumbnailAlt: (proj.thumbnailAlt || '').slice(0, 200),
    sections:     sanitized,
    draft_data:   null,
  };
  saveProjects(projects);
  db.prepare('UPDATE projects SET draft_data = NULL WHERE slug = ?').run(slug);

  if (studio?.editSlug) {
    // Edit mode: keep the session alive so chat history and context survive auto-saves.
    // Just update currentProject to reflect what was saved.
    studio.currentProject = projects[idx];
  } else {
    // Generate mode: fully tear down the temp session after publish.
    if (studio?.tempId) discardStudioTemp(studio.tempId);
    delete req.session.studio;
  }

  res.json({ ok: true });
});

app.post('/admin/projects/:slug/discard-draft', requireAuth, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!db.prepare('SELECT slug FROM projects WHERE slug = ?').get(slug)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const studio = req.session.studio;
  if (studio?.tempId) discardStudioTemp(studio.tempId);
  db.prepare('UPDATE projects SET draft_data = NULL WHERE slug = ?').run(slug);
  delete req.session.studio;
  res.json({ ok: true });
});

// ── Update project ────────────────────────────────────────────────────────────
app.post('/admin/projects/:slug/update', requireAuth, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.slug === slug);
  if (idx === -1) return res.status(404).json({ error: 'Project not found.' });

  const { title, subtitle, pageTitle, thumbnail, thumbnailAlt } = req.body;
  let sections = [];
  try { sections = JSON.parse(req.body.sectionsJson || '[]'); } catch { /* invalid */ }

  projects[idx] = {
    ...projects[idx],
    title:        (title     || '').slice(0, 200),
    subtitle:     (subtitle  || '').slice(0, 300),
    pageTitle:    (pageTitle || '').slice(0, 200),
    thumbnail:    validateImagePath(thumbnail),
    thumbnailAlt: (thumbnailAlt || title || '').slice(0, 200),
    sections:     sanitizeSections(sections),
  };

  saveProjects(projects);
  res.json({ ok: true });
});

// ── Delete project ────────────────────────────────────────────────────────────
app.post('/admin/projects/:slug/delete', requireAuth, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  let projects = loadProjects();
  projects = projects.filter(p => p.slug !== slug);
  projects.forEach((p, i) => { p.order = i; });
  saveProjects(projects);
  res.json({ ok: true });
});

// ── Toggle project visibility ─────────────────────────────────────────────────
app.post('/admin/projects/:slug/toggle-visibility', requireAuth, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const row  = db.prepare('SELECT visible FROM projects WHERE slug = ?').get(slug);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const newVisible = row.visible === 0 ? 1 : 0;
  db.prepare('UPDATE projects SET visible = ? WHERE slug = ?').run(newVisible, slug);
  res.json({ ok: true, visible: newVisible });
});

// ── Reorder projects ──────────────────────────────────────────────────────────
app.post('/admin/projects/reorder', requireAuth, requireCsrf, (req, res) => {
  const { slugs } = req.body;
  if (!Array.isArray(slugs)) return res.status(400).json({ error: 'Invalid payload.' });

  const projects = loadProjects();
  slugs.forEach((slug, i) => {
    const p = projects.find(p => p.slug === sanitizeSlug(slug));
    if (p) p.order = i;
  });
  saveProjects(projects);
  res.json({ ok: true });
});

// ── Image upload ──────────────────────────────────────────────────────────────
app.post('/admin/upload/:slug', requireAuth, (req, res, next) => {
  // Validate slug before multer touches disk
  try { safeImageDir(req.params.slug); } catch {
    return res.status(400).json({ error: 'Invalid project slug.' });
  }

  upload.single('image')(req, res, (err) => {
    if (err) {
      const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      return res.status(status).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const { safeSlug } = safeImageDir(req.params.slug);
    const relativePath = `/images/projects/${safeSlug}/${req.file.filename}`;
    res.json({ path: relativePath });
  });
});

// ── Delete uploaded image ─────────────────────────────────────────────────────
app.post('/admin/image/delete', requireAuth, requireCsrf, (req, res) => {
  const { imagePath } = req.body;
  if (!imagePath || typeof imagePath !== 'string') {
    return res.status(400).json({ error: 'Missing imagePath.' });
  }

  // Only allow deletion of images within the projects directory
  const resolved = path.resolve(path.join(__dirname, 'public'), imagePath.replace(/^\//, ''));
  if (!resolved.startsWith(IMAGES_BASE + path.sep)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not delete file.' });
  }
});

// ── Geo lookup (admin only, results cached in DB) ─────────────────────────────
const _geoGet    = db.prepare('SELECT * FROM geo_cache WHERE ip = ?');
const _geoUpsert = db.prepare(`
  INSERT INTO geo_cache (ip, country, country_code, city, org, ts)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ip) DO UPDATE SET
    country      = excluded.country,
    country_code = excluded.country_code,
    city         = excluded.city,
    org          = excluded.org,
    ts           = excluded.ts
`);

app.get('/admin/geo', requireAuth, async (req, res) => {
  const ips = (req.query.ips || '').split(',')
    .map(s => s.trim())
    .filter(s => s && /^[\d.a-fA-F:]+$/.test(s))
    .slice(0, 50);

  if (!ips.length) return res.json({});

  const result = {};
  const toFetch = [];

  for (const ip of ips) {
    const cached = _geoGet.get(ip);
    if (cached) {
      result[ip] = { country: cached.country, country_code: cached.country_code, city: cached.city, org: cached.org };
    } else {
      toFetch.push(ip);
    }
  }

  if (toFetch.length) {
    try {
      const resp = await fetch('http://ip-api.com/batch?fields=query,status,country,countryCode,city,org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toFetch.map(ip => ({ query: ip }))),
        signal: AbortSignal.timeout(6000),
      });
      const data = await resp.json();
      for (const entry of data) {
        const ip  = entry.query;
        const geo = entry.status === 'success'
          ? { country: entry.country || '', country_code: entry.countryCode || '', city: entry.city || '', org: entry.org || '' }
          : { country: '', country_code: '', city: '', org: '' };
        _geoUpsert.run(ip, geo.country, geo.country_code, geo.city, geo.org, Date.now());
        result[ip] = geo;
      }
    } catch {
      for (const ip of toFetch) result[ip] = null;
    }
  }

  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════════════
// AI STUDIO  (session auth, CSRF on mutating routes)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: resolve and validate a path within studio-temp/<tempId>
function safeStudioPath(tempId, filename) {
  if (!tempId || !/^[a-f0-9-]{36}$/.test(tempId)) throw new Error('Invalid tempId');
  const base = path.join(STUDIO_TEMP_BASE, tempId);
  const full = path.resolve(base, filename);
  if (!full.startsWith(base + path.sep)) throw new Error('Path traversal');
  return full;
}

// Clean up a studio temp folder
function discardStudioTemp(tempId) {
  if (!tempId || !/^[a-f0-9-]{36}$/.test(tempId)) return;
  const dir = path.join(STUDIO_TEMP_BASE, tempId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}


// GET /admin/generate — generate new project with AI
app.get('/admin/generate', requireAuth, (req, res) => {
  // Keep existing session if one is active — only create fresh if there isn't one
  if (!req.session.studio?.tempId) {
    req.session.studio = {
      tempId:        crypto.randomUUID(),
      uploadedFiles: [],
      description:   '',
      history:       [],
      chatHistory:   [],
      currentProject: null,
    };
  }
  const _ap = getActiveProvider();
  res.render('admin/studio', {
    csrfToken:      getCsrfToken(req),
    tempId:         req.session.studio.tempId,
    aiProvider:     _ap,
    aiProviderName: PROVIDERS[_ap].name,
    aiModels:       PROVIDERS[_ap].models,
    hasAI:          hasActiveKey(),
    ...getLogos(),
  });
});

// GET /admin/studio — redirect to /admin/generate for backward compat
app.get('/admin/studio', requireAuth, (req, res) => {
  res.redirect(301, '/admin/generate');
});

// POST /admin/studio/restore — re-attach a previous temp folder after server restart
app.post('/admin/studio/restore', requireAuth, requireCsrf, (req, res) => {
  const { tempId, uploadedFiles = [], description = '' } = req.body;
  if (!tempId || !/^[a-f0-9-]{36}$/.test(tempId)) {
    return res.status(400).json({ error: 'Invalid session.' });
  }
  const dir = path.join(STUDIO_TEMP_BASE, tempId);
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'expired' });
  }
  // Discard the newly-created empty session folder, then restore the old one
  if (req.session.studio?.tempId && req.session.studio.tempId !== tempId) {
    discardStudioTemp(req.session.studio.tempId);
  }
  // Validate each file still exists on disk
  const validFiles = (Array.isArray(uploadedFiles) ? uploadedFiles : [])
    .filter(f => {
      if (!f?.filename || typeof f.filename !== 'string') return false;
      if (!/^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(f.filename)) return false;
      return fs.existsSync(path.join(dir, f.filename));
    })
    .slice(0, 50);

  req.session.studio = {
    tempId,
    uploadedFiles: validFiles,
    description:   typeof description === 'string' ? description.slice(0, 50000) : '',
    history:       [],
    currentProject: null,
  };
  res.json({ ok: true, uploadedFiles: validFiles });
});

// POST /admin/studio/upload — add one file (image or text) to the temp workspace
app.post('/admin/studio/upload', requireAuth, (req, res) => {
  if (!req.session.studio?.tempId) {
    return res.status(400).json({ error: 'No studio session. Reload the page.' });
  }
  studioUpload.single('image')(req, res, (err) => {
    if (err) {
      const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      return res.status(status).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const isImage = STUDIO_IMAGE_MIMES.has(req.file.mimetype);
    const entry = {
      filename:     req.file.filename,
      mimeType:     req.file.mimetype,
      originalName: req.file.originalname,
      fileType:     isImage ? 'image' : 'text',
    };
    req.session.studio.uploadedFiles.push(entry);
    res.json({
      ok: true,
      file: {
        filename:     entry.filename,
        originalName: entry.originalName,
        fileType:     entry.fileType,
        previewSrc:   isImage
          ? `/images/studio-temp/${req.session.studio.tempId}/${entry.filename}`
          : null,
      },
    });
  });
});

// POST /admin/studio/delete-upload — remove one image from the temp workspace
app.post('/admin/studio/delete-upload', requireAuth, requireCsrf, (req, res) => {
  const { filename } = req.body;
  const studio = req.session.studio;
  if (!studio || typeof filename !== 'string') return res.status(400).json({ error: 'Bad request.' });

  const idx = studio.uploadedFiles.findIndex(f => f.filename === filename);
  if (idx === -1) return res.status(404).json({ error: 'File not found.' });

  try {
    const filePath = safeStudioPath(studio.tempId, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }

  studio.uploadedFiles.splice(idx, 1);
  res.json({ ok: true });
});

// POST /admin/studio/update-tag — update a file's label and add it to LLM context
app.post('/admin/studio/update-tag', requireAuth, requireCsrf, (req, res) => {
  const studio = req.session.studio;
  if (!studio) return res.status(400).json({ error: 'No studio session.' });

  const { filename, tag } = req.body;
  if (typeof filename !== 'string' || typeof tag !== 'string') {
    return res.status(400).json({ error: 'Bad request.' });
  }

  const file = (studio.uploadedFiles || []).find(f => f.filename === filename);
  if (!file) return res.status(404).json({ error: 'File not found.' });

  file.tag = tag.slice(0, 80);

  // Append to LLM history so the label appears in future chat context
  if (studio.history?.length > 0 && tag.trim()) {
    studio.history.push({
      role: 'user',
      content: `I've labeled the file "${file.originalName || filename}" as "${tag.trim()}".`,
    });
    studio.history.push({
      role: 'assistant',
      content: JSON.stringify({
        message: `Noted — I've labeled "${file.originalName || filename}" as "${tag.trim()}". I'll keep this in mind for any future layout changes.`,
        regenerate: false,
      }),
    });
  }

  res.json({ ok: true });
});

// POST /admin/studio/generate — first LLM call; builds context with images
app.post('/admin/studio/generate', requireAuth, requireCsrf, async (req, res) => {
  const studio = req.session.studio;
  if (!studio) return res.status(400).json({ error: 'No studio session. Reload the page.' });

  const { description, modelTier = 'smart', tags = {} } = req.body;
  if (!description || description.trim().length < 10) {
    return res.status(400).json({ error: 'Please add a project description (at least 10 characters).' });
  }
  if (!hasActiveKey()) {
    return res.status(503).json({ error: 'AI not configured — add an API key in Settings.' });
  }

  try {
    const firstMsg = await buildFirstMessage(description.trim(), studio.uploadedFiles, studio.tempId, tags);
    const rawText  = await callAI({ messages: [firstMsg], tier: modelTier });
    const parsed   = extractJSON(rawText);

    // Support both {project, summary} (new) and legacy bare-project format
    let projectData, summary;
    if (parsed.project && typeof parsed.project === 'object') {
      projectData = parsed.project;
      summary     = parsed.summary || 'Project page generated.';
    } else {
      projectData = parsed;
      summary     = 'Project page generated.';
    }

    // Prepend temp paths to image srcs returned by LLM
    const tempId = studio.tempId;
    if (projectData.thumbnail) {
      projectData.thumbnail = `/images/studio-temp/${tempId}/${projectData.thumbnail}`;
    }
    projectData.sections = (projectData.sections || []).map(s => ({
      ...s,
      id: crypto.randomUUID(),
      images: (s.images || []).map(img => ({
        ...img,
        src: img.src ? `/images/studio-temp/${tempId}/${img.src}` : '',
      })),
    }));

    // Save state
    studio.description   = description.trim();
    studio.history       = [{ role: 'assistant', content: rawText }];
    studio.chatHistory   = [
      { role: 'user',      text: description.trim() },
      { role: 'assistant', text: summary },
    ];
    studio.currentProject = projectData;

    res.json({ ok: true, project: projectData, summary });
  } catch (err) {
    console.error('[studio/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/studio/refine — chat-mode: LLM decides whether to respond or regenerate
app.post('/admin/studio/refine', requireAuth, requireCsrf, async (req, res) => {
  const studio = req.session.studio;
  if (!studio?.currentProject) return res.status(400).json({ error: 'Generate a project first.' });

  const { feedback, modelTier = 'smart', tags = {}, editorImages, imageManifest, currentProject, chatAttachments } = req.body;
  if (!feedback || feedback.trim().length < 3) {
    return res.status(400).json({ error: 'Please enter a message.' });
  }

  if (currentProject && typeof currentProject === 'object' && Array.isArray(currentProject.sections)) {
    studio.currentProject = currentProject;
  }

  try {
    const messages = [];

    if (studio.editSlug && studio.currentProject) {
      // Edit mode: merge intro + full page state into the first user message so there
      // are never two consecutive user messages regardless of history length.
      const proj   = studio.currentProject;
      const imgMap = Object.fromEntries((imageManifest || []).map(i => [i.src, i.label]).filter(([k]) => k));
      let ctx  = `You are helping edit an existing portfolio project (slug: "${studio.editSlug}").\n`;
      ctx += `When regenerating, use the EXACT full src paths shown below for images — never bare filenames.\n\n`;
      ctx += `[Current page state — updated as of this message]\n`;
      ctx += `Title (homepage card): ${proj.title || ''}\n`;
      ctx += `Page title (H1): ${proj.pageTitle || ''}\n`;
      ctx += `Subtitle: ${proj.subtitle || ''}\n`;
      ctx += `Thumbnail: ${proj.thumbnail || '(none)'}\n\n`;
      for (const sec of (proj.sections || [])) {
        ctx += `Section: "${sec.heading || '(untitled)'}"\n`;
        if (sec.body) ctx += `  Body: ${sec.body}\n`;
        for (const img of (sec.images || [])) {
          const lbl = imgMap[img.src] || img.alt || '';
          ctx += `  Image: ${img.src}${lbl ? ` — "${lbl}"` : ''}\n`;
        }
      }
      if (imageManifest?.length) {
        ctx += `\nAll images available in this project's folder:\n`;
        ctx += imageManifest.map(i => `  ${i.src}${i.label ? ` — "${i.label}"` : ''}`).join('\n');
      }
      messages.push({ role: 'user',      content: ctx.trim() });
      messages.push({ role: 'assistant', content: 'Understood — I have the full current page state and am ready to help.' });
    } else {
      // Generate mode: send files/images as the first message
      const editorFiles = Array.isArray(editorImages)
        ? editorImages.filter(f => f.filename && validateImagePathPermissive(f.permanentPath)).map(f => ({
            ...f,
            permanentPath: path.join(__dirname, 'public', validateImagePathPermissive(f.permanentPath).replace(/^\//, '')),
            fileType: 'image',
            mimeType: 'image/jpeg',
          }))
        : [];
      const effectiveFiles = [...studio.uploadedFiles, ...editorFiles];
      messages.push(await buildFirstMessage(studio.description, effectiveFiles, studio.tempId, tags));
    }

    // Replay conversation history
    for (const h of studio.history) {
      messages.push({ role: h.role, content: h.content });
    }

    // Build the final user turn — may include client-side file attachments (never saved server-side)
    const userBlocks = [];
    for (const att of (chatAttachments || [])) {
      if (att.type === 'image' && att.data && att.mediaType) {
        userBlocks.push({ type: 'text', text: `Attached image: ${att.name}` });
        userBlocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
      } else if (att.type === 'text' && att.data) {
        userBlocks.push({ type: 'text', text: `--- Attached file: ${att.name} ---\n${String(att.data).slice(0, 50000)}\n---` });
      }
    }
    userBlocks.push({ type: 'text', text: feedback.trim() });
    messages.push({ role: 'user', content: userBlocks.length === 1 ? userBlocks[0].text : userBlocks });

    if (!hasActiveKey()) return res.status(503).json({ error: 'AI not configured — add an API key in Settings.' });
    const rawText = await callAI({ messages, systemPrompt: STUDIO_REFINE_PROMPT, tier: modelTier });
    const parsed  = extractJSON(rawText);

    const { message = '', regenerate = false, project: projectData } = parsed;

    studio.history.push({ role: 'user',      content: feedback.trim() });
    studio.history.push({ role: 'assistant', content: rawText });
    studio.chatHistory = studio.chatHistory || [];
    studio.chatHistory.push({ role: 'user',      text: feedback.trim() });
    studio.chatHistory.push({ role: 'assistant', text: message });

    if (regenerate && projectData && typeof projectData === 'object') {
      if (studio.editSlug) {
        // Edit mode: resolve any bare filenames to full paths using the image manifest;
        // never prepend studio-temp (images are already in the permanent project folder).
        const byFilename = {};
        for (const img of (imageManifest || [])) {
          if (img.filename && img.src) byFilename[img.filename] = img.src;
        }
        const resolveImgSrc = src => {
          if (!src) return '';
          if (src.startsWith('/')) return src;      // already a full path
          return byFilename[src] || src;             // filename → full path via manifest
        };
        if (projectData.thumbnail) projectData.thumbnail = resolveImgSrc(projectData.thumbnail);
        projectData.sections = (projectData.sections || []).map(s => ({
          ...s,
          id: s.id || crypto.randomUUID(),
          images: (s.images || []).map(img => ({ ...img, src: resolveImgSrc(img.src) })),
        }));
      } else {
        // Generate mode: prefix bare filenames with the studio-temp path
        const tempId = studio.tempId;
        if (projectData.thumbnail) {
          projectData.thumbnail = `/images/studio-temp/${tempId}/${projectData.thumbnail}`;
        }
        projectData.sections = (projectData.sections || []).map(s => ({
          ...s,
          id: s.id || crypto.randomUUID(),
          images: (s.images || []).map(img => ({
            ...img,
            src: img.src ? `/images/studio-temp/${tempId}/${img.src}` : '',
          })),
        }));
      }
      studio.currentProject = projectData;
      return res.json({ ok: true, message, regenerate: true, project: projectData });
    }

    res.json({ ok: true, message, regenerate: false });
  } catch (err) {
    console.error('[studio/refine]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/studio/preview-page — render project page in iframe (overrides frameAncestors)
app.get('/admin/studio/preview-page', requireAuth, (req, res) => {
  const project = req.session.studio?.currentProject;
  if (!project) {
    return res.status(200).send('<!DOCTYPE html><html><body style="font-family:sans-serif;color:#888;padding:3rem;text-align:center"><p>Loading preview…</p></body></html>');
  }
  if (!Array.isArray(project.sections)) project.sections = [];
  // Override the global frameAncestors:'none' so the admin studio can iframe this page
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "script-src 'self'; " +
    "form-action 'none'; " +
    "frame-ancestors 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.render('project', { project });
});

// POST /admin/studio/preview — render just the project body partial (used by AI chat flow)
app.post('/admin/studio/preview', requireAuth, (req, res) => {
  const project = req.body.project || req.session.studio?.currentProject;
  if (!project) return res.status(404).json({ error: 'No project to preview.' });
  if (!Array.isArray(project.sections)) project.sections = [];

  const ejs = require('ejs');
  ejs.renderFile(
    path.join(__dirname, 'views/partials/project-body.ejs'),
    { project },
    { views: path.join(__dirname, 'views') },
    (err, html) => {
      if (err) {
        console.error('[studio/preview]', err);
        return res.status(500).json({ error: 'Could not render preview.' });
      }
      res.json({ html });
    }
  );
});

// POST /admin/studio/publish — save to DB, move images to permanent location
app.post('/admin/studio/publish', requireAuth, requireCsrf, (req, res) => {
  const studio = req.session.studio;
  if (!studio?.currentProject) return res.status(400).json({ error: 'Nothing to publish.' });

  const rawSlug = (req.body.slug || studio.currentProject.slug || '').trim();
  const slug    = sanitizeSlug(rawSlug);
  if (!slug) return res.status(400).json({ error: 'A valid slug is required.' });

  const projects = loadProjects();
  if (projects.find(p => p.slug === slug)) {
    return res.status(409).json({ error: `A project with slug "${slug}" already exists.` });
  }

  // Move images from temp to permanent location
  const destDir = path.join(IMAGES_BASE, slug);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* exists */ }

  let project = JSON.parse(JSON.stringify(studio.currentProject)); // deep copy

  const moveImage = (src) => {
    if (!src || !src.includes('studio-temp')) return src;
    const filename = path.basename(src);
    const srcPath  = path.join(STUDIO_TEMP_BASE, studio.tempId, filename);
    const dstPath  = path.join(destDir, filename);
    try {
      if (fs.existsSync(srcPath)) fs.renameSync(srcPath, dstPath);
    } catch { /* file may already be moved */ }
    return `/images/projects/${slug}/${filename}`;
  };

  if (project.thumbnail) project.thumbnail = moveImage(project.thumbnail);
  project.sections = (project.sections || []).map(s => ({
    ...s,
    images: (s.images || []).map(img => ({ ...img, src: moveImage(img.src) })),
  }));

  // Sanitize and save
  const reqTitle  = (req.body.title || '').trim();
  const maxOrder  = projects.reduce((m, p) => Math.max(m, p.order ?? 0), -1);
  const newProject = {
    slug,
    title:        (reqTitle || project.title || '').slice(0, 200),
    subtitle:     (project.subtitle     || '').slice(0, 300),
    pageTitle:    (project.pageTitle    || '').slice(0, 200),
    thumbnail:    validateImagePath(project.thumbnail),
    thumbnailAlt: (project.thumbnailAlt || '').slice(0, 200),
    order:        maxOrder + 1,
    visible:      true,
    sections:     sanitizeSections(project.sections),
  };

  projects.push(newProject);
  saveProjects(projects);

  // Clean up temp folder
  discardStudioTemp(studio.tempId);
  delete req.session.studio;

  res.json({ ok: true, slug });
});

// POST /admin/studio/save-draft — same as publish but visible: false
app.post('/admin/studio/save-draft', requireAuth, requireCsrf, (req, res) => {
  const studio = req.session.studio;
  if (!studio?.currentProject) return res.status(400).json({ error: 'Nothing to save.' });

  const rawSlug = (req.body.slug || studio.currentProject.slug || '').trim();
  const slug    = sanitizeSlug(rawSlug);
  if (!slug) return res.status(400).json({ error: 'A valid slug is required.' });

  const projects = loadProjects();
  if (projects.find(p => p.slug === slug)) {
    return res.status(409).json({ error: `A project with slug "${slug}" already exists.` });
  }

  const destDir = path.join(IMAGES_BASE, slug);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* exists */ }

  let project = JSON.parse(JSON.stringify(studio.currentProject));

  const moveImage = (src) => {
    if (!src || !src.includes('studio-temp')) return src;
    const filename = path.basename(src);
    const srcPath  = path.join(STUDIO_TEMP_BASE, studio.tempId, filename);
    const dstPath  = path.join(destDir, filename);
    try { if (fs.existsSync(srcPath)) fs.renameSync(srcPath, dstPath); } catch {}
    return `/images/projects/${slug}/${filename}`;
  };

  if (project.thumbnail) project.thumbnail = moveImage(project.thumbnail);
  project.sections = (project.sections || []).map(s => ({
    ...s,
    images: (s.images || []).map(img => ({ ...img, src: moveImage(img.src) })),
  }));

  const reqTitle = (req.body.title || '').trim();
  const maxOrder = projects.reduce((m, p) => Math.max(m, p.order ?? 0), -1);
  const draft = {
    slug,
    title:        (reqTitle || project.title || '').slice(0, 200),
    subtitle:     (project.subtitle     || '').slice(0, 300),
    pageTitle:    (project.pageTitle    || '').slice(0, 200),
    thumbnail:    validateImagePath(project.thumbnail),
    thumbnailAlt: (project.thumbnailAlt || '').slice(0, 200),
    order:        maxOrder + 1,
    visible:      false,
    sections:     sanitizeSections(project.sections),
  };

  projects.push(draft);
  saveProjects(projects);

  discardStudioTemp(studio.tempId);
  delete req.session.studio;
  res.json({ ok: true, slug });
});

// POST /admin/studio/discard — clean up and go back to dashboard
app.post('/admin/studio/discard', requireAuth, requireCsrf, (req, res) => {
  discardStudioTemp(req.session.studio?.tempId);
  delete req.session.studio;
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API  (bearer-token auth — no session, no CSRF)
// ═══════════════════════════════════════════════════════════════════════════════
// Set API_KEY in .env to enable. Callers send:  Authorization: Bearer <key>
// All endpoints return JSON.

function requireApiKey(req, res, next) {
  if (!process.env.API_KEY) {
    return res.status(503).json({ error: 'API not configured. Add API_KEY to .env.' });
  }
  const auth = req.headers['authorization'] || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  recordVisit(req, 'api');
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI SANDBOX API  (public, session-isolated, no auth required)
// ═══════════════════════════════════════════════════════════════════════════════

const SANDBOX_SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.get('/sandbox', (req, res) => {
  // Generate a fresh session ID server-side so the iframe src is set in HTML
  // immediately — no waiting for JavaScript.
  const sid = crypto.randomBytes(16).toString('hex').replace(
    /^(.{8})(.{4})(4.{3})(.{3})(.{12})$/,
    '$1-$2-$3-$4-$5'
  ) || `${Date.now()}-${Math.random()}`;
  // Use a proper v4 UUID
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const sandboxSid = [
    bytes.slice(0,4).toString('hex'),
    bytes.slice(4,6).toString('hex'),
    bytes.slice(6,8).toString('hex'),
    bytes.slice(8,10).toString('hex'),
    bytes.slice(10,16).toString('hex'),
  ].join('-');
  // Optionally pre-load a saved style into the session (from admin "Load in Sandbox")
  let loadStyleId   = null;
  let loadStyleName = null;
  const rawStyleId  = parseInt(req.query.load_style, 10);
  if (rawStyleId) {
    const saved = db.prepare('SELECT id, name, config FROM sandbox_styles WHERE id = ?').get(rawStyleId);
    if (saved) {
      db.prepare('INSERT INTO sandbox_sessions (session_id, config) VALUES (?, ?)').run(sandboxSid, saved.config);
      loadStyleId   = saved.id;
      loadStyleName = saved.name;
    }
  }
  if (!loadStyleId) getSandboxSession(sandboxSid); // default config

  res.setHeader('Cache-Control', 'no-store');
  // Allow inline <style> and <script> on the sandbox shell page.
  // The global Helmet CSP blocks them; this override permits them for /sandbox only.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  res.render('sandbox', { sandboxSid, loadStyleId, loadStyleName, hasAI: hasActiveKey() });
});

app.get('/sandbox/preview', (req, res) => {
  const { sid } = req.query;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).send('Invalid session ID.');

  // Allow this page to be embedded in an iframe from the same origin
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "script-src 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  const config = JSON.parse(getSandboxSession(sid));
  const sandboxCss = buildSandboxPreviewCSS(config);
  const projects = db.prepare(
    'SELECT slug, title, subtitle, thumbnail, thumbnailAlt FROM projects WHERE visible = 1 ORDER BY sort_order ASC'
  ).all();

  // Build safe text overrides for the template
  function escHtmlLocal(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  const t = config.text || {};
  const sandboxHeroName = t.heroName
    ? t.heroName.split('\n').map(escHtmlLocal).join('<br>')
    : null;
  const sandboxHeroTagline = t.heroTagline || null;

  res.render('sandbox-preview', { projects, sandboxCss, sandboxHeroName, sandboxHeroTagline, ...getLogos() });
});

// Sandbox preview for individual project pages — same-origin iframe, sandbox CSS injected inline
app.get('/sandbox/preview/project/:slug', (req, res) => {
  const { sid } = req.query;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).send('Invalid session ID.');

  const slug = sanitizeSlug(req.params.slug);
  const project = loadProjects().find(p => p.slug === slug);
  if (!project) return res.status(404).send('Project not found.');

  const config = JSON.parse(getSandboxSession(sid));
  const sandboxCss = buildSandboxPreviewCSS(config, slug);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "script-src 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.render('project', { project, sandboxCss, ...getLogos() });
});

app.get('/api/sandbox/data', (req, res) => {
  const projects = db.prepare(
    'SELECT slug, title, subtitle, thumbnail, thumbnailAlt FROM projects WHERE visible = 1 ORDER BY sort_order ASC'
  ).all();
  res.json({
    settings: {
      site_name: 'lucas iezzi',
      tagline: 'product designer and creative engineer',
      logo_image: null,
    },
    projects,
  });
});

app.get('/api/sandbox/config', (req, res) => {
  const { sid } = req.query;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });
  const session = db.prepare('SELECT config, reference_html FROM sandbox_sessions WHERE session_id = ?').get(sid);
  if (!session) {
    const def = JSON.stringify(SANDBOX_DEFAULT_CONFIG);
    db.prepare('INSERT INTO sandbox_sessions (session_id, config) VALUES (?, ?)').run(sid, def);
    return res.json({ config: SANDBOX_DEFAULT_CONFIG, undoCount: 0, redoCount: 0, hasReference: false });
  }
  res.json({
    config:       JSON.parse(session.config),
    undoCount:    sandboxUndoCount(sid),
    redoCount:    sandboxRedoCount(sid),
    hasReference: !!session.reference_html,
  });
});

app.post('/api/sandbox/prompt', sandboxPromptLimiter, async (req, res) => {
  const { sid, instruction, currentPage } = req.body;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });
  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
    return res.status(400).json({ error: 'Instruction is required.' });
  }
  const safePage = (typeof currentPage === 'string' && /^(homepage|project:[a-z0-9-]{1,80})$/.test(currentPage))
    ? currentPage : 'homepage';
  if (!hasActiveKey()) {
    return res.status(503).json({ error: 'AI not configured — add an API key in Settings.' });
  }

  const currentJson = getSandboxSession(sid);
  const currentConfig = JSON.parse(currentJson);
  const session = db.prepare('SELECT reference_html FROM sandbox_sessions WHERE session_id = ?').get(sid);
  let referenceHtml = null;
  if (session?.reference_html) {
    try { referenceHtml = JSON.parse(session.reference_html).html; } catch { /* ignore */ }
  }

  try {
    let userContent = `Current config:\n${JSON.stringify(currentConfig, null, 2)}\n\nCurrent page: ${safePage}\n\nUser request: "${instruction.trim().slice(0, 500)}"`;
    if (referenceHtml) {
      userContent = `Reference HTML (use as design inspiration — match its visual style/layout):\n${referenceHtml.slice(0, 6000)}\n\n---\n\n${userContent}`;
    }

    const rawText = await callAI({
      messages: [{ role: 'user', content: userContent }],
      systemPrompt: SANDBOX_SYSTEM_PROMPT,
      tier: 'fast',
    });

    // Parse response — new format: { ops, applied, explanation }; legacy fallback: raw array
    let ops = [], aiApplied = [], explanation = null;
    try {
      const parsed = JSON.parse(rawText.trim());
      if (Array.isArray(parsed)) {
        ops = parsed;
      } else if (parsed && typeof parsed === 'object') {
        ops         = Array.isArray(parsed.ops)      ? parsed.ops      : [];
        aiApplied   = Array.isArray(parsed.applied)  ? parsed.applied  : [];
        explanation = typeof parsed.explanation === 'string' && parsed.explanation ? parsed.explanation : null;
      }
    } catch {
      const match = rawText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match) {
        try {
          const p = JSON.parse(match[0]);
          if (Array.isArray(p)) { ops = p; }
          else if (p && typeof p === 'object') {
            ops = Array.isArray(p.ops) ? p.ops : [];
            aiApplied = Array.isArray(p.applied) ? p.applied : [];
            explanation = typeof p.explanation === 'string' && p.explanation ? p.explanation : null;
          }
        } catch { /* ignore */ }
      }
    }

    const newConfig = JSON.parse(JSON.stringify(currentConfig));
    // Ensure new fields exist on old configs loaded from DB
    if (!newConfig.text) newConfig.text = { heroTagline: '', heroName: '' };
    if (typeof newConfig.customCSS !== 'string') newConfig.customCSS = '';

    const validatedPaths = [];
    for (const op of ops) {
      if (validateSandboxOp(op)) {
        applySandboxOp(newConfig, op);
        validatedPaths.push(op.path);
      }
    }

    const applied = aiApplied.length > 0 ? aiApplied : validatedPaths;

    // Only push to undo stack if something actually changed
    if (validatedPaths.length > 0) {
      db.prepare('INSERT INTO sandbox_revisions (session_id, config, instruction) VALUES (?, ?, ?)').run(
        sid, currentJson, instruction.trim().slice(0, 500)
      );
      db.prepare('DELETE FROM sandbox_redo WHERE session_id = ?').run(sid);
      db.prepare("UPDATE sandbox_sessions SET config = ?, updated_at = datetime('now') WHERE session_id = ?").run(
        JSON.stringify(newConfig), sid
      );
    }

    res.json({
      config:      newConfig,
      applied,
      explanation,
      undoCount:   validatedPaths.length > 0 ? sandboxUndoCount(sid) : sandboxUndoCount(sid),
      redoCount:   validatedPaths.length > 0 ? 0 : sandboxRedoCount(sid),
    });
  } catch (err) {
    console.error('[sandbox/prompt]', err.message);
    res.status(500).json({ error: err.message || 'AI request failed.' });
  }
});

app.post('/api/sandbox/undo', (req, res) => {
  const { sid } = req.body;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });

  const revision = db.prepare(
    'SELECT id, config FROM sandbox_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sid);
  if (!revision) return res.status(400).json({ error: 'Nothing to undo.' });

  // Push current state to redo stack before restoring
  const currentJson = getSandboxSession(sid);
  db.prepare('INSERT INTO sandbox_redo (session_id, config) VALUES (?, ?)').run(sid, currentJson);

  db.prepare("UPDATE sandbox_sessions SET config = ?, updated_at = datetime('now') WHERE session_id = ?").run(
    revision.config, sid
  );
  db.prepare('DELETE FROM sandbox_revisions WHERE id = ?').run(revision.id);

  res.json({ config: JSON.parse(revision.config), undoCount: sandboxUndoCount(sid), redoCount: sandboxRedoCount(sid) });
});

app.post('/api/sandbox/redo', (req, res) => {
  const { sid } = req.body;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });

  const redoRow = db.prepare(
    'SELECT id, config FROM sandbox_redo WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sid);
  if (!redoRow) return res.status(400).json({ error: 'Nothing to redo.' });

  // Push current state to undo stack before redoing
  const currentJson = getSandboxSession(sid);
  db.prepare('INSERT INTO sandbox_revisions (session_id, config, instruction) VALUES (?, ?, ?)').run(sid, currentJson, '[redo]');

  db.prepare("UPDATE sandbox_sessions SET config = ?, updated_at = datetime('now') WHERE session_id = ?").run(
    redoRow.config, sid
  );
  db.prepare('DELETE FROM sandbox_redo WHERE id = ?').run(redoRow.id);

  res.json({ config: JSON.parse(redoRow.config), undoCount: sandboxUndoCount(sid), redoCount: sandboxRedoCount(sid) });
});

app.post('/api/sandbox/reset', (req, res) => {
  const { sid } = req.body;
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });

  const def = JSON.stringify(SANDBOX_DEFAULT_CONFIG);
  db.prepare('INSERT OR REPLACE INTO sandbox_sessions (session_id, config) VALUES (?, ?)').run(sid, def);
  db.prepare('DELETE FROM sandbox_revisions WHERE session_id = ?').run(sid);
  db.prepare('DELETE FROM sandbox_redo WHERE session_id = ?').run(sid);

  res.json({ config: SANDBOX_DEFAULT_CONFIG, undoCount: 0, redoCount: 0 });
});

// ── Saved styles ───────────────────────────────────────────────────

app.get('/api/sandbox/styles', (req, res) => {
  const styles = db.prepare('SELECT id, name, is_active, updated_at FROM sandbox_styles ORDER BY updated_at DESC').all();
  res.json({ styles });
});

app.get('/api/sandbox/styles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const style = db.prepare('SELECT id, name, config, is_active FROM sandbox_styles WHERE id = ?').get(id);
  if (!style) return res.status(404).json({ error: 'Style not found.' });
  res.json({ style: { ...style, config: JSON.parse(style.config) } });
});

app.post('/api/sandbox/styles', (req, res) => {
  const { name, sid } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });
  const config = getSandboxSession(sid);
  const result = db.prepare("INSERT INTO sandbox_styles (name, config) VALUES (?, ?)").run(name.trim().slice(0, 80), config);
  res.json({ id: result.lastInsertRowid, name: name.trim() });
});

app.patch('/api/sandbox/styles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const style = db.prepare('SELECT id FROM sandbox_styles WHERE id = ?').get(id);
  if (!style) return res.status(404).json({ error: 'Style not found.' });

  const { name, sid } = req.body;
  if (name && typeof name === 'string' && name.trim()) {
    db.prepare("UPDATE sandbox_styles SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name.trim().slice(0, 80), id);
  }
  if (sid && SANDBOX_SID_RE.test(sid)) {
    const config = getSandboxSession(sid);
    db.prepare("UPDATE sandbox_styles SET config = ?, updated_at = datetime('now') WHERE id = ?").run(config, id);
  }
  res.json({ ok: true });
});

app.delete('/api/sandbox/styles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM sandbox_styles WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Admin-only: activate a saved style on the live site
app.post('/admin/sandbox/styles/:id/activate', requireAuth, requireCsrf, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const style = db.prepare('SELECT id FROM sandbox_styles WHERE id = ?').get(id);
  if (!style) return res.status(404).json({ error: 'Style not found.' });
  db.prepare('UPDATE sandbox_styles SET is_active = 0').run();
  db.prepare("UPDATE sandbox_styles SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.post('/admin/sandbox/styles/deactivate', requireAuth, requireCsrf, (req, res) => {
  db.prepare('UPDATE sandbox_styles SET is_active = 0').run();
  res.json({ ok: true });
});

// ── Import Style (URL + image + HTML/CSS file) ────────────────────

app.post('/api/sandbox/match-style',
  matchStyleLimiter,
  importStyleUpload.fields([{ name: 'imageFile', maxCount: 1 }, { name: 'htmlFile', maxCount: 1 }]),
  async (req, res) => {
  const { sid, url } = req.body;
  const imageFile = req.files?.imageFile?.[0];
  const htmlFile  = req.files?.htmlFile?.[0];

  if (!sid || !SANDBOX_SID_RE.test(sid)) return res.status(400).json({ error: 'Invalid session ID.' });
  if (!hasActiveKey()) return res.status(503).json({ error: 'AI not configured — add an API key in Settings.' });

  const hasUrl      = !!(url && typeof url === 'string' && url.trim());
  const hasImage    = !!imageFile;
  const hasHtmlFile = !!htmlFile;

  if (!hasUrl && !hasImage && !hasHtmlFile) {
    return res.status(400).json({ error: 'Provide at least one input: a URL, an image, or an HTML/CSS file.' });
  }

  const contextParts = [];
  let labelForHistory = 'import';

  // ── URL: fetch HTML + linked CSS ──────────────────────────────
  if (hasUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('bad protocol');
      if (isPrivateHost(parsedUrl.hostname)) return res.status(400).json({ error: 'Private or local URLs are not allowed.' });
    } catch {
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    labelForHistory = parsedUrl.hostname;
    let html = '';
    try {
      const resp = await fetch(parsedUrl.href, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      if (!resp.ok) return res.status(400).json({ error: `Could not fetch page: HTTP ${resp.status}.` });
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('html')) return res.status(400).json({ error: 'URL did not return an HTML page.' });
      html = (await resp.text()).slice(0, 300000);
    } catch (e) {
      return res.status(400).json({ error: 'Failed to fetch URL: ' + e.message });
    }

    const inlineCss = extractInlineCss(html);
    const cssHrefs = extractCssLinkHrefs(html, parsedUrl.href);
    const fetchedCssChunks = [];
    for (const href of cssHrefs.slice(0, 3)) {
      try {
        const cssUrl = new URL(href);
        if (isPrivateHost(cssUrl.hostname)) continue;
        const cssResp = await fetch(href, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioStyleBot/1.0)' },
          signal: AbortSignal.timeout(8000),
        });
        if (cssResp.ok) {
          let cssText = await cssResp.text();
          cssText = cssText.replace(/url\(['"]?data:[^)]{0,200}[^)]*['"]?\)/gi, 'url(data:/* removed */)');
          fetchedCssChunks.push(cssText.slice(0, 25000));
        }
      } catch { /* skip */ }
    }

    const allCss = [inlineCss, ...fetchedCssChunks].join('\n/* --- */\n').slice(0, 80000);
    const pageText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

    contextParts.push(
      `Reference website: ${parsedUrl.href}\n\n` +
      `CSS from ${parsedUrl.href}:\n\`\`\`css\n${allCss || '(no CSS found)'}\n\`\`\`\n\n` +
      `Page text:\n${pageText}`
    );
  }

  // ── HTML/CSS file: extract CSS ────────────────────────────────
  if (hasHtmlFile) {
    if (labelForHistory === 'import') labelForHistory = htmlFile.originalname;
    const fileText = htmlFile.buffer.toString('utf8').slice(0, 300000);
    const isHtmlFile = /\.html?$/i.test(htmlFile.originalname) || fileText.trimStart().startsWith('<');
    let fileCss = isHtmlFile ? extractInlineCss(fileText) : fileText;
    fileCss = fileCss.replace(/url\(['"]?data:[^)]{0,200}[^)]*['"]?\)/gi, 'url(data:/* removed */)').slice(0, 80000);
    contextParts.push(
      `CSS from uploaded ${isHtmlFile ? 'HTML' : 'CSS'} file (${htmlFile.originalname}):\n\`\`\`css\n${fileCss}\n\`\`\``
    );
  }

  // ── Build LLM message (multimodal if image provided) ─────────
  const currentJson = getSandboxSession(sid);
  const currentConfig = JSON.parse(currentJson);

  const textPrompt =
    (contextParts.length > 0 ? contextParts.join('\n\n---\n\n') + '\n\n' : '') +
    `Current portfolio config:\n${JSON.stringify(currentConfig, null, 2)}\n\n` +
    `Translate this design's visual style into the portfolio configuration.`;

  let messages;
  if (hasImage) {
    if (labelForHistory === 'import') labelForHistory = 'image';
    const mimeType = IMPORT_IMAGE_MIMES.has(imageFile.mimetype) ? imageFile.mimetype : 'image/png';
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageFile.buffer.toString('base64') } },
        { type: 'text', text: textPrompt },
      ],
    }];
  } else {
    messages = [{ role: 'user', content: textPrompt }];
  }

  try {
    const rawText = await callAI({ messages, systemPrompt: MATCH_STYLE_SYSTEM_PROMPT, tier: 'smart' });

    let ops = [], aiApplied = [], explanation = null;
    try {
      const parsed = JSON.parse(rawText.trim());
      ops         = Array.isArray(parsed.ops)     ? parsed.ops     : [];
      aiApplied   = Array.isArray(parsed.applied) ? parsed.applied : [];
      explanation = typeof parsed.explanation === 'string' && parsed.explanation ? parsed.explanation : null;
    } catch {
      const m = rawText.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const p = JSON.parse(m[0]);
          ops         = Array.isArray(p.ops)     ? p.ops     : [];
          aiApplied   = Array.isArray(p.applied) ? p.applied : [];
          explanation = typeof p.explanation === 'string' && p.explanation ? p.explanation : null;
        } catch {}
      }
    }

    const newConfig = JSON.parse(JSON.stringify(currentConfig));
    if (!newConfig.text) newConfig.text = { heroTagline: '', heroName: '' };
    if (typeof newConfig.customCSS !== 'string') newConfig.customCSS = '';

    const validatedPaths = [];
    for (const op of ops) {
      if (validateSandboxOp(op)) {
        applySandboxOp(newConfig, op);
        validatedPaths.push(op.path);
      }
    }

    if (validatedPaths.length > 0) {
      db.prepare('INSERT INTO sandbox_revisions (session_id, config, instruction) VALUES (?, ?, ?)').run(
        sid, currentJson, `[import-style: ${labelForHistory}]`
      );
      db.prepare('DELETE FROM sandbox_redo WHERE session_id = ?').run(sid);
      db.prepare("UPDATE sandbox_sessions SET config = ?, updated_at = datetime('now') WHERE session_id = ?").run(
        JSON.stringify(newConfig), sid
      );

      // ── Verification pass: check colors against the reference ────
      try {
        const verifyText =
          (contextParts.length > 0 ? contextParts.join('\n\n---\n\n') + '\n\n' : '') +
          `Applied color tokens:\n${JSON.stringify(newConfig.tokens, null, 2)}\n\n` +
          `Verify these tokens accurately match the reference colors and correct any that are wrong.`;

        let verifyMessages;
        if (hasImage) {
          const mimeType = IMPORT_IMAGE_MIMES.has(imageFile.mimetype) ? imageFile.mimetype : 'image/png';
          verifyMessages = [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageFile.buffer.toString('base64') } },
              { type: 'text', text: verifyText },
            ],
          }];
        } else {
          verifyMessages = [{ role: 'user', content: verifyText }];
        }

        const verifyRaw = await callAI({ messages: verifyMessages, systemPrompt: VERIFY_STYLE_SYSTEM_PROMPT, tier: 'smart' });
        let verifyOps = [], verifyApplied = [];
        try {
          const vp = JSON.parse(verifyRaw.trim());
          verifyOps     = Array.isArray(vp.ops)     ? vp.ops     : [];
          verifyApplied = Array.isArray(vp.applied) ? vp.applied : [];
        } catch {
          const vm = verifyRaw.match(/\{[\s\S]*\}/);
          if (vm) { try { const vp = JSON.parse(vm[0]); verifyOps = vp.ops || []; verifyApplied = vp.applied || []; } catch {} }
        }

        let corrected = false;
        for (const op of verifyOps) {
          if (validateSandboxOp(op) && op.path && op.path.startsWith('tokens.')) {
            applySandboxOp(newConfig, op);
            corrected = true;
          }
        }
        if (corrected) {
          db.prepare("UPDATE sandbox_sessions SET config = ?, updated_at = datetime('now') WHERE session_id = ?").run(
            JSON.stringify(newConfig), sid
          );
          if (verifyApplied.length > 0) aiApplied = [...(aiApplied.length > 0 ? aiApplied : validatedPaths), ...verifyApplied];
        }
      } catch { /* verification pass failing silently is acceptable */ }
    }

    const applied = aiApplied.length > 0 ? aiApplied : validatedPaths;
    res.json({
      applied,
      explanation,
      undoCount: sandboxUndoCount(sid),
      redoCount: validatedPaths.length > 0 ? 0 : sandboxRedoCount(sid),
    });
  } catch (err) {
    console.error('[sandbox/import-style]', err.message);
    res.status(500).json({ error: 'Style import failed: ' + err.message });
  }
});

// Deploy assistant — run arbitrary SSH command (AI-suggested, user-confirmed)
app.post('/admin/deploy/ssh-exec', requireAuth, requireCsrf, requireLocal, (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'command required.' });
  }
  const srv = readServerConfig().server;
  if (!srv || !srv.host) return res.status(400).json({ error: 'No server configured.' });
  const result = sshExec(srv, command.trim().slice(0, 2000), 30000);
  res.json({ ok: result.ok, output: [result.stdout, result.stderr].filter(Boolean).join('\n') });
});

// Deploy assistant chat
app.post('/api/admin/deploy-chat', requireAuth, requireCsrf, async (req, res) => {
  const { message, history } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (!hasActiveKey()) {
    return res.status(503).json({ error: 'AI not configured — add an API key in Settings.' });
  }

  const msgs = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-20)) {
      if ((h.role === 'user' || h.role === 'assistant') && h.content) {
        msgs.push({ role: h.role, content: String(h.content).slice(0, 4000) });
      }
    }
  }
  msgs.push({ role: 'user', content: message.trim().slice(0, 1000) });

  try {
    const reply = await callAI({
      messages: msgs,
      systemPrompt: DEPLOY_ASSISTANT_PROMPT,
      tier: 'fast',
    });
    res.json({ reply });
  } catch (err) {
    console.error('[deploy-chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API  (bearer-token auth)
// ═══════════════════════════════════════════════════════════════════════════════

// List all projects
app.get('/api/v1/projects', requireApiKey, (req, res) => {
  res.json(sortedProjects());
});

// Get one project
app.get('/api/v1/projects/:slug', requireApiKey, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const project = sortedProjects().find(p => p.slug === slug);
  if (!project) return res.status(404).json({ error: 'Not found.' });
  res.json(project);
});

// Create project
app.post('/api/v1/projects', requireApiKey, (req, res) => {
  const raw      = req.body;
  const slug     = sanitizeSlug(raw.slug || raw.title || '');
  if (!slug) return res.status(400).json({ error: 'slug or title required.' });
  const projects = loadProjects();
  if (projects.find(p => p.slug === slug)) {
    return res.status(409).json({ error: 'Project already exists.' });
  }
  const maxOrder = projects.reduce((m, p) => Math.max(m, p.order ?? 0), -1);
  const project  = {
    slug,
    title:        (raw.title        || '').slice(0, 200),
    subtitle:     (raw.subtitle     || '').slice(0, 300),
    pageTitle:    (raw.pageTitle    || '').slice(0, 200),
    thumbnail:    validateImagePath(raw.thumbnail),
    thumbnailAlt: (raw.thumbnailAlt || raw.title || '').slice(0, 200),
    order:        typeof raw.order === 'number' ? raw.order : maxOrder + 1,
    sections:     sanitizeSections(raw.sections),
  };
  projects.push(project);
  saveProjects(projects);
  res.status(201).json(project);
});

// Partial update — only supplied fields are changed
app.patch('/api/v1/projects/:slug', requireApiKey, (req, res) => {
  const slug     = sanitizeSlug(req.params.slug);
  const projects = loadProjects();
  const idx      = projects.findIndex(p => p.slug === slug);
  if (idx === -1) return res.status(404).json({ error: 'Not found.' });

  const raw = req.body;
  const p   = projects[idx];
  if (raw.title        !== undefined) p.title        = (raw.title        || '').slice(0, 200);
  if (raw.subtitle     !== undefined) p.subtitle     = (raw.subtitle     || '').slice(0, 300);
  if (raw.pageTitle    !== undefined) p.pageTitle    = (raw.pageTitle    || '').slice(0, 200);
  if (raw.thumbnail    !== undefined) p.thumbnail    = validateImagePath(raw.thumbnail);
  if (raw.thumbnailAlt !== undefined) p.thumbnailAlt = (raw.thumbnailAlt || '').slice(0, 200);
  if (raw.order !== undefined && typeof raw.order === 'number') p.order = raw.order;
  if (raw.sections     !== undefined) p.sections     = sanitizeSections(raw.sections);

  projects[idx] = p;
  saveProjects(projects);
  res.json(p);
});

// Delete project
app.delete('/api/v1/projects/:slug', requireApiKey, (req, res) => {
  const slug     = sanitizeSlug(req.params.slug);
  let projects   = loadProjects();
  const before   = projects.length;
  projects       = projects.filter(p => p.slug !== slug);
  if (projects.length === before) return res.status(404).json({ error: 'Not found.' });
  projects.forEach((p, i) => { p.order = i; });
  saveProjects(projects);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// Only accept image paths that are within /images/projects/
function validateImagePath(p) {
  if (!p || typeof p !== 'string') return '';
  const clean = p.trim();
  if (/^\/images\/projects\/[a-z0-9-]+\/[a-z0-9_.()+-]+\.(jpg|jpeg|png|gif|webp)$/i.test(clean)) {
    return clean;
  }
  return '';
}

// Like validateImagePath but also accepts studio-temp paths (used for drafts so
// in-progress images are not stripped before they've been moved to permanent storage).
function validateImagePathPermissive(p) {
  if (!p || typeof p !== 'string') return '';
  const clean = p.trim();
  if (validateImagePath(clean)) return clean;
  if (/^\/images\/studio-temp\/[a-f0-9-]{36}\/[a-z0-9_.()+-]+\.(jpg|jpeg|png|gif|webp)$/i.test(clean)) return clean;
  return '';
}

// TODO: add YouTube embed support to sections. Each section's media slot currently
// only supports images. Plan: add an optional `videos` array (or a `youtubeId` field)
// alongside `images` in the section schema. The admin UI would let you paste a YouTube
// URL, extract the video ID, store it, and render an <iframe> embed in the project view.
function sanitizeSections(sections, { allowTemp = false } = {}) {
  if (!Array.isArray(sections)) return [];
  const validateSrc = allowTemp ? validateImagePathPermissive : validateImagePath;
  return sections.slice(0, 50).map((s) => ({
    id: typeof s.id === 'string' ? s.id.slice(0, 50) : crypto.randomUUID(),
    heading: (s.heading || '').slice(0, 200),
    body: (s.body || '').slice(0, 20000),
    cols: (typeof s.cols === 'number' && s.cols >= 0) ? Math.min(Math.floor(s.cols), 20) : 0,
    images: Array.isArray(s.images)
      ? s.images.slice(0, 30).map(img => ({
          src: validateSrc(img.src),
          alt: (img.alt || '').slice(0, 300),
        })).filter(img => img.src)
      : [],
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

app.use((req, res) => res.status(404).render('404'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(status).json({ error: 'Internal server error.' });
  }
  res.status(status).render('error', { message: 'Something went wrong.' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🌐  Portfolio running at http://localhost:${PORT}`);
  console.log(`🔐  Admin panel:  http://localhost:${PORT}/admin/login\n`);
});
