# bioaccess LinkedIn Newsletter Publisher — Runbook

> Internal ops doc. Do not share publicly.

**Service URL:** `https://bioaccess-linkedin-publisher-production.up.railway.app`  
**Auth header:** `x-bioaccess-token: <BIOACCESS_TOKEN>`  
**Newsletters:**
- `gta` → Global Trial Accelerators™
- `lrd` → LATAM Regulatory Dispatch™

---

## 1. Railway Setup (first time or after service loss)

### Prerequisites
- Railway account at [railway.app](https://railway.app)
- GitHub repo: `https://github.com/jmclark-lab/bioaccess-linkedin-publisher`

### Steps in Railway dashboard

1. Create project → **New Project** → **Deploy from GitHub repo** → select `jmclark-lab/bioaccess-linkedin-publisher`
2. Railway auto-detects `railway.toml` and uses the Dockerfile.
3. **Variables tab** → add these secrets:

   | Variable | Value |
   |----------|-------|
   | `BIOACCESS_TOKEN` | `c76d794ae7d390f2fd38c460b49950f3b048bb2c14f990b04af1b056fe5aad14` |
   | `SUPABASE_WEBHOOK_TOKEN` | *(your Supabase service key)* |

   > `SESSION_FILE` defaults to `/data/session.json` — no override needed.

4. **Volumes tab** → **New Volume** → Mount path: `/data` → Size: 1 GB
   > This is where LinkedIn cookies persist across redeploys. Without this volume, cookies reset on every deploy.

5. Wait for the build to complete (2–4 min — the Playwright image is large).
6. Verify:

```bash
curl https://bioaccess-linkedin-publisher-production.up.railway.app/health
# Expected: {"status":"ok","session_file_exists":false,...}
```

After deploy, `session_file_exists` will be `false` until you upload cookies (Section 2).

---

## 2. Bootstrapping the LinkedIn Session (first time or after expiry)

LinkedIn has no API for newsletter publishing. We authenticate via session cookies.

### Step-by-step (~5 minutes)

1. **Install "Cookie-Editor"** browser extension
   Chrome: https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm
   Use **v1.13.0** — newer versions removed the clipboard export button.

2. **Log into LinkedIn** as `jmclark@bioaccessla.com` in your normal browser.
   Make sure you see the LinkedIn home feed (not a CAPTCHA or verification page).

3. **Export cookies:**
   - Click the Cookie-Editor icon
   - Click **Export** → **Export as JSON** → copies to clipboard

4. **Run the upload script** from the `playwright-linkedin-service` folder:

```bash
cd "~/Claude/Projects/Website Updates/playwright-linkedin-service"
./upload-session.sh
```

   When prompted, **paste** the cookie JSON (Cmd+V) and press **Ctrl+D**.
   Do not type anything else after pasting — extra input corrupts the file.

   Expected output:
   ```
   Found 23 cookies. Uploading to Railway...
   Response: {"success":true,"message":"Session updated with 23 cookies..."}
   ```

5. **Verify:**
```bash
curl https://bioaccess-linkedin-publisher-production.up.railway.app/health
# Expected: {"status":"ok","session_file_exists":true,...}
```

   > `session_alive` will show `false` — this is normal. It only becomes `true`
   > after the first actual publish call (browser launches lazily).

---

## 3. Quarterly Session Refresh

LinkedIn sessions last 3–6 months.

**Trigger:** Perplexity cron returns a `SESSION_EXPIRED` error, or `/health` returns `session_file_exists: false`.

Repeat Section 2. The `/admin/update-session` endpoint overwrites the old cookies.

---

## 4. Publishing a Newsletter Article (Manual Test)

```bash
curl -X POST https://bioaccess-linkedin-publisher-production.up.railway.app/publish-newsletter \
  -H "x-bioaccess-token: c76d794ae7d390f2fd38c460b49950f3b048bb2c14f990b04af1b056fe5aad14" \
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

## 5. Perplexity Crons

The two Perplexity crons handle content generation and call this service for the publish step.

| Cron | Newsletter | Schedule |
|------|------------|----------|
| GTA (`0fc88c0b`) | Global Trial Accelerators™ | Tuesday 10 AM ET |
| LRD (`73b61ccd`) | LATAM Regulatory Dispatch™ | Wednesday 10 AM ET |

Each cron POSTs to:
```
POST https://bioaccess-linkedin-publisher-production.up.railway.app/publish-newsletter
x-bioaccess-token: c76d794ae7d390f2fd38c460b49950f3b048bb2c14f990b04af1b056fe5aad14
Content-Type: application/json

{
  "newsletter": "gta" | "lrd",
  "title": "<generated title>",
  "body_markdown": "<generated body>",
  "cover_image_url": "<optional cover URL>"
}
```

The service returns `{"success": true, "article_url": "..."}` on success.

---

## 6. Diagnosing a Failed Deployment ("Application not found")

Railway returns "Application not found" when the service isn't running or the domain mapping is lost.

**Step 1 — Check Railway dashboard:**
1. Go to [railway.app](https://railway.app) → your project
2. Click the `bioaccess-linkedin-publisher` service
3. Look at the **Deployments** tab:
   - 🟢 **Active** → service is running; check if the domain is correct under Settings → Networking
   - 🔴 **Failed/Crashed** → open the deployment → **View Logs** → look for the error

**Most common crash cause:** `Missing required environment variable: BIOACCESS_TOKEN`
Fix: Go to **Variables** tab → add `BIOACCESS_TOKEN` → Railway auto-redeploys.

**Step 2 — Force redeploy:**
In the Deployments tab → click the latest deployment → **Redeploy**.

**Step 3 — Verify the domain:**
Settings → Networking → the generated domain should be:
`bioaccess-linkedin-publisher-production.up.railway.app`
If it shows a different URL, use that URL instead (and update the Perplexity crons).

---

## 7. Viewing Logs

**Railway dashboard:** Project → Service → **Logs** tab (real-time).

**Via CLI (optional):**
```bash
brew install railway
railway login
railway link   # select romantic-insight project, bioaccess-linkedin-publisher service
railway logs
```

---

## 8. Debug Screenshots

If a publish fails, the service saves debug screenshots to `/data/debug-screenshots/` on the Railway volume. Access via Railway dashboard → **Volumes** tab → browse files, or via CLI:

```bash
railway run ls /data/debug-screenshots/
```

---

## 9. Updating Selectors After LinkedIn UI Changes

LinkedIn's UI changes periodically. If publishes start failing, check the debug screenshots and update `src/linkedin.ts`. Selectors are clearly commented with `// LinkedIn article editor:`.

After editing:
```bash
npm run build
git add -A && git commit -m "fix: update LinkedIn selectors"
git push
# Railway auto-deploys from the main branch
```

---

## 10. Cost Estimate

| Resource | Spec | Monthly |
|----------|------|---------|
| Railway Hobby | Shared CPU, 512 MB RAM | ~$5 base |
| Persistent Volume | 1 GB | ~$0.25 |
| **Total** | | **~$5–6/month** |

Railway bills by usage. The service sleeps between requests (2× weekly crons × ~3 min each). Actual compute cost is minimal on top of the base plan.

---

## 11. Emergency: Manual Publish via Railway CLI

If the service is broken and a newsletter needs to go out immediately:

```bash
railway run node -e "
const { publishNewsletter } = require('./dist/linkedin.js');
publishNewsletter({
  newsletter: 'gta',
  title: 'Emergency Test',
  body_markdown: 'Test body',
}).then(console.log);
"
```

Or ask Sharick to publish manually on LinkedIn as the fallback.
