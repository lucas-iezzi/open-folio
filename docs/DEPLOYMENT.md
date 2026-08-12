# Deployment Guide

This guide covers two scenarios:

1. **Running locally** — your portfolio on your own computer (great for building and exporting)
2. **Live on the web** — your portfolio on a VPS with a real domain and HTTPS

---

## Part 1: Running locally

### Requirements

- **Node.js 18+** — the launcher installs it automatically on Windows and Mac if missing
- No other dependencies

### First-time setup

**Windows:** double-click `Start.bat`  
**Mac:** double-click `Start.command`

Or in a terminal:

```bash
git clone https://github.com/lucas-iezzi/open-folio.git
cd open-folio
node launcher.js
```

The launcher will:
1. Check that Node.js and dependencies are installed
2. Run setup (generates `.env` with secrets and prompts you to set an admin password)
3. Start the server

### After first-time setup

Just double-click `Start.bat` / `Start.command`, or run `node launcher.js` → `[1] Start server`.

Your site is at:
- Portfolio: `http://localhost:3000`
- Admin: `http://localhost:3000/admin/login`

### Launcher options

```
[1] Start / Restart server
[2] Configure AI provider & API key
[3] Change admin password
[4] Change port
[5] Re-run full setup
[q] Quit
```

You can leave the launcher running in the background — it keeps the server alive.

---

## Part 2: Hosting on the web

### What you need

- A **VPS (Virtual Private Server)** — a small server in a data center. Costs $4–7/month. Recommended providers:
  - **Hetzner Cloud** (hetzner.com/cloud) — most affordable
  - **DigitalOcean** (digitalocean.com) — beginner-friendly documentation
  - **Vultr** (vultr.com) — similar to DigitalOcean, many locations
- A **domain name** — from any registrar (Namecheap, Cloudflare, Google Domains). Typically $10–15/year.
- A **GitHub repository** — for your fork of open-folio. The live server pulls code from it.

### Step 1: Create your VPS

When signing up with your chosen provider:
- Choose **Ubuntu 22.04 LTS** as the operating system
- Pick the smallest/cheapest plan (1 CPU, 1–2 GB RAM is plenty)
- Add your **SSH key** during creation — most providers show you how; this is what lets you connect securely without a password

Note your server's IP address — you'll need it throughout this guide.

**Firewall:** make sure ports 22 (SSH), 80 (HTTP), and 443 (HTTPS) are open. On DigitalOcean and Vultr, run once you're connected:
```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```
On Hetzner, configure the firewall in their web console.

### Step 2: Connect and install dependencies

SSH into your server (replace with your details):
```bash
ssh root@YOUR_SERVER_IP
```

Install Node.js 22:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # should show v22.x.x
```

Install PM2 (keeps your site running 24/7):
```bash
sudo npm install -g pm2
```

Install Caddy (handles your domain and HTTPS automatically):
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy -y
sudo systemctl enable caddy && sudo systemctl start caddy
```

> All of steps 2–4 can be done from the **Remote Server tab** in the admin panel — each step has a "Run on server" button that executes the command and shows you the output.

### Step 3: Clone your repository

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git ~/open-folio
cd ~/open-folio
npm install --omit=dev
```

### Step 4: First-time server setup

Run the setup script on the server to create the `.env` and set your admin password:
```bash
npm run setup
```

Keep track of what you set — you'll need the admin password to log in.

> To change settings later (password, port, AI key) without restarting, run `node manage.js` on the server.

### Step 5: Push your local content to the server

From the **Remote Server tab** in your local admin panel:
1. Enter your server credentials (IP, username, SSH port, remote path)
2. Click **Save**, then **Test connection** to confirm SSH works
3. Under **Content Sync**, click **Push to server**

This transfers your database and all images in one shot.

Alternatively, run from your local terminal:
```bash
rsync -avz data/portfolio.db USER@SERVER_IP:~/open-folio/data/
rsync -avz public/images/projects/ USER@SERVER_IP:~/open-folio/public/images/projects/
rsync -avz public/images/logos/ USER@SERVER_IP:~/open-folio/public/images/logos/
```

### Step 6: Start the site with PM2

From the **Remote Server tab**, click **Run on server** for the "Start the site with PM2" step.

Or manually on the server:
```bash
cd ~/open-folio
pm2 start scripts/ecosystem.config.js --env production
pm2 save && pm2 startup
# Run the exact command that "pm2 startup" prints
```

Test it's running:
```bash
curl http://localhost:3000
```

### Step 7: Connect your domain

**1. Point your domain to the server** — in your registrar's DNS settings, add an A record:
```
Type:  A
Name:  @
Value: YOUR_SERVER_IP
TTL:   Auto (or 3600)
```
Optionally add a second A record for `www` pointing to the same IP.

**2. Configure Caddy** on the server:
```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the file contents with:
```
your-domain.com {
  reverse_proxy localhost:3000
}
```

Then restart Caddy:
```bash
sudo systemctl restart caddy
```

**3. Wait 5–15 minutes** for DNS to propagate. Caddy automatically gets an HTTPS certificate — your site will be live at `https://your-domain.com`.

---

## Keeping things in sync

After adding or editing projects locally, push your changes to the server from the **Remote Server tab** → **Push to server**. This updates the database and images.

### Code updates

When a new version of open-folio is released:

From the **Remote Server tab**: click **Pull updates** under Server Commands.

Or manually on the server:
```bash
cd ~/open-folio
git pull
npm install --omit=dev
pm2 restart open-folio
```

### Backups

From the **Remote Server tab**: click **Download backup** to download everything from the server to a timestamped folder on your local machine.

Or manually:
```bash
rsync -avz USER@SERVER_IP:~/open-folio/data/ backup/data/
rsync -avz USER@SERVER_IP:~/open-folio/public/images/ backup/images/
```

### Changing settings on the live server

Use `manage.js` (run via SSH or your provider's web console):
```bash
ssh USER@SERVER_IP
cd ~/open-folio
node manage.js
```

Options: change admin password, rotate session secret, rotate API key, change port, configure AI.

---

## Troubleshooting

**"Permission denied (publickey)" when testing SSH**  
Your SSH key isn't on the server. In the admin panel's **Remote Server tab → Server Credentials**, expand **SSH Key Setup** for instructions on adding your key.

**Site won't start (PM2 shows "errored")**  
Check the logs:
```bash
pm2 logs open-folio --lines 50
```
Most likely the `.env` is missing or incomplete — run `node manage.js` on the server to regenerate it.

**Can't reach the site in a browser**  
1. Check that the firewall allows ports 80 and 443
2. Check that DNS has propagated: `nslookup your-domain.com`
3. Check Caddy status: `sudo systemctl status caddy`

**HTTPS not working**  
Wait a few minutes after DNS propagation. Caddy fetches the certificate automatically. Check: `sudo systemctl status caddy` for errors.

**"rsync not found" on Windows**  
The Remote Server tab's sync features use rsync. On Windows, install Git for Windows (which includes rsync in Git Bash). Make sure Git Bash's bin directory is in your PATH.
