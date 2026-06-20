import express, { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { authMiddleware } from './middleware.js';
import { closeBrowser, publishNewsletter, checkSessionAlive } from './linkedin.js';
import { sessionFileExists, sessionAgeHours, writeStorageState, normaliseToStorageState } from './session.js';
import { notifySuccess, notifyFailure } from './webhook.js';
import type { PublishRequest, HealthResponse, UpdateSessionRequest } from './types.js';

// ── Mutex for serialising publish calls ────────────────────────────────────────
// LinkedIn's browser session can't handle concurrent publishes safely.
let publishInFlight = false;

// ── App ────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check — unauthenticated, used by Fly.io + crons ────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  const fileExists = sessionFileExists();
  const ageHours = sessionAgeHours();
  let sessionAlive = false;
  let message: string | undefined;

  if (!fileExists) {
    message = 'Session file not found — POST /admin/update-session to initialise';
  } else {
    try {
      sessionAlive = await checkSessionAlive();
      if (!sessionAlive) {
        message = 'LinkedIn session expired — POST /admin/update-session with fresh cookies';
      }
    } catch (err) {
      message = `Health check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const body: HealthResponse = {
    status: sessionAlive ? 'ok' : 'degraded',
    session_alive: sessionAlive,
    session_file_exists: fileExists,
    session_age_hours: fileExists ? Math.round(ageHours * 10) / 10 : undefined,
    last_checked: new Date().toISOString(),
    message,
  };

  res.status(sessionAlive ? 200 : 503).json(body);
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

    publishInFlight = true;
    logger.info('Publish request received', { newsletter, title });

    try {
      const result = await publishNewsletter({
        newsletter,
        title,
        body_markdown,
        cover_image_url,
      });

      if (result.success && result.article_url) {
        await notifySuccess(newsletter, title, result.article_url);
        res.status(200).json(result);
      } else {
        await notifyFailure(newsletter, title, result.error ?? 'Unknown error');
        const statusCode = result.error_code === 'SESSION_EXPIRED' ? 503 : 500;
        res.status(statusCode).json(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Unhandled publish error', { err: message });
      await notifyFailure(newsletter, title, message);
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
