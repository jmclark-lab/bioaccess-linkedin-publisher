export type NewsletterKey = 'gta' | 'lrd';

export interface NewsletterConfig {
  displayName: string;
  /** Public URL of the newsletter index page — used to click the "Write" button */
  indexUrl: string;
}

export const NEWSLETTERS: Record<NewsletterKey, NewsletterConfig> = {
  gta: {
    displayName: 'Global Trial Accelerators™',
    indexUrl: 'https://www.linkedin.com/newsletters/global-trial-accelerators',
  },
  lrd: {
    displayName: 'LATAM Regulatory Dispatch™',
    indexUrl: 'https://www.linkedin.com/newsletters/latam-regulatory-dispatch%E2%84%A2-7448736447437803520/',
  },
};

// ── Request / Response ────────────────────────────────────────────────────────

export interface PublishRequest {
  newsletter: NewsletterKey;
  title: string;
  body_markdown: string;
  cover_image_url?: string;
}

export interface PublishResponse {
  success: boolean;
  article_url?: string;
  error?: string;
  error_code?: 'SESSION_EXPIRED' | 'VALIDATION_ERROR' | 'PUBLISH_FAILED' | 'INTERNAL_ERROR';
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  session_alive: boolean;
  session_file_exists: boolean;
  session_age_hours?: number;
  last_checked: string;
  message?: string;
}

export interface UpdateSessionRequest {
  /**
   * Accept either:
   *  (a) Native Playwright storage-state JSON  { cookies: [...], origins: [...] }
   *  (b) Cookie-Editor export — an array of cookie objects
   */
  storage_state?: PlaywrightStorageState;
  cookies?: CookieEditorCookie[];
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: unknown[];
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface CookieEditorCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  storeId?: string;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export interface WebhookPayload {
  type: 'newsletter_published' | 'newsletter_failed';
  newsletter: NewsletterKey;
  title: string;
  article_url?: string;
  error?: string;
  success: boolean;
  timestamp: string;
}
