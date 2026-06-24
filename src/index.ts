import express, { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { authMiddleware } from './middleware.js';
import { closeBrowser, publishNewsletter, checkSessionAlive } from './linkedin.js';
import { sessionFileExists, sessionAgeHours, writeStorageState, normaliseToStorageState } from './session.js';
import { notifySuccess, notifyFailure } from './webhook.js';
import type { PublishRequest, HealthResponse, UpdateSessionRequest, NewsletterKey } from './types.js';

// ── Mutex for serialising publish calls ────────────────────────────────────────
// LinkedIn's browser session can't handle concurrent publishes safely.
let publishInFlight = false;

// ── In-memory publish history (last 20 attempts) ──────────────────────────────
interface PublishRecord {
  at: string;           // ISO timestamp
  newsletter: string;
  title: string;
  success: boolean;
  article_url?: string;
  error?: string;
}
const publishHistory: PublishRecord[] = [];

// ── Cached session-alive probe ────────────────────────────────────────────────
// checkSessionAlive() launches a Playwright context and navigates to LinkedIn.
// That's expensive (~3–8s) and we do NOT want Railway's frequent liveness
// healthchecks to trigger it on every hit. Consumers that need a real session
// check pass `?check_session=true` to /health, which refreshes the cache.
// Other consumers (and Railway's own healthcheck) see the most-recent cached
// value, or false if nothing has been probed yet.
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface SessionCheckCache {
  alive: boolean;
  checkedAt: string; // ISO
}
let sessionCheckCache: SessionCheckCache | null = null;

/** Returns cache age in seconds, or undefined if no cache. */
function sessionCacheAgeSeconds(): number | undefined {
  if (!sessionCheckCache) return undefined;
  return Math.round((Date.now() - new Date(sessionCheckCache.checkedAt).getTime()) / 1000);
}

/**
 * Returns the current session-alive status.
 * - If forceFresh=true OR cache is missing/stale: launches a browser probe and
 *   refreshes the cache.
 * - Otherwise returns the cached value.
 */
async function getSessionAliveWithCache(forceFresh: boolean): Promise<{
  alive: boolean;
  checkedAt: string;
  freshlyChecked: boolean;
}> {
  const cacheValid =
    sessionCheckCache !== null &&
    Date.now() - new Date(sessionCheckCache.checkedAt).getTime() < SESSION_CACHE_TTL_MS;

  if (!forceFresh && cacheValid && sessionCheckCache) {
    return {
      alive: sessionCheckCache.alive,
      checkedAt: sessionCheckCache.checkedAt,
      freshlyChecked: false,
    };
  }

  if (!sessionFileExists()) {
    const now = new Date().toISOString();
    sessionCheckCache = { alive: false, checkedAt: now };
    return { alive: false, checkedAt: now, freshlyChecked: true };
  }

  try {
    const alive = await checkSessionAlive();
    const now = new Date().toISOString();
    sessionCheckCache = { alive, checkedAt: now };
    return { alive, checkedAt: now, freshlyChecked: true };
  } catch (err) {
    logger.warn('Session-alive probe threw — caching as dead', { err: String(err) });
    const now = new Date().toISOString();
    sessionCheckCache = { alive: false, checkedAt: now };
    return { alive: false, checkedAt: now, freshlyChecked: true };
  }
}

/** Threshold (hours) beyond which we warn that session will expire soon. */
const SESSION_EXPIRY_WARNING_HOURS = 72;

// ── App ────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check — unauthenticated, Railway liveness probe ───────────────────
// IMPORTANT: never launch the browser here. This endpoint must return 200
// instantly so Railway's healthcheck passes regardless of session state.
// Session validity is checked implicitly on the first publish request.

app.get('/health', async (req: Request, res: Response) => {
  const fileExists = sessionFileExists();
  const ageHours = fileExists ? Math.round(sessionAgeHours() * 10) / 10 : undefined;
  const checkSession = req.query['check_session'] === 'true' || req.query['check_session'] === '1';

  // Only probe LinkedIn if (a) consumer explicitly asked, OR (b) we have a stale/missing cache.
  // Railway's default liveness check (no query param) sees only the cached value.
  let aliveResult: { alive: boolean; checkedAt: string; freshlyChecked: boolean };
  if (checkSession) {
    aliveResult = await getSessionAliveWithCache(true);
  } else if (sessionCheckCache) {
    aliveResult = {
      alive: sessionCheckCache.alive,
      checkedAt: sessionCheckCache.checkedAt,
      freshlyChecked: false,
    };
  } else {
    // No cache yet and consumer did not ask for a fresh check — report unknown (false)
    aliveResult = { alive: false, checkedAt: new Date().toISOString(), freshlyChecked: false };
  }

  const willExpireSoon =
    ageHours !== undefined && ageHours > SESSION_EXPIRY_WARNING_HOURS;

  const lastPublishRecord = publishHistory[0];

  const body: HealthResponse = {
    status: 'ok',
    session_alive: aliveResult.alive,
    session_alive_checked_at: aliveResult.checkedAt,
    session_alive_cache_age_seconds: sessionCacheAgeSeconds(),
    session_alive_freshly_checked: aliveResult.freshlyChecked,
    session_file_exists: fileExists,
    session_age_hours: ageHours,
    session_will_expire_soon: willExpireSoon,
    last_checked: new Date().toISOString(),
    last_publish: lastPublishRecord
      ? {
          at: lastPublishRecord.at,
          newsletter: lastPublishRecord.newsletter,
          success: lastPublishRecord.success,
          article_url: lastPublishRecord.article_url,
        }
      : undefined,
    message: !fileExists
      ? 'Session file not found — POST /admin/update-session to initialise'
      : !aliveResult.alive && aliveResult.freshlyChecked
        ? 'LinkedIn session is dead. POST /admin/update-session with fresh cookies.'
        : willExpireSoon
          ? `Session is ${ageHours}h old. Refresh cookies soon to avoid expiration.`
          : undefined,
  };
  res.status(200).json(body); // always 200 — this is a liveness check, not a session check
});

// ── Publish newsletter — authenticated ────────────────────────────────────────

app.post(
  '/publish-newsletter',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    // Validate payload
    const body = req.body as Partial<PublishRequest>;
    const { newsletter, title, body_markdown, cover_image_url } = body;

    if (!newsletter || !title || !body_markdown) {
      res.status(400).json({
        error: 'Missing required fields: newsletter, title, body_markdown',
        error_code: 'VALIDATION_ERROR',
      });
      return;
    }
    if (newsletter !== 'gta' && newsletter !== 'lrd') {
      res.status(400).json({
        error: 'newsletter must be "gta" or "lrd"',
        error_code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Serialise concurrent requests — LinkedIn can't handle parallel sessions
    if (publishInFlight) {
      res.status(429).json({
        error: 'A publish is already in progress. Try again in a minute.',
        error_code: 'PUBLISH_FAILED',
      });
      return;
    }

    if (!sessionFileExists()) {
      res.status(503).json({
        error: 'No LinkedIn session found. POST /admin/update-session first.',
        error_code: 'SESSION_EXPIRED',
      });
      return;
    }

    // ── Session alive pre-check ────────────────────────────────────────────────
    // Verify the LinkedIn session is still valid before attempting to publish.
    // A dead session would cause the publish to fail silently (LinkedIn redirects
    // to the article editor without auth, Playwright sees no login wall, but the
    // Publish click silently does nothing). We gate here to return a clear error.
    const skipSessionCheck =
      req.query['skip_session_check'] === 'true' ||
      req.query['skip_session_check'] === '1' ||
      (req.body as { skip_session_check?: boolean })?.skip_session_check === true;

    let sessionAlive = true;
    if (skipSessionCheck) {
      logger.info('Skipping pre-publish session check (caller opt-out via skip_session_check)');
    } else {
      logger.info('Checking LinkedIn session before publish');
      sessionAlive = await checkSessionAlive().catch((err) => {
        logger.warn('Session alive check threw — proceeding anyway', { err: String(err) });
        return true; // don't block on a check error
      });
    }
    // Refresh the /health cache while we're at it (free, since we just probed)
    if (!skipSessionCheck) {
      sessionCheckCache = { alive: sessionAlive, checkedAt: new Date().toISOString() };
    }
    if (!sessionAlive) {
      logger.warn('LinkedIn session is dead — rejecting publish request');
      const deadSessionResult = {
        success: false,
        error: 'LinkedIn session has expired. POST /admin/update-session with fresh cookies before publishing. (To bypass this gate, pass ?skip_session_check=true.)',
        error_code: 'SESSION_EXPIRED',
      };
      await notifyFailure(newsletter as NewsletterKey, title!, deadSessionResult.error);
      publishHistory.unshift({ at: new Date().toISOString(), newsletter: newsletter!, title: title!, success: false, error: deadSessionResult.error });
      if (publishHistory.length > 20) publishHistory.pop();
      res.status(503).json(deadSessionResult);
      return;
    }

    publishInFlight = true;
    logger.info('Publish request received', { newsletter, title });

    try {
      const result = await publishNewsletter({
        newsletter,
        title,
        body_markdown,
        cover_image_url,
      });

      // Record in publish history
      publishHistory.unshift({
        at: new Date().toISOString(),
        newsletter: newsletter!,
        title: title!,
        success: result.success,
        article_url: result.article_url,
        error: result.error,
      });
      if (publishHistory.length > 20) publishHistory.pop();

      if (result.success && result.article_url) {
        await notifySuccess(newsletter as NewsletterKey, title!, result.article_url);
        res.status(200).json(result);
      } else {
        await notifyFailure(newsletter as NewsletterKey, title!, result.error ?? 'Unknown error');
        const statusCode = result.error_code === 'SESSION_EXPIRED' ? 503 : 500;
        res.status(statusCode).json(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Unhandled publish error', { err: message });
      publishHistory.unshift({ at: new Date().toISOString(), newsletter: newsletter!, title: title!, success: false, error: message });
      if (publishHistory.length > 20) publishHistory.pop();
      await notifyFailure(newsletter as NewsletterKey, title!, message);
      res.status(500).json({ success: false, error: message, error_code: 'INTERNAL_ERROR' });
    } finally {
      publishInFlight = false;
    }
  },
);

// ── Session update — authenticated admin endpoint ─────────────────────────────
//
// Use this to import fresh LinkedIn cookies after the session expires.
// See RUNBOOK.md for step-by-step instructions.

app.post(
  '/admin/update-session',
  authMiddleware,
  (req: Request, res: Response): void => {
    try {
      const input = req.body as UpdateSessionRequest;
      if (!input || (typeof input !== 'object')) {
        res.status(400).json({ error: 'Body must be a JSON object' });
        return;
      }

      const state = normaliseToStorageState(
        // Accept: { storage_state: {...} } or { cookies: [...] } or raw array
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (input as any).storage_state ?? (input as any).cookies ?? input,
      );

      if (!state.cookies || state.cookies.length === 0) {
        res.status(400).json({ error: 'No cookies found in payload' });
        return;
      }

      writeStorageState(state);
      logger.info('Session updated via admin endpoint', { cookieCount: state.cookies.length });
      res.status(200).json({
        success: true,
        message: `Session updated with ${state.cookies.length} cookies. Run GET /health to verify.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Session update failed', { err: message });
      res.status(500).json({ error: message });
    }
  },
);

// ── Publish history — authenticated ──────────────────────────────────────────

app.get('/admin/last-runs', authMiddleware, (req: Request, res: Response): void => {
  const n = Math.min(parseInt((req.query['n'] as string) ?? '10', 10), 20);
  res.status(200).json({ runs: publishHistory.slice(0, n), total: publishHistory.length });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Browser is launched lazily on first publish request — do not init here.
  // Eager init caused crash-loops on Railway because Chromium failed to start
  // before the healthcheck endpoint was ready.

  app.listen(config.port, () => {
    logger.info(`bioaccess LinkedIn Publisher listening on :${config.port}`);
    logger.info('Endpoints:', {
      health: 'GET /health',
      publish: 'POST /publish-newsletter  (x-bioaccess-token required)',
      updateSession: 'POST /admin/update-session  (x-bioaccess-token required)',
    });
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — shutting down');
    await closeBrowser();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    logger.info('SIGINT received — shutting down');
    await closeBrowser();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});
