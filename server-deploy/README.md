# Techsara Signaling Server — Render Deployment

This folder is a self-contained, deploy-ready copy of the signaling server +
support dashboard. Hosting it on Render gives you a **permanent HTTPS URL** that
never changes, so the "Connection Error" caused by expiring Cloudflare tunnels
cannot happen again.

## What's in here
- `server.js`      — signaling server (Socket.IO + WebRTC relay) + serves the dashboard
- `dashboard/`     — the support agent web UI (served at the site root `/`)
- `package.json`   — has the `start` script Render needs
- `render.yaml`    — Render Blueprint (free plan, health check pre-configured)
- `.gitignore`     — keeps `node_modules` out of the repo

## Deploy steps (one time)

### 1. Put this folder on GitHub
- Create a new repository at https://github.com/new — e.g. `techsara-server`.
- Upload **the contents of this `server-deploy` folder** to that repo
  (`server.js`, `package.json`, `render.yaml`, `.gitignore`, and the
  `dashboard/` folder). Do NOT upload `node_modules`.

### 2. Create the Render service
- Go to https://render.com and sign up (free, no credit card).
- Click **New +** → **Web Service** → connect your GitHub repo.
- Render auto-detects the settings from `render.yaml`. Confirm:
  - Runtime: **Node**
  - Build command: `npm install`
  - Start command: `npm start`
  - Instance type: **Free**
- Click **Create Web Service**. First build takes ~2 minutes.

### 3. Copy your permanent URL
- After deploy, Render shows a URL like `https://techsara-server.onrender.com`.
- Open it in a browser — you should see the support dashboard.

### 4. Point all clients at it (one POST to the discovery service)
The installed client apps look up the server via npoint.io. Run this once
(PowerShell) with YOUR Render URL:

```powershell
$body = @{ url = "https://YOUR-APP.onrender.com" } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.npoint.io/42f501da0967893db41c" -Method Post -Body $body -ContentType "application/json"
```

Every client laptop reconnects automatically within ~10 seconds. No reinstall.

## Keep it awake (avoid cold starts)
Render's free tier sleeps a service after 15 minutes of no traffic; the next
connection then waits ~50s while it wakes. To prevent that, set up a free
external pinger to hit the health endpoint every ~10 minutes:
- Go to https://cron-job.org (free), create a job that GETs
  `https://YOUR-APP.onrender.com/healthz` every 10 minutes.

That keeps the server warm 24/7 and stays within Render's free monthly hours.

## Important note
The agent login password is currently hardcoded as `admin123` in `server.js`.
Change it before sharing the dashboard URL publicly.
