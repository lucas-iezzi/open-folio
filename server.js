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
  INSERT INTO projects (slug, title, subtitle, pageTitle, thumbnail, thumbnailAlt, sort_order, visible, sections)
  VALUES (@slug, @title, @subtitle, @pageTitle, @thumbnail, @thumbnailAlt, @sort_order, @visible, @sections)
  ON CONFLICT(slug) DO UPDATE SET
    title        = excluded.title,
    subtitle     = excluded.subtitle,
    pageTitle    = excluded.pageTitle,
    thumbnail    = excluded.thumbnail,
    thumbnailAlt = excluded.thumbnailAlt,
    sort_order   = excluded.sort_order,
    visible      = excluded.visible,
    sections     = excluded.sections
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
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

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

// ── robots.txt ────────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin/\nDisallow: /admin\n');
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

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

app.get('/admin/dashboard', requireAuth, (req, res) => {
  res.render('admin/index', {
    projects: sortedProjects(),
    activity: getActivityStats(),
    csrfToken: getCsrfToken(req),
    flash: req.query.msg || null,
  });
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

function sanitizeSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.slice(0, 50).map((s) => ({
    id: typeof s.id === 'string' ? s.id.slice(0, 50) : crypto.randomUUID(),
    heading: (s.heading || '').slice(0, 200),
    body: (s.body || '').slice(0, 20000),
    cols: (typeof s.cols === 'number' && s.cols >= 0) ? Math.min(Math.floor(s.cols), 20) : 0,
    images: Array.isArray(s.images)
      ? s.images.slice(0, 30).map(img => ({
          src: validateImagePath(img.src),
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
