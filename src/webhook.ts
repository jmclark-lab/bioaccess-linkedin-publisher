import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';
import type { WebhookPayload, NewsletterKey } from './types.js';

export async function sendWebhook(payload: WebhookPayload): Promise<void> {
  if (!config.webhookToken) {
    logger.warn('SUPABASE_WEBHOOK_TOKEN not set — skipping webhook');
    return;
  }

  try {
    await axios.post(config.webhookUrl, payload, {
      headers: {
        Authorization: `Bearer ${config.webhookToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
    logger.info('Webhook sent', { type: payload.type, newsletter: payload.newsletter });
  } catch (err) {
    // Non-fatal — don't bubble this up to the caller
    logger.error('Webhook delivery failed', { err, payload });
  }
}

export async function notifySuccess(
  newsletter: NewsletterKey,
  title: string,
  articleUrl: string,
): Promise<void> {
  await sendWebhook({
    type: 'newsletter_published',
    newsletter,
    title,
    article_url: articleUrl,
    success: true,
    timestamp: new Date().toISOString(),
  });
}

export async function notifyFailure(
  newsletter: NewsletterKey,
  title: string,
  error: string,
): Promise<void> {
  await sendWebhook({
    type: 'newsletter_failed',
    newsletter,
    title,
    error,
    success: false,
    timestamp: new Date().toISOString(),
  });
}
