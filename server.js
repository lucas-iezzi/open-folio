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

async function callLLM({ provider, model, messages, systemPrompt = STUDIO_SYSTEM_PROMPT }) {
  if (provider === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text;
  }
  if (provider === 'openai') {
    throw new Error('OpenAI support is not yet implemented. Add your key and the openai package to enable it.');
  }
  throw new Error(`Unknown provider: "${provider}"`);
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('LLM did not return valid JSON. Try again or rephrase your description.');
  }
}

// Build the first user message for the LLM — images as base64, text files as content blocks.
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
  res.render('index', { projects: publicProjects() });
});

app.get('/projects/:slug', (req, res, next) => {
  const slug = sanitizeSlug(req.params.slug);
  const project = loadProjects().find(p => p.slug === slug);
  if (!project) return next(); // fall through to 404
  recordVisit(req, 'page');
  res.render('project', { project });
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
  res.render('admin/login', { error: null, csrfToken: getCsrfToken(req) });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const { password, _csrf } = req.body;

  // CSRF check on login form
  if (!_csrf || _csrf !== req.session.csrfToken) {
    return res.status(403).render('admin/login', {
      error: 'Invalid request. Please try again.',
      csrfToken: getCsrfToken(req),
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

// ── Settings helpers ──────────────────────────────────────────────────────────
const EDITABLE_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

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

function apiKeyStatus() {
  return {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY:    !!process.env.OPENAI_API_KEY,
  };
}

app.get('/admin/dashboard', requireAuth, (req, res) => {
  res.render('admin/index', {
    projects:     sortedProjects(),
    activity:     getActivityStats(),
    csrfToken:    getCsrfToken(req),
    flash:        req.query.msg || null,
    apiKeyStatus: apiKeyStatus(),
  });
});

// POST /admin/settings/api-key — write a key to .env and hot-reload process.env
app.post('/admin/settings/api-key', requireAuth, requireCsrf, (req, res) => {
  const { key, value } = req.body;
  if (!EDITABLE_KEYS.has(key)) {
    return res.status(400).json({ error: 'Unknown key.' });
  }
  if (typeof value !== 'string' || value.trim().length < 8) {
    return res.status(400).json({ error: 'Key value is too short.' });
  }
  try {
    updateEnvFile(key, value.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings/api-key]', err.message);
    res.status(500).json({ error: 'Could not save key.' });
  }
});

// ── New project form ──────────────────────────────────────────────────────────
app.get('/admin/projects/new', requireAuth, (req, res) => {
  res.render('admin/project-form', {
    project: null,
    csrfToken: getCsrfToken(req),
    error: null,
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

  res.render('admin/studio', {
    csrfToken:          getCsrfToken(req),
    tempId:             req.session.studio.tempId,
    mode:               'edit',
    editSlug:           slug,
    previewProject:     editProject,
    initialProjectJson: safeJson,
    folderImagesJson:   safeFolderImages,
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
  res.render('admin/studio', {
    csrfToken: getCsrfToken(req),
    tempId:    req.session.studio.tempId,
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

  const { description, provider = 'anthropic', model = 'claude-sonnet-4-6', tags = {} } = req.body;
  if (!description || description.trim().length < 10) {
    return res.status(400).json({ error: 'Please add a project description (at least 10 characters).' });
  }

  try {
    const firstMsg = await buildFirstMessage(description.trim(), studio.uploadedFiles, studio.tempId, tags);
    const rawText  = await callLLM({ provider, model, messages: [firstMsg] });
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

  const { feedback, provider = 'anthropic', model = 'claude-sonnet-4-6', tags = {}, editorImages, imageManifest, currentProject, chatAttachments } = req.body;
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
        ? editorImages.filter(f => f.filename && f.permanentPath).map(f => ({
            ...f,
            permanentPath: path.join(__dirname, 'public', f.permanentPath.replace(/^\//, '')),
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

    const rawText = await callLLM({ provider, model, messages, systemPrompt: STUDIO_REFINE_PROMPT });
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
