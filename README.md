# Lucas Iezzi — Portfolio Site

Node.js + Express + SQLite, hosted on DigitalOcean behind Caddy and Cloudflare.

---

## SSH into the server

```bash
ssh root@24.144.117.207
```

---

## Common tasks

### Deploy a code change
```bash
git pull && pm2 restart portfolio
```

### Reset the admin password
```bash
node scripts/setup.js
pm2 restart portfolio --update-env
```

### View logs
```bash
pm2 logs portfolio --lines 50
```

### Check app status
```bash
pm2 list
```

---

## Sync database and images

Run from your **local machine** (not the server):

```bash
bash scripts/sync.sh
```

Prompts you to push (local → server) or pull (server → local).

---

## Create a project via the API

Use `project.template.json` as the schema. Fill it in and POST it:

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -X POST "https://firsthatchstudio.com/api/v1/projects" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @my-new-project.json
```
