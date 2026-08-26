# Features

A complete overview of everything open-folio can do.

---

## Public portfolio website

Your live portfolio at `http://localhost:3000` (or your domain once deployed):

- **Homepage grid** — all your projects displayed as cards with thumbnails and titles
- **Project pages** — each project has its own page with a heading, subtitle, and rich content sections
- **Content sections** — each section has a heading, body text, and an optional image gallery
- **Responsive design** — works on mobile, tablet, and desktop
- **Custom domain + HTTPS** — Caddy handles SSL certificates automatically when self-hosted

---

## Admin panel

Access at `/admin/login`. Everything you need to manage your site:

### Projects tab
- Create, edit, and delete projects
- Drag-and-drop to reorder projects on the homepage
- Upload thumbnail images and multiple section images per project
- Set a custom URL slug, page heading, subtitle, and alt text
- Toggle project visibility (hide without deleting)
- Export projects as JSON or static HTML files

### Settings tab
- **Site identity** — set your name and tagline shown on the homepage
- **Logos** — upload a small icon logo and a larger logomark; both appear in the nav and admin panel. The small logo also becomes the browser tab favicon.
- **Nav logo size** — slider to adjust logo height (50% to 200%)
- **Admin password** — change your login password without restarting the server. Only matters for a live deployment — no password is ever required to use this admin panel from your own machine.
- **AI provider** — add API keys and switch between Anthropic, OpenAI, and Gemini
- **Local Server Control** — reopens the start/stop/restart terminal (`scripts/start.js`) in a new window, in case you closed it while the site was still running. Local access only.

### Remote Server tab
Only shown when running locally. Full server management without needing a terminal:
- Save SSH credentials (host, username, port, remote path)
- Test SSH connection with one click
- 13-step server setup, each with a "Run on server" button: provisioning through DNS, plus a final step that pushes your local database and images to the fresh server with real (not estimated) per-file, per-image progress — images always go up before the database, so the fresh server is never left with a database row pointing at an image that hasn't landed yet. Includes setting your live admin password and an optional secret admin path (visit that word instead of typing "admin" to reach the login page — otherwise `/admin/login` 404s for outside visitors). Completed steps persist across reloads and restarts, and the card shows a "✓ Complete" badge once all 13 are done.
- **Content Sync:** one "Sync content" button that compares local vs. server and pushes/pulls exactly what differs, asking once when something changed on both sides. Compare groups differences per project — one card per project showing what's out of sync (data, images, or both) — plus site settings, so pushing or pulling one changed project leaves everything else, and its position in the grid, untouched. Images always sync before the database row that references them (in either direction), and a project's row is skipped rather than synced if its images failed this run, so a slow or failed image transfer can never leave a database pointing at a file that isn't there. Each file transfer's timeout scales with its size and retry attempt, with a short backoff between retries, so large images get realistic time instead of looking "stuck" retrying a fixed timeout. Every transfer verifies it landed correctly. A restart follows any push so the server picks up the change cleanly. A banner appears (with the same button) if anything's out of sync when the admin panel opens. Compare also flags orphaned files (unused by any project, safe to delete) and broken image references (a project points at a file that's missing).
- **Clear Content:** wipes all projects + project images on just the server or just the local site (logos and site settings are kept), so that side can be pushed/pulled fresh. Backs up automatically first and requires typing "DELETE" to confirm.
- **Server Commands:** restart the site, view logs, check status (PM2 + disk + uptime), pull code updates (git pull + npm install + restart), change the live admin password or secret admin path
- Copy the SSH command to open a terminal session to your server
- AI assistant for troubleshooting and setup questions — it can also answer questions about the codebase itself, since it reads this project's own docs

### Activity tab
- Recent visitor log with IP, path, and timestamp
- Geo-lookup for visitor IPs (city and country)

---

## AI Studio

Generate and edit project pages using an LLM:

### Generate mode (`/admin/generate`)
1. Write a description of the project
2. Upload photos, PDFs, or any supporting files
3. The AI generates a complete project page — title, subtitle, sections, and image placement
4. Preview in real time; refine with follow-up chat messages
5. Publish when ready

### Edit mode (`/admin/studio/edit/:slug`)
- Opens any existing project in an editable preview
- Edit text and images in-place; all changes auto-save
- Use the chat to ask the AI to rewrite sections, add content, or restructure the page
- Accept or discard AI changes with one click

Supports Anthropic (Claude), OpenAI (ChatGPT), and Google Gemini.

---

## UI Sandbox

Visual design editor at `/sandbox` — no CSS knowledge needed:

- **Colors** — background, text, accent, and surface colors
- **Typography** — hero name size, tagline size, card label style
- **Layout** — grid columns, gap, scroll snap, aspect ratio
- **Cards** — titles, descriptions, image filters, border radius, shadows, hover effects
- **Custom CSS** — raw CSS editor for advanced customization
- **Per-project CSS** — override styles for individual project pages
- **AI prompt** — describe changes in plain English ("make the cards rounder", "add a subtle shadow on hover")
- **Import Style** — paste a URL, upload a screenshot, or upload a Figma HTML export; the AI extracts the visual style and applies it to your sandbox
- **Named presets** — save and load design configurations
- **Undo/redo** — every AI change is tracked; revert with one click

---

## Local use + HTML export

open-folio works entirely offline — you don't need to deploy it to a server to use it. Run it locally and export your portfolio in two ways:

### Static HTML export
From the **Portfolio tab**, export any project (or all projects) as standalone HTML files. These can be:
- Sent as email attachments or shared as a ZIP file
- Hosted for free on GitHub Pages, Netlify, or Vercel
- Printed to PDF from the browser

### JSON export
Export all project data as a JSON file — useful as a backup or for migrating to another system.

---

## REST API

Full CRUD access to your portfolio data. All endpoints at `/api/v1/` require:
```
Authorization: Bearer <API_KEY>
```

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/projects` | List all projects |
| GET | `/api/v1/projects/:slug` | Get a single project |
| POST | `/api/v1/projects` | Create a project |
| PATCH | `/api/v1/projects/:slug` | Update a project |
| DELETE | `/api/v1/projects/:slug` | Delete a project |

Your API key is in `.env` and shown in **Admin → Settings → API key**.

---

## Starting the server

`Start.bat` / `Start.command` (or `node scripts/start.js` directly) — no separate app or menu, just a terminal window:

- Checks Node.js and dependencies, generates `.env` automatically on first run (no password needed locally)
- Shows a clean "Running — http://localhost:3000" screen once the server is confirmed up, and opens the admin panel in your browser
- Automatically reclaims the port if a previous session didn't shut down cleanly
- **R** to restart, **S** to stop, **L** to open the admin panel in your browser, **Q** (or Ctrl+C) to quit — any time, not just after it stops
- If it crashes unexpectedly, the error stays on screen and it prompts you to restart or quit
- Change the port or AI provider from the admin panel's Settings tab once it's running

---

## Server management tool

`node manage.js` — run this on your live server (via SSH) to change settings without restarting:

- Change admin password
- Change admin secret path (the word typed instead of "admin" to reach the login page)
- Rotate session secret (signs out all active sessions)
- Rotate REST API key
- Change port
- Configure AI provider
- View `.env` contents
