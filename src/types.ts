export type NewsletterKey = 'gta' | 'lrd';

export interface NewsletterConfig {
  displayName: string;
  /**
   * The numeric LinkedIn newsletter ID (from the newsletter URL).
   * Used as a fallback for direct URL navigation. Optional — the primary
   * flow uses the /article/new/ dropdown to select the newsletter.
   */
  newsletterId?: string;
}

export const NEWSLETTERS: Record<NewsletterKey, NewsletterConfig> = {
  gta: {
    displayName: 'Global Trial Accelerators™',
    // GTA newsletter ID not confirmed; the /article/new/ dropdown flow handles this.
  },
  lrd: {
    displayName: 'LATAM Regulatory Dispatch™',
    newsletterId: '7448736447437803520',
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
  session_alive_checked_at?: string;
  session_alive_cache_age_seconds?: number;
  session_alive_freshly_checked?: boolean;
  session_file_exists: boolean;
  session_age_hours?: number;
  session_will_expire_soon?: boolean;
  last_checked: string;
  last_publish?: {
    at: string;
    newsletter: string;
    success: boolean;
    article_url?: string;
  };
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
