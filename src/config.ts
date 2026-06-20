import path from 'path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),

  /** Shared secret for x-bioaccess-token header */
  get bioaccessToken(): string {
    return required('BIOACCESS_TOKEN');
  },

  /** Absolute path to Playwright storage-state JSON (lives on persistent volume) */
  sessionFile: optional('SESSION_FILE', path.join(process.cwd(), 'data', 'session.json')),

  /** Supabase Edge Function URL for success/failure webhook */
  webhookUrl: optional(
    'SUPABASE_WEBHOOK_URL',
    'https://zwtmyuzunfdnmhmlvapy.supabase.co/functions/v1/yutori-intake',
  ),

  /** Supabase auth token for the webhook */
  webhookToken: optional('SUPABASE_WEBHOOK_TOKEN', ''),

  /** Run Playwright in headless mode (false only for local debugging) */
  playwrightHeadless: optional('PLAYWRIGHT_HEADLESS', 'true') !== 'false',

  /** Log level */
  logLevel: optional('LOG_LEVEL', 'info'),

  /** Timeout (ms) for each step in the LinkedIn flow */
  stepTimeoutMs: 30_000,

  /** Navigation timeout */
  navTimeoutMs: 45_000,
};
