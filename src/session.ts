/**
 * Session management helpers.
 *
 * The LinkedIn session is stored as a Playwright storage-state JSON file
 * on the Fly.io persistent volume (/data/session.json).
 *
 * Re-auth flow (when session expires):
 *   1. Julio logs into linkedin.com in his local browser.
 *   2. He uses "Cookie-Editor" (or any cookie-export extension) → Export → JSON.
 *   3. He POSTs that JSON to POST /admin/update-session with x-bioaccess-token.
 *   4. This module normalises the cookies and writes a valid storage-state file.
 */

import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import type {
  PlaywrightStorageState,
  PlaywrightCookie,
  CookieEditorCookie,
} from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function sessionFileExists(): boolean {
  return fs.existsSync(config.sessionFile);
}

/** Returns the age of the session file in hours, or Infinity if it doesn't exist. */
export function sessionAgeHours(): number {
  if (!sessionFileExists()) return Infinity;
  const stat = fs.statSync(config.sessionFile);
  return (Date.now() - stat.mtimeMs) / 3_600_000;
}

export function readStorageState(): PlaywrightStorageState | null {
  if (!sessionFileExists()) return null;
  try {
    const raw = fs.readFileSync(config.sessionFile, 'utf-8');
    return JSON.parse(raw) as PlaywrightStorageState;
  } catch (err) {
    logger.error('Failed to parse session file', { err });
    return null;
  }
}

/** Persist a storage-state object to disk (atomic write via temp file). */
export function writeStorageState(state: PlaywrightStorageState): void {
  const dir = path.dirname(config.sessionFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${config.sessionFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, config.sessionFile);
  logger.info('Session file updated', { path: config.sessionFile });
}

// ── Cookie-Editor → Playwright conversion ─────────────────────────────────────

function normaliseSameSite(raw?: string): 'Strict' | 'Lax' | 'None' {
  const s = (raw ?? 'None').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  return 'None';
}

function cookieEditorToPlaywright(c: CookieEditorCookie): PlaywrightCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? '/',
    expires: c.expirationDate ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: normaliseSameSite(c.sameSite),
  };
}

/**
 * Accept either:
 *  (a) A native Playwright storage-state object.
 *  (b) A Cookie-Editor export array and convert it.
 */
export function normaliseToStorageState(
  input: Partial<PlaywrightStorageState> & { cookies?: (PlaywrightCookie | CookieEditorCookie)[] },
): PlaywrightStorageState {
  // If it already looks like Playwright storage state
  if (input.origins !== undefined && Array.isArray(input.cookies)) {
    return input as PlaywrightStorageState;
  }

  // Cookie-Editor format: array at root or under cookies key
  const rawCookies = (Array.isArray(input) ? input : input.cookies ?? []) as CookieEditorCookie[];
  const playwrightCookies = rawCookies.map(cookieEditorToPlaywright);

  return { cookies: playwrightCookies, origins: [] };
}
