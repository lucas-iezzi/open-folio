# open-folio

A self-hosted, open-source portfolio website. Built with Node.js, Express, and SQLite — no proprietary servers, no subscription, no coding required to use it. Everything is managed through an admin panel and a simple launcher tool.

---

## Get started

**Windows:** double-click `Start.bat`  
**Mac:** double-click `Start.command`

Node.js is installed automatically if needed. The launcher walks you through the rest.

Once running, open:

- **Portfolio:** `http://localhost:3000`
- **Admin panel:** `http://localhost:3000/admin/dashboard` — no password needed on your own machine

### Manual start

```bash
git clone https://github.com/lucas-iezzi/open-folio.git
cd open-folio
npm install
node scripts/start.js
```

`server.js` generates a session secret on first run — no setup step required. A password is only needed once you deploy somewhere publicly reachable, which you set up from the admin panel's Remote Server tab.

---

## What it does

open-folio gives you a portfolio website you actually control — hosted on your own server, with no monthly subscription to a website builder.

- Add projects with descriptions, images, and rich content sections
- Use AI to generate project pages from a description and photos
- Visually customize colors, layout, and typography — no CSS knowledge needed
- Deploy to a $4–7/month VPS with built-in SSH sync tools in the admin panel

For a full list of features: **[FEATURES.md](docs/FEATURES.md)**  
For setup and deployment instructions: **[DEPLOYMENT.md](docs/DEPLOYMENT.md)**

---

## AI setup (optional)

AI features (project generation, Sandbox AI prompt, import style) work with any provider:

| Provider | Key format | Get one at |
|---|---|---|
| Anthropic (Claude) | `sk-ant-…` | console.anthropic.com |
| OpenAI (ChatGPT) | `sk-…` | platform.openai.com |
| Google Gemini | `AIza…` | aistudio.google.com |

Add your key in **Admin → Settings**, or via the launcher's **Configure AI** option. All keys are stored only in your local `.env` file.

---

## License

MIT
