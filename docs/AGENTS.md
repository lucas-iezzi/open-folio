# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Friendly terminal wrapper — checklist, status, restart-on-crash prompt (what Start.bat/Start.command run)
node scripts/start.js

# First-time setup only (generates .env) — not required locally, server.js does this itself on first run
npm run setup

# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

There is no build step, test suite, or linter configured.

## Architecture

Single-file Express server (`server.js`) with EJS templates and a SQLite database (`data/portfolio.db` via `better-sqlite3`). All routes, middleware, database helpers, AI calls, and business logic live in `server.js`.

**Data layer:** SQLite accessed synchronously through `better-sqlite3`. `loadProjects()` / `saveProjects()` / `sortedProjects()` are the main helpers. Projects are sorted by an integer `sort_order` column. The DB is auto-migrated on startup (new columns added with `ALTER TABLE` guarded by `pragma table_info`).

**Project schema:**
```json
{
  "slug": "my-project",
  "title": "...",
  "subtitle": "...",
  "pageTitle": "...",
  "thumbnail": "/images/projects/my-project/uuid.jpg",
  "thumbnailAlt": "...",
  "order": 0,
  "sections": [
    { "id": "uuid", "heading": "...", "body": "...", "images": [{ "src": "...", "alt": "..." }] }
  ]
}
```

`title` is the short card label shown on the homepage grid. `pageTitle` is the H1 on the project page (falls back to `title` if empty). `subtitle` appears below the H1.

**Routing:**
- `GET /` and `GET /projects/:slug` — public portfolio pages
- `GET|POST /admin/login`, `GET /admin/logout` — authentication (no `requireAuth` guard)
- `GET /admin/dashboard` — main admin panel (projects, sandbox styles, activity, settings, deploy tabs)
- Everything under `/admin/projects/*` — protected by `requireAuth`
- `POST /admin/upload/:slug` — image upload (multer, stored in `public/images/projects/<slug>/`)
- `POST /admin/image/delete` — deletes an image file from disk
- `/api/v1/*` — REST API protected by bearer token
- `GET /admin/generate` — AI Studio (generate mode)
- `GET /admin/studio/edit/:slug` — AI Studio (edit mode)
- `POST /admin/studio/upload` — stages files in `public/images/studio-temp/<tempId>/`
- `POST /admin/studio/generate` — LLM call: description + images → project JSON
- `POST /admin/studio/refine` — LLM chat: feedback → updated project JSON
- `POST /admin/studio/publish` — saves draft to DB, moves temp images to permanent folder
- `POST /admin/projects/:slug/publish-edits` — edit mode auto-save; keeps studio session alive
- `POST /admin/studio/discard` — clears studio session and temp folder
- `GET /sandbox` — UI Sandbox editor (public, session-based)
- `GET /sandbox/preview` — iframe preview for sandbox
- `POST /api/sandbox/prompt` — LLM: natural language → sandbox config ops
- `POST /api/sandbox/match-style` — LLM: URL + image + HTML/CSS file → sandbox config ops
- `POST /api/admin/deploy-chat` — LLM deployment assistant chat (admin only, local access only)
- `POST /admin/settings/api-key` — save AI provider key or switch active provider

**Security model:** CSRF tokens stored in session, checked on every mutating admin route. Token passed to templates as `csrfToken`, sent via `X-CSRF-Token` header (JSON) or `_csrf` body field (form POSTs). Session regenerated on login. Slugs validated with `sanitizeSlug()`, image paths with `validateImagePath()` / `validateImagePathPermissive()`, preventing path traversal.

**Admin auth:** `isLocalAccess(req)` (based on `req.hostname` — "localhost", a loopback address, or any raw IP; matches how Caddy passes through the real Host header for live traffic while direct/local requests show up as localhost/IP) is the single trust boundary behind three things: `requireAuth` skips the password entirely for local requests (no password is needed to use the admin panel on your own machine — it only matters once the site is reachable from outside); `requireLocal` gates the Remote Server tab's SSH/deploy endpoints the same way; and it decides whether `/admin/login` needs the secret admin path (see below). This depends on the setup wizard's firewall step keeping port 3000 itself unreachable from outside (only 22/80/443 are opened) — if that firewall rule is ever missing, "local access" could be spoofed via a raw IP or Host header.

**Secret admin path:** `ADMIN_PATH` env var (default `'admin'`, meaning disabled — `/admin/login` is always reachable). When set to something else, `/admin/login` 404s for non-local visitors until they've first visited `/<that-word>` (a catch-all single-segment route defined right before the 404 handler, so it can't shadow any real route), which sets `req.session.adminGateOk` and redirects to `/admin` — after that, normal `/admin/*` navigation works for the rest of that browser session. Validated against a reserved-word list (`projects`, `sandbox`, `api`, etc.) in three places that all share the same rules: `parseAdminPath()` in server.js, `validateAdminPath()` in `manage.js` and `scripts/setup.js`. Set during first-time remote setup (`scripts/setup.js --admin-path=`) or anytime after via `manage.js --set-admin-path=` (both wired into the Remote Server tab's setup carousel step 9 and its Server Commands section — this replaced an older `ADMIN_ACCESS_TOKEN` query-string mechanism entirely).

**Frontend:** Two JS/CSS bundles — `public/js/main.js` + `public/css/style.css` for the public site; `public/js/admin.js` + `public/css/admin.css` for the admin panel. The sandbox has its own `public/js/sandbox.js` + `public/css/sandbox.css`. No framework, no bundler.

**CSRF token in admin JS:** `admin.js` reads the CSRF token from `<meta name="csrf-token">`. This meta tag is injected inline in each admin view's `<head>`, not in `views/admin/partials/head.ejs`. When adding new admin pages, include `<meta name="csrf-token" content="<%= csrfToken %>">`.

**Image uploads:** Land in `public/images/projects/<slug>/` with UUID filenames. `validateImagePath()` enforces the pattern `/images/projects/<slug>/<filename>.<ext>` on every save.

**Environment variables:**
- `SESSION_SECRET` — express-session secret. If missing at startup, server.js generates one (plus `API_KEY` and `PORT=3000`) and writes `.env` itself — local first-run needs no setup step at all.
- `ADMIN_PASSWORD_HASH` — bcrypt hash (cost 12) of the admin password. Optional — only checked for non-local requests; local access bypasses it entirely. Set via the Remote Server tab's setup carousel or Server Commands (writes it to the *remote* .env over SSH), not needed locally.
- `ADMIN_PATH` — see "Secret admin path" above. Optional, defaults to `'admin'`.
- `API_KEY` — bearer token for the REST API
- `PORT` — defaults to 3000
- `NODE_ENV` — set to `production` to enable secure cookies + HSTS
- `AI_PROVIDER` — active AI provider: `anthropic`, `openai`, or `gemini` (default: `anthropic`)
- `ANTHROPIC_API_KEY` — key for Anthropic/Claude (optional — AI disabled if not set)
- `OPENAI_API_KEY` — key for OpenAI/ChatGPT (optional)
- `GEMINI_API_KEY` — key for Google Gemini (optional)

## Multi-provider AI

All AI features support three providers: **Anthropic (Claude)**, **OpenAI (ChatGPT)**, and **Google Gemini**. Only one is active at a time, controlled by `AI_PROVIDER` in `.env`.

**Key functions:**
- `getActiveProvider()` — returns `AI_PROVIDER` env var, defaulting to `'anthropic'`
- `hasActiveKey()` — `true` if the active provider's key env var is set
- `getModelId(tier, provider)` — maps tier (`'fast'`, `'smart'`, `'quality'`) to a provider-specific model ID
- `callAI({ messages, systemPrompt, tier })` — convenience wrapper; uses active provider + tier
- `callLLM({ provider, model, messages, systemPrompt })` — direct call; handles message format conversion for all three providers

**PROVIDERS registry** (`server.js`) defines model IDs and labels per tier for each provider. All model choices flow through this registry — update model IDs here when providers release new models.

**Message format:** Internally uses Anthropic's format (content arrays with `{ type: 'image', source: { type: 'base64', ... } }` blocks). `callLLM` converts to OpenAI or Gemini format as needed. Vision (image content blocks) is supported by all three providers.

**Changing provider:** Via Admin → Settings tab (shows a card per provider) or launcher option [2]. Saving a key automatically activates that provider. "Switch to this provider" button available for keys already stored.

**When no key is set:** All AI-dependent UI elements are disabled with a visible notice linking to Settings. The rest of the site works normally.

## UI Sandbox

The sandbox (`GET /sandbox`) lets users visually customize the portfolio's appearance without touching code.

**Config structure** (stored in `sandbox_sessions` table, JSON):
```js
{
  version: 1,
  tokens: { background, text, accent, surface },  // hex colors
  nav:      { visible },
  hero:     { visible, layout, nameSize },
  projects: {
    layout: { type, columns, gap, scrollSnap },
    item:   { showTitle, titlePosition, titleOnHover, showDescription,
               imageFilter, imageFilterOnHover, borderRadius, shadow, aspectRatio }
  },
  text:      { heroTagline, heroName },
  customCSS: '',        // raw CSS, max 20 000 chars
  pageCSS:   {}         // per-slug CSS: pageCSS['my-project'] = '...'
}
```

**AI prompt** (`POST /api/sandbox/prompt`) — user describes a change in natural language; LLM returns JSON ops applied to the config. Rate-limited to 15/min.

**Import Style** (`POST /api/sandbox/match-style`) — accepts any combination of:
- `url` — fetches the page's HTML + linked CSS server-side (SSRF-protected)
- `imageFile` — screenshot or Figma export (up to 10 MB, sent as vision content block)
- `htmlFile` — HTML or CSS file (Figma → Anima export, etc.), CSS extracted and fed to LLM

Uses multer `memoryStorage` for file uploads on this endpoint (no disk writes). Rate-limited to 5/min.

**Undo/redo:** Every AI op saves a snapshot to `sandbox_revisions`; redo snapshots go to `sandbox_redo`.

**Named styles:** Users can save/load/delete named style presets (stored in `sandbox_styles` table). The active style name is shown in the editor header.

**Markers:** Users click elements in the iframe preview to insert `@marker` references into their prompt. Only one marker at a time.

## AI Studio

Two modes for LLM-assisted project creation.

**Generate mode** (`/admin/generate`):
1. User writes a description + uploads images/PDFs
2. Generate → LLM returns full project JSON (title, subtitle, sections, image placement)
3. Live preview in iframe using the real `project.ejs` template
4. Chat refines the draft iteratively; LLM always has full conversation history
5. Publish saves to DB, moves images from temp (`public/images/studio-temp/<tempId>/`) to permanent storage

**Edit mode** (`/admin/studio/edit/:slug`):
- Renders the live project page with `contenteditable` fields and inline image editing
- Auto-saves to DB on every change (debounced); studio session preserved across saves
- Every chat message re-sends full current page state (title, subtitle, sections + image labels)
- Changes appear as preview (orange banner); user clicks Accept or Discard

**Model tiers:** Select `smart` (balanced) or `quality` (best) per session. The model select now renders tier labels from the PROVIDERS registry — option values are tier names (`smart`, `quality`), not model IDs. Studio sends `{ modelTier }` to the generate/refine endpoints.

**Image handling:**
- Generate mode: images sent as base64 content blocks to the LLM
- Edit mode: image filenames + labels sent (not base64); LLM references them by name
- Chat attachments: base64 in the next message only, never stored server-side
- PDF files: text-extracted server-side, sent as text blocks

**Key files:**
- `public/js/studio.js` — all studio frontend logic
- `views/admin/studio.ejs` — single template for both modes (mode toggled via EJS)
- `views/partials/project-body.ejs` — shared by public project page + edit-mode preview. Uses an inline HTML escape chain (`replace(/&/g,'&amp;')…replace(/\n/g,'<br>')`) to render user content safely. Do NOT use `escape()` here — EJS 3.x does not expose its HTML escaper as `escape`; the bare name resolves to the deprecated JS global `escape()` which URL-encodes spaces as `%20`.

## Launchers

There are two separate launchers — users double-click one, developers can use either:

### scripts/start.js (terminal front-end — used by Start.bat / Start.command)

There is no separate launcher GUI/app anymore — `Start.bat` and `Start.command` each:
1. Install Node.js if missing (platform-specific installers)
2. Run `npm install` if `node_modules` is absent
3. Run `node scripts/start.js`, which stays in the foreground of that same window

`scripts/start.js` prints a short Node/dependencies checklist, then before each start (including restarts) confirms the port is actually free — force-killing whatever's holding it first if not (`killPort()`/`ensurePortFree()`), since a previous session's window being closed rather than stopped can leave a stale process running on Windows. It spawns `server.js` as a child with stdio `['ignore', 'inherit', 'inherit']` — stdout/stderr pass through directly (its normal startup banner is suppressed via `OPENFOLIO_QUIET_STARTUP=1` since start.js prints its own), but stdin is deliberately disconnected from the child so start.js's own raw-mode keypress listener (`listenForKeys()`) can read `R`/`S`/`Q` at any time, not just after an exit. It polls the port to announce "Running — http://localhost:PORT" once actually confirmed up (with a short grace period so a same-port collision's crash message can't get printed after a false "Running"), then clears the screen to a clean persistent status view (`clearScreen()` — skipped on a crash, so the error stays visible instead of being wiped), and opens the browser to `/admin/dashboard` automatically.

Runtime controls, tracked via a small state machine (`child` + `intent`, where `intent` is `'stopping'`/`'restarting'`/`'quitting'`/`null` and tells the child's `exit` handler how to react): **R** restarts (or starts, if stopped), **S** stops, **L** opens the admin panel in the browser (`currentPort`, tracked separately from `openedBrowser` so this works even after the one-time auto-open on first start), **Q**/Ctrl+C quits — all live the entire time the server is running, not just at a prompt after it exits. An exit with `intent === null` means nobody asked for it — a real crash — which shows the exit code and leaves everything on screen. This replaced a previous GUI launcher (`scripts/launcher-server.js`, a second Express server on its own port serving a multi-tab HTML UI) and a separate CLI menu (`launcher.js`) that duplicated a lot of what the admin panel and this script already do — both removed entirely.

**Reopening the terminal from the browser:** `POST /admin/local/launch-terminal` (Settings tab, local access only — button lives right below the local-access note) opens a fresh terminal window running `node scripts/start.js`, for when that window got closed but the server (started detached — see `startServer` in the removed launcher, same principle) is still running. Mirrors `/admin/deploy/open-terminal`'s cross-platform terminal-spawning logic (osascript on Mac, `cmd /K` on Windows, tries several emulators on Linux) but runs the local start script instead of an SSH command.

## Deployment

Recommended stack: Ubuntu 22.04 + Node.js 18+ + PM2 + Caddy.

**What is and isn't in git:**
- Tracked: code, templates, CSS, JS, scripts, `docs/Caddyfile.example`, `scripts/ecosystem.config.js`
- Gitignored: `data/portfolio.db`, `public/images/projects/`, `public/images/logos/`, `.env`, `node_modules/`, `.launcher-config.json`

**First deploy to a fresh server:**
```bash
git clone <repo> ~/open-folio && cd ~/open-folio && npm install
npm run setup                                        # generates .env on the server
scp data/portfolio.db user@HOST:~/open-folio/data/
scp -r public/images/projects user@HOST:~/open-folio/public/images/
scp -r public/images/logos    user@HOST:~/open-folio/public/images/
npm install -g pm2
pm2 start scripts/ecosystem.config.js --env production
pm2 save && pm2 startup
sudo cp docs/Caddyfile.example /etc/caddy/Caddyfile  # edit domain first
sudo systemctl reload caddy
```

**Deploy tab:** The admin panel's Deploy tab (only shown when accessing locally — hostname is `localhost`, `127.0.0.1`, or a raw IP) has a step-by-step guide and an AI chat assistant for deployment questions.

**Content sync:** All push/pull uses `scp` (bundled with OpenSSH — always available alongside `ssh`). No rsync dependency. Key endpoints:
- `POST /admin/deploy/sync` — full push or pull (DB + all image dirs)
- `POST /admin/deploy/sync-item` — single item push or pull (db | db-settings | db-project/\<slug\> | images/logos | images/projects[/slug]). Body also accepts `forcePerFile: true`. Streams NDJSON progress (`checking` → `diff-found` → `transfer`/`retrying`/`file-failed` → `verify` → `done`). Diffs local vs remote first (`listLocalTree`/`listRemoteTree`, by path + size) and transfers only files that actually differ — a DB or image that already matches is never re-sent, and `done.detail.skipped` is set when there was nothing to do. Small diffs (≤40 files and <40% of the tree) are sent file-by-file, each with its own independent retry, so one bad file doesn't force retrying everything else; large/fresh transfers (empty destination, or ≥40% of the tree differs) fall back to one recursive scp, which is faster and more reliable than hundreds of separate SSH round trips — unless `forcePerFile` is set, which always forces per-file mode even on an empty destination (used by the setup wizard's initial content push, so the caller gets a progress event per image, and per project, instead of one lump bulk copy). Each file's transfer timeout scales with its size and current retry attempt (`fileTimeout()` — a generous ~150KB/s floor, capped at 3 min, multiplied by the attempt number) instead of a flat timeout, and `withRetry` waits `1s * attempt` between retries — a flat timeout previously made large images burn through all `SYNC_MAX_ATTEMPTS` (3) and look permanently "stuck" on the same file. Every transfer is re-verified against the real file listing and retried up to `SYNC_MAX_ATTEMPTS` times before reporting failure with the exact list of still-mismatched files in `detail.missing`/`detail.failedTransfers`. This exists because trusting scp's exit code alone previously let some images silently fail to land on the server.
- `POST /admin/deploy/compare` — read-only; diffs local vs remote per-file (DB by size, images by exact path + size via SSH `find`). Called automatically 1.5 s after each admin panel open (throttled to once per 2 min per browser tab via `sessionStorage`); if anything differs, `admin.js` shows a dismissible banner (`.of-sync-banner`) with Push/Pull/Review buttons — nothing syncs without an explicit click. There is no automatic pulling; a prior file-count-based auto-pull heuristic was removed because matching totals could mask per-project mismatches (root cause of images going missing on the live site).
- `POST /admin/deploy/cleanup-orphans` — deletes files flagged as orphaned by Compare (`{ side, paths }`). Re-verifies each path is *still* orphaned right now (recomputes the manifest — never trusts a stale client-supplied list) before deleting. Requires explicit user confirmation per file in the UI; nothing is deleted automatically.

**Content manifest (`lib/content-manifest.js` + `scripts/manifest.js`):** Distinguishes real content from junk by reading each project's `thumbnail`/section `images[].src` (plus `draft_data` and the two logo settings) out of `portfolio.db` and comparing that "referenced" set against what's actually in `public/images/`. Produces `orphaned` (on disk, referenced by nothing — safe to delete) and `missing` (referenced by a project, but the file isn't there — a broken image). Also produces `projects` (`{ [slug]: { title, hash } }` — a content hash per project row, deliberately excluding `sort_order` so reordering the grid doesn't make every project look changed) and `settingsHash` (one hash for the whole settings table). `scripts/manifest.js` is a thin CLI (`node scripts/manifest.js` → JSON on stdout) so `/admin/deploy/compare` can run the exact same logic locally (in-process) and on the remote (over SSH) and compare both sides consistently. **Important:** the remote side of this only works once the server has actually pulled this script via `git pull` — Compare degrades gracefully (falls back to the old whole-file-size db check, skips orphan/broken detection) if the remote's `scripts/manifest.js` is missing or out of date. Pushing/pulling *content* (DB + images) never updates the server's *code* — that only happens via the "Pull code updates" command or a manual `git pull && npm install && pm2 restart`.

**Per-project DB sync (`lib/project-sync.js` + `scripts/sync-db-row.js`):** Compare reports one item per project slug (`db-project/<slug>`, direction based on presence + hash match) plus one for the whole settings table (`db-settings`, always `'both'` when hashes differ — there's no per-key granularity or way to know which side should win). `/admin/deploy/sync-item` handles both: locally via `readProjectRow`/`upsertProjectRow`/`readAllSettings`/`writeAllSettings` against the already-open `db` handle, remotely via `scripts/sync-db-row.js` over SSH (`--read-project <slug>` / `--write-project` with the row piped as JSON over stdin via `sshExecWithStdin` — stdin, not a command-line argument, since section text can be large — / `--read-settings` / `--write-settings`). `upsertProjectRow` preserves whichever side's `sort_order` already exists for that slug (or appends at the end if new there), so syncing one project never reshuffles the rest of the grid — but also means reordering itself doesn't sync via this path; only content does. Writing in place like this never needs a server restart to take effect the way a whole-file db push does — the running process's connection stays valid since the file itself is never replaced.

**Setup carousel progress (`.setup-progress.json` on the remote):** The 13-step setup wizard's completed-step dots are tracked by a small JSON array of step indices written to `<remotePath>/.setup-progress.json` on the server itself — `POST /admin/deploy/setup-progress` reads it (returns `{ configured: false }` if no server is saved yet), `POST /admin/deploy/mark-setup-step` (`{ step }`) reads-merges-writes it via `sshExecWithStdin`. `admin.js`'s `markStepDone()` calls the latter after every successful step (both SSH-run steps and the two manual "mark done" steps); `loadSetupProgress()` fetches current state on page load and again after saving new SSH credentials. This used to live in the browser's `localStorage`, which kept showing old progress as "done" after the actual server was wiped/rebuilt since nothing tied it to a specific server instance — the file-on-remote approach means a reset server has no file and correctly starts the checklist over. Once a step's own `doneSteps` entry is set, `updateRunButtonState()` keeps that step's run/mark-done button disabled — only Prev/Next can move off of it — so it can't be accidentally re-run; it re-enables automatically if that step's completion is ever missing (a failed run, or a fresh server with no progress file).

**Sync ordering and the compare UI (`admin.js`):** `/admin/deploy/compare`'s flat `items` array lists a project's `db-project/<slug>` entry before its `images/projects/<slug>` entry, but syncing in that order would let a slow or failed image transfer leave the just-synced side's database pointing at an image that isn't there yet — a "broken reference". Both `runContentSync()` and `runInitialContentPush()` reorder their work so all image items run before any db item, and `runContentSync()` additionally tracks per-item success and skips a `db-project/<slug>`/`db-settings` item outright if its paired images item failed in the same run (`imageDepFor()`), rather than syncing a row that would reference missing files. `runContentSync()` also restarts the remote server after any push (not only a whole-file `db` push) so the live site always reflects what was just synced; pulls never trigger a remote restart since they don't change the server. The Compare panel's UI groups a project's `db-project`/`images/projects` items into one visual card (`.rs-diff-group`) with a combined subtext line, instead of showing them as two disconnected rows — the underlying `items` list and individual push/pull actions are unchanged, this is purely a client-side grouping in `runCompare()`.

**Content change log:** `content_log` SQLite table (`path`, `action` — `'added'`/`'removed'`, `ts`) records every image add/remove via `logContentChange()`, called from the upload route, image-delete route, logo upload/delete, and both AI Studio `moveImage` publish paths. Best-effort audit trail, not the source of truth for orphan/missing detection (that's always recomputed fresh from current DB + filesystem state, so it can't drift). Shown in the Compare panel as "Recent content changes", merging both sides' logs by timestamp.

## REST API

All endpoints at `/api/v1/` require `Authorization: Bearer <API_KEY>`.

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
BASE=http://localhost:3000

curl "$BASE/api/v1/projects" -H "Authorization: Bearer $API_KEY"
curl "$BASE/api/v1/projects/my-slug" -H "Authorization: Bearer $API_KEY"
curl -X POST "$BASE/api/v1/projects" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"slug":"new","title":"New Project","sections":[]}'
curl -X PATCH "$BASE/api/v1/projects/my-slug" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subtitle":"Updated subtitle"}'
curl -X DELETE "$BASE/api/v1/projects/my-slug" -H "Authorization: Bearer $API_KEY"
```

**Writable fields:** `title`, `subtitle`, `pageTitle`, `thumbnail` (must match `/images/projects/<slug>/...`), `thumbnailAlt`, `order` (integer), `sections` (array).

## Helmet CSP

Helmet is applied globally. Routes that need inline scripts or styles override the CSP header via `res.setHeader('Content-Security-Policy', ...)`. Key overrides:
- `/admin/dashboard` and `/sandbox` — `'unsafe-inline'` for both script-src and style-src (inline JS used for CSRF tokens and per-session config)
- `/admin/generate` and `/admin/studio/edit/*` — same, plus `frame-src 'self'` for the preview iframe

When adding a new admin page that uses inline JS or a CSP-restricted resource, explicitly set the CSP header for that route — the global Helmet default will block it silently.

## Design System

The public site matches the design at lucasiezzi.com (Webflow). All values below come from the Webflow CSS. When adding new pages or components, match exactly — do not invent new sizes or weights.

### Font

**Montserrat** (Google Fonts), loaded in `views/partials/head.ejs` (public) and `views/admin/partials/head.ejs` (admin). Weights: 300, 400, 500, 600, 700.

### Colors

| Role | Value |
|---|---|
| Body text | `#1a1b1f` |
| Site name | `#4b4e58` |
| Project body / subtitle | `#2c2e36` |
| Subtitle dimming | `opacity: 0.6` on `#2c2e36` |
| Card title | `#212327` |
| Background | `#ffffff` |

### Typography scale

| Element | `font-size` | `font-weight` | `line-height` |
|---|---|---|---|
| Site name | `40px` | 500 | `1` |
| Tagline | `24px` | 400 | `1.333` |
| Project title | `2.2rem` | 600 | `2.5rem` |
| Project subtitle | `1rem` | 400 | `2rem` |
| Section heading | `2rem` | 500 | `2rem` |
| Section body | `1.5rem` | 400 | `2rem` |
| Card label | `1.2rem` | 300 | `1.5rem` |
| Nav link | `12px` | 500 | — |

### Layout

**Horizontal margins:** `.container` uses `padding-inline: 7%`. Never add `max-width` to `.container` on the public site.

**Mobile:** At `≤640px`, container padding drops to `15px`.

**Full-bleed images:** Hero image and section images live outside `.container` (edge-to-edge). Text stays inside.

**Homepage card grid:** 4 columns, `1rem` gap, `3:2` aspect ratio, title centered below each card.

### CSS custom properties

```
--d-name-size:       40px
--d-name-weight:     500
--d-bio-size:        24px
--d-bio-lh:          1.333
--d-card-size:       19.2px
--d-hero-top:        20px
--d-hero-bot:        40px
--d-proj-header-mb:  48px
--d-section-gap:     48px
```
