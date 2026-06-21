#!/bin/bash
# LinkedIn session upload — paste cookies directly into this terminal

echo ""
echo "=========================================="
echo "  LinkedIn Session Upload"
echo "=========================================="
echo ""
echo "  1. Go to Chrome → linkedin.com"
echo "  2. Click Cookie-Editor icon"
echo "  3. Click the Export icon (bottom-right of popup)"
echo "     → 'Export as JSON'  (copies to clipboard)"
echo ""
echo "Now: click in this Terminal window,"
echo "paste with Cmd+V, then press Ctrl+D"
echo ""
echo "Paste here ↓"

# Read cookies from stdin (paste then Ctrl+D)
cat > /tmp/li-cookies.json

echo ""
echo "Preview: $(head -c 120 /tmp/li-cookies.json)"
echo ""

# Verify it looks like a cookie array
if ! head -c 5 /tmp/li-cookies.json | grep -q '\['; then
  echo "ERROR: That doesn't look like a cookie array (should start with '[')."
  echo "Try again — export from Cookie-Editor then paste here."
  exit 1
fi

COOKIE_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/li-cookies.json'))))" 2>/dev/null || echo "?")
echo "Found $COOKIE_COUNT cookies. Uploading to Railway..."

# Build payload and POST
printf '{"cookies":' > /tmp/li-payload.json
cat /tmp/li-cookies.json >> /tmp/li-payload.json
printf '}' >> /tmp/li-payload.json

RESPONSE=$(curl -s -X POST \
  https://bioaccess-linkedin-publisher-production.up.railway.app/admin/update-session \
  -H "Content-Type: application/json" \
  -H "x-bioaccess-token: c76d794ae7d390f2fd38c460b49950f3b048bb2c14f990b04af1b056fe5aad14" \
  -d @/tmp/li-payload.json)

echo "Response: $RESPONSE"
