# bioaccess LinkedIn Newsletter Publisher — Runbook

> Internal ops doc. Do not share publicly.

**Service:** `https://bioaccess-linkedin-publisher.fly.dev`  
**Auth header:** `x-bioaccess-token: <BIOACCESS_TOKEN>`  
**Newsletters:**  
- `gta` → Global Trial Accelerators™  
- `lrd` → LATAM Regulatory Dispatch™

---

## 1. Initial Deploy

### Prerequisites
- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated (`fly auth login`)
- Docker installed locally (used only for `fly deploy`)

### Steps

```bash
cd "playwright-linkedin-service"

# Create the app (first time only)
fly apps create bioaccess-linkedin-publisher

# Create the persistent volume (first time only)
# This stores LinkedIn session cookies across deploys
fly volumes create linkedin_session --region ewr --size 1

# Set secrets (never commit these)
fly secrets set \
  BIOACCESS_TOKEN="$(openssl rand -hex 32)" \
  SUPABASE_WEBHOOK_TOKEN="<your-supabase-anon-or-service-key>"

# Deploy
fly deploy

# Confirm it's running
fly status
curl https://bioaccess-linkedin-publisher.fly.dev/health
```

After deploy, the health endpoint will return `session_alive: false` until you import cookies (Step 2).

---

## 2. Bootstrapping the LinkedIn Session (First Time)

LinkedIn has no API for newsletter publishing. We authenticate via session cookies.

### Step-by-step (takes ~5 minutes)

1. **Install "Cookie-Editor"** browser extension  
   Chrome: https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm

2. **Log into LinkedIn** as `jmclark@bioaccessla.com` in your normal browser.  
   Make sure you can see the LinkedIn home feed (not a CAPTCHA or verification page).

3. **Export cookies:**
   - Click the Cookie-Editor icon in the toolbar
   - Click "Export" → "Export as JSON"
   - Copy the entire JSON array

4. **POST the cookies to the service:**

```bash
# Replace TOKEN and paste the cookie JSON as the value of "cookies"
curl -X POST https://bioaccess-linkedin-publisher.fly.dev/admin/update-session \
  -H "x-bioaccess-token: <BIOACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"cookies": [ ... paste Cookie-Editor JSON here ... ]}'
```

   Expected response: `{"success":true,"message":"Session updated with N cookies..."}`

5. **Verify the session:**
```bash
curl https://bioaccess-linkedin-publisher.fly.dev/health
# Should return: {"status":"ok","session_alive":true,...}
```

---

## 3. Quarterly Session Refresh

LinkedIn sessions typically last 3–6 months before expiring.

**Trigger:** The `/health` endpoint returns `session_alive: false`.  
**Alert:** The Supabase webhook will also report failures.

Repeat the same steps as Section 2. The `/admin/update-session` endpoint overwrites the old cookies.

---

## 4. Publishing a Newsletter Article (Manual Test)

```bash
curl -X POST https://bioaccess-linkedin-publisher.fly.dev/publish-newsletter \
  -H "x-bioaccess-token: <BIOACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "newsletter": "gta",
    "title": "Test Article — Safe to Delete",
    "body_markdown": "## Hello World\n\nThis is a **test** from the bioaccess publisher service.\n\n- Item one\n- Item two",
    "cover_image_url": "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1200&h=628&fit=crop"
  }'
```

Expected response:
```json
{
  "success": true,
  "article_url": "https://www.linkedin.com/pulse/test-article-..."
}
```

---

## 5. Updating the Perplexity Computer Crons

Once the service is live and verified, update these two cron task bodies:

| Cron | ID | Session |
|------|-----|---------|
| GTA Newsletter | `19df4851` | `c9949730` |
| LRD Newsletter | `a0fabe2b` | `c9949730` |

Replace the `use_local_browser` / `browser_task` calls with:

```
POST https://bioaccess-linkedin-publisher.fly.dev/publish-newsletter
x-bioaccess-token: <BIOACCESS_TOKEN>
Content-Type: application/json

{
  "newsletter": "gta",
  "title": "<generated title>",
  "body_markdown": "<generated body>",
  "cover_image_url": "<optional cover URL>"
}
```

The service returns the published `article_url` which the cron can log or use downstream.

---

## 6. Debug Screenshots

If a publish fails, the service saves debug screenshots to `/data/debug-screenshots/` on the Fly volume. Access via:

```bash
fly ssh console -a bioaccess-linkedin-publisher
ls /data/debug-screenshots/
# Copy a screenshot to local:
# fly sftp get /data/debug-screenshots/error-gta-1234567890.png
```

---

## 7. Viewing Logs

```bash
fly logs -a bioaccess-linkedin-publisher
# Follow in real time:
fly logs -a bioaccess-linkedin-publisher --follow
```

---

## 8. Updating Selectors After LinkedIn UI Changes

LinkedIn's UI changes periodically. If publishes start failing, check the debug screenshots and update `src/linkedin.ts`. The selectors to update are clearly commented with `// LinkedIn article editor:` in the file.

After editing, rebuild and redeploy:
```bash
npm run build
fly deploy
```

---

## 9. Cost Estimate

| Resource | Spec | Monthly |
|----------|------|---------|
| Fly.io Machine | shared-cpu-1x, 1 GB RAM | ~$3.83 |
| Persistent Volume | 1 GB | ~$0.15 |
| **Total** | | **~$4/month** |

With `auto_stop_machines = true`, the machine only runs during active requests (~2 × weekly crons × ~3 min each). Fly's free allowance covers much of this — actual bill may be $0–$2/month.

---

## 10. Emergency: Manual Publish via Fly SSH

If the service is broken and a newsletter needs to go out immediately:

```bash
fly ssh console -a bioaccess-linkedin-publisher
# Inside the container:
node -e "
const { publishNewsletter } = require('./dist/linkedin.js');
publishNewsletter({
  newsletter: 'gta',
  title: 'Emergency Test',
  body_markdown: 'Test body',
}).then(console.log);
"
```

Or ask Sharick to publish manually on LinkedIn as the fallback (same as the current setup).
