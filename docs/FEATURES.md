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
- **Logos** — upload a small icon logo and a larger logomark; both appear in the nav and admin panel
- **Nav logo size** — slider to adjust logo height (50% to 200%)
- **Admin password** — change your login password without restarting the server
- **Secret access word** — optionally hide the login page behind a URL token (`?token=yourword`)
- **AI provider** — add API keys and switch between Anthropic, OpenAI, and Gemini

### Remote Server tab
Only shown when running locally. Full server management without needing a terminal:
- Save SSH credentials (host, username, port, remote path)
- Test SSH connection with one click
- Step-by-step server setup — each step has a "Run on server" button that executes the command and shows output
- **Content Sync:** push your local database and images to the server, pull from server, compare differences, or download a full backup
- **Server Commands:** restart the site, view logs, check status (PM2 + disk + uptime), pull code updates (git pull + npm install + restart)
- Copy the SSH command to open a terminal session to your server
- AI assistant for troubleshooting and setup questions

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

## Launcher CLI

`node launcher.js` — the control panel for your local setup:

- Start and stop the local server
- Configure AI provider and API key
- Change admin password
- Change server port
- Re-run first-time setup

---

## Server management tool

`node manage.js` — run this on your live server (via SSH) to change settings without restarting:

- Change admin password
- Rotate session secret (signs out all active sessions)
- Rotate REST API key
- Change port
- Configure AI provider
- View `.env` contents
