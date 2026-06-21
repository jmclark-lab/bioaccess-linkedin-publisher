# ── Stage 1: TypeScript compiler ──────────────────────────────────────────────
# Use the official Playwright image so we have the same Node version in both stages.
FROM mcr.microsoft.com/playwright:v1.61.0-noble AS builder

WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production image ──────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

# Copy compiled JS
COPY --from=builder /build/dist ./dist

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# The Playwright image ships Chromium at a known path.
# Tell the playwright npm package not to re-download it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

# Create the data directory; on Fly.io this is overridden by a persistent volume.
RUN mkdir -p /data

EXPOSE 3000

# Health check — Fly.io also polls /health via fly.toml, but this gives Docker
# visibility too.
HEALTHCHECK --interval=60s --timeout=15s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 || r.statusCode === 503 ? 0 : 1))"

CMD ["node", "dist/index.js"]
