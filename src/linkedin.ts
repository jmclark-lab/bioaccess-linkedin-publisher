/**
 * linkedin.ts — Playwright automation for publishing LinkedIn Newsletter articles.
 *
 * LinkedIn has NO public API for newsletter publishing. This module drives the
 * LinkedIn web UI to create and publish newsletter articles.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────
 * 1. Load persistent session cookies from disk.
 * 2. Navigate to the newsletter index page (e.g. /newsletters/global-trial-accelerators).
 * 3. Click the "Write article" button that LinkedIn renders for newsletter admins.
 * 4. In the article editor:
 *    a. Upload cover image (if provided — downloaded from URL, temp file).
 *    b. Fill in the title.
 *    c. Paste the body (markdown → HTML → paste via execCommand).
 * 5. Click "Next" then "Publish".
 * 6. Capture and return the published article URL.
 * 7. Save updated cookies back to disk.
 *
 * ── Selector strategy ─────────────────────────────────────────────────────────
 * LinkedIn uses dynamic class names. We prefer:
 *   - ARIA roles + accessible names
 *   - data-* attributes
 *   - Visible text / placeholder text
 *   - CSS classes only as last resort (with a comment to update when LinkedIn changes them)
 *
 * ── Anti-detection ────────────────────────────────────────────────────────────
 * We launch with --disable-blink-features=AutomationControlled and mask navigator.webdriver.
 * Human-like delays are added between major interactions.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { marked } from 'marked';
import { config } from './config.js';
import { logger } from './logger.js';
import { sessionFileExists, readStorageState } from './session.js';
import type { PublishRequest, PublishResponse, NewsletterKey } from './types.js';
import { NEWSLETTERS } from './types.js';

// ── Singleton browser instance ─────────────────────────────────────────────────

let browser: Browser | null = null;

export async function initBrowser(): Promise<void> {
  if (browser) return;
  logger.info('Launching Playwright Chromium browser');
  browser = await chromium.launch({
    headless: config.playwrightHeadless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
    ],
  });
  logger.info('Browser launched');
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Browser closed');
  }
}

// ── Context factory ────────────────────────────────────────────────────────────

async function createContext(): Promise<BrowserContext> {
  if (!browser) await initBrowser();

  const storageState = sessionFileExists() ? config.sessionFile : undefined;

  const context = await browser!.newContext({
    storageState,
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Mask automation flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).chrome?.runtime;
  });

  return context;
}

// ── Session health check ───────────────────────────────────────────────────────

/**
 * Opens a browser context, navigates to LinkedIn, and checks whether
 * the session is alive by looking for the authenticated feed indicator.
 */
export async function checkSessionAlive(): Promise<boolean> {
  if (!sessionFileExists()) return false;

  const context = await createContext();
  const page = await context.newPage();
  try {
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
    // If redirected to /login or /authwall, session is dead
    const url = page.url();
    if (url.includes('/login') || url.includes('/authwall') || url.includes('/checkpoint')) {
      logger.warn('Session expired — redirected to', { url });
      return false;
    }
    // Look for the global navigation bar that only appears when logged in
    const navExists = await page
      .locator('[data-test-global-nav-link="home"], nav[aria-label*="primary" i], .global-nav__me')
      .first()
      .isVisible()
      .catch(() => false);
    return navExists;
  } catch (err) {
    logger.error('Session check failed', { err });
    return false;
  } finally {
    await context.close();
  }
}

// ── Markdown → HTML ────────────────────────────────────────────────────────────

async function markdownToHtml(md: string): Promise<string> {
  // marked returns string (not Promise) in v15, but type says Promise | string
  const result = await marked(md);
  return result;
}

// ── Cover image ────────────────────────────────────────────────────────────────

async function downloadImageToTemp(url: string): Promise<string> {
  const response = await axios.get<Buffer>(url, { responseType: 'arraybuffer', timeout: 30_000 });
  const contentType: string = (response.headers['content-type'] as string) ?? 'image/jpeg';
  const ext = contentType.includes('png') ? '.png' : contentType.includes('gif') ? '.gif' : '.jpg';
  const tmpPath = path.join(os.tmpdir(), `cover-${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, response.data);
  return tmpPath;
}

async function uploadCoverImage(page: Page, imageUrl: string): Promise<void> {
  logger.info('Uploading cover image', { imageUrl });
  let tmpPath: string | null = null;
  try {
    tmpPath = await downloadImageToTemp(imageUrl);

    // LinkedIn article editor: look for the cover image upload button/area
    // This may be a button labelled "Add a cover photo" or an <input type="file">
    const coverButton = page
      .locator(
        '[aria-label*="cover" i], button:has-text("Add a cover"), button:has-text("Upload")',
      )
      .first();

    if (await coverButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Intercept the file chooser dialog
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: config.stepTimeoutMs }),
        coverButton.click(),
      ]);
      await fileChooser.setFiles(tmpPath);
      await humanDelay(1500);
    } else {
      // Try finding a hidden <input type="file"> that accepts images
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(tmpPath);
        await humanDelay(1500);
      } else {
        logger.warn('Cover image upload button not found — skipping');
      }
    }
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── Human-like delay ──────────────────────────────────────────────────────────

function humanDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms + Math.random() * 300));
}

// ── Debug screenshots ─────────────────────────────────────────────────────────

async function saveDebugScreenshot(page: Page, label: string): Promise<void> {
  try {
    const dir = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logger.info('Debug screenshot saved', { file });
  } catch {
    // Non-fatal
  }
}

// ── Main publish flow ─────────────────────────────────────────────────────────

export async function publishNewsletter(req: PublishRequest): Promise<PublishResponse> {
  const newsletter = NEWSLETTERS[req.newsletter];
  logger.info('Starting publish flow', {
    newsletter: req.newsletter,
    title: req.title,
  });

  const context = await createContext();
  const page = await context.newPage();

  // Generous default timeouts
  page.setDefaultTimeout(config.stepTimeoutMs);
  page.setDefaultNavigationTimeout(config.navTimeoutMs);

  try {
    // ── Step 1: Navigate to the newsletter index page ─────────────────────────
    logger.info('Navigating to newsletter page', { url: newsletter.indexUrl });
    await page.goto(newsletter.indexUrl, { waitUntil: 'domcontentloaded' });

    // Check for auth wall
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      return {
        success: false,
        error: 'LinkedIn session has expired. Use POST /admin/update-session to re-authenticate.',
        error_code: 'SESSION_EXPIRED',
      };
    }

    await humanDelay(2000);

    // ── Step 2: Click the "Write article" / "Create episode" button ───────────
    logger.info('Looking for Write Article button');
    await saveDebugScreenshot(page, `01-newsletter-page-${req.newsletter}`);

    // LinkedIn shows a "Write article" or "Create episode" button for newsletter admins
    const writeButton = page
      .locator([
        'button:has-text("Write article")',
        'a:has-text("Write article")',
        'button:has-text("Create episode")',
        'a:has-text("Create episode")',
        'button:has-text("Write a newsletter")',
        '[aria-label*="Write article" i]',
      ].join(', '))
      .first();

    await writeButton.waitFor({ state: 'visible', timeout: config.stepTimeoutMs });
    await writeButton.click();
    logger.info('Clicked Write Article button');
    await humanDelay(3000);

    // ── Step 3: Wait for article editor to open ───────────────────────────────
    // LinkedIn article editor lands at /pulse/article/new or /pulse/new-article
    await page.waitForURL(
      (url) =>
        url.href.includes('/pulse/article/new') ||
        url.href.includes('/pulse/new-article') ||
        url.href.includes('/article/new'),
      { timeout: config.navTimeoutMs },
    );
    logger.info('Article editor opened', { url: page.url() });
    await humanDelay(2000);
    await saveDebugScreenshot(page, `02-editor-open-${req.newsletter}`);

    // ── Step 4: Select the newsletter (if a picker appears) ──────────────────
    // When the editor opens from the newsletter page, LinkedIn may auto-associate
    // the newsletter. If a "Select newsletter" prompt appears, pick the right one.
    await selectNewsletter(page, req.newsletter, newsletter.displayName);

    // ── Step 5: Upload cover image ────────────────────────────────────────────
    if (req.cover_image_url) {
      await uploadCoverImage(page, req.cover_image_url);
      await saveDebugScreenshot(page, `03-cover-uploaded-${req.newsletter}`);
    }

    // ── Step 6: Fill in title ─────────────────────────────────────────────────
    logger.info('Filling title');
    const titleField = page
      .locator(
        '[placeholder*="Title" i], [data-placeholder*="Title" i], [aria-label*="Article title" i], h1[contenteditable="true"]',
      )
      .first();
    await titleField.waitFor({ state: 'visible', timeout: config.stepTimeoutMs });
    await titleField.click();
    await titleField.fill(''); // clear any placeholder
    await page.keyboard.type(req.title, { delay: 30 });
    await humanDelay(800);

    // ── Step 7: Fill in body ──────────────────────────────────────────────────
    logger.info('Filling body');
    const bodyHtml = await markdownToHtml(req.body_markdown);

    // The article body editor is a contenteditable Quill div
    const bodyEditor = page
      .locator(
        '[data-placeholder*="Write here" i], .ql-editor, [placeholder*="Write here" i], [aria-label*="Article body" i], [contenteditable="true"]:not(h1)',
      )
      .first();
    await bodyEditor.waitFor({ state: 'visible', timeout: config.stepTimeoutMs });
    await bodyEditor.click();

    // Insert HTML via execCommand — most reliable approach for Quill-based editors
    await page.evaluate((html) => {
      const editor =
        document.querySelector('[data-placeholder*="Write here" i]') ||
        document.querySelector('.ql-editor') ||
        (() => {
          const all = Array.from(document.querySelectorAll('[contenteditable="true"]'));
          // The body editor is not an h1
          return all.find((el) => el.tagName !== 'H1');
        })();
      if (!editor) return;
      (editor as HTMLElement).focus();
      document.execCommand('selectAll', false, undefined);
      document.execCommand('insertHTML', false, html);
    }, bodyHtml);

    await humanDelay(1000);
    await saveDebugScreenshot(page, `04-body-filled-${req.newsletter}`);

    // ── Step 8: Click "Next" ──────────────────────────────────────────────────
    logger.info('Clicking Next');
    const nextButton = page
      .locator('button:has-text("Next"), [aria-label="Next"]')
      .first();
    await nextButton.waitFor({ state: 'visible', timeout: config.stepTimeoutMs });
    await nextButton.click();
    await humanDelay(2000);
    await saveDebugScreenshot(page, `05-next-clicked-${req.newsletter}`);

    // ── Step 9: Click "Publish" ───────────────────────────────────────────────
    logger.info('Clicking Publish');
    const publishButton = page
      .locator('button:has-text("Publish"), [aria-label="Publish"]')
      .first();
    await publishButton.waitFor({ state: 'visible', timeout: config.stepTimeoutMs });
    await publishButton.click();

    // Wait for navigation to the published article
    await page.waitForURL(
      (url) =>
        url.href.includes('/pulse/') &&
        !url.href.includes('/new') &&
        !url.href.includes('/article/new'),
      { timeout: config.navTimeoutMs },
    );

    const articleUrl = page.url();
    logger.info('Article published successfully', { articleUrl });
    await saveDebugScreenshot(page, `06-published-${req.newsletter}`);

    // ── Step 10: Save updated session cookies ─────────────────────────────────
    await context.storageState({ path: config.sessionFile });
    logger.info('Session cookies refreshed');

    return { success: true, article_url: articleUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Publish flow failed', { err: message, newsletter: req.newsletter });
    await saveDebugScreenshot(page, `error-${req.newsletter}`).catch(() => {});

    const errorCode = message.includes('SESSION_EXPIRED') ? 'SESSION_EXPIRED' : 'PUBLISH_FAILED';
    return {
      success: false,
      error: message,
      error_code: errorCode,
    };
  } finally {
    await context.close();
  }
}

// ── Newsletter selector helper ────────────────────────────────────────────────

/**
 * After the article editor opens, LinkedIn may show a newsletter picker
 * (a modal or dropdown) when multiple newsletters exist. This function
 * handles that case.
 *
 * If the editor was opened from the newsletter index page, LinkedIn typically
 * auto-selects that newsletter and skips the picker — so this is a no-op.
 */
async function selectNewsletter(
  page: Page,
  key: NewsletterKey,
  displayName: string,
): Promise<void> {
  // Give the editor 3 seconds to show a picker if one exists
  await humanDelay(3000);

  // Look for a modal or dropdown that lists newsletters
  const pickerVisible = await page
    .locator('[aria-label*="newsletter" i], [data-test*="newsletter"], .newsletter-picker')
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);

  if (!pickerVisible) {
    logger.info('No newsletter picker appeared — newsletter auto-selected');
    return;
  }

  logger.info('Newsletter picker detected — selecting', { displayName });

  // Click the option that matches our newsletter's display name
  const option = page
    .locator(`text="${displayName}", [aria-label*="${displayName}" i]`)
    .first();

  if (await option.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await option.click();
    await humanDelay(1000);
  } else {
    // Try a partial match (strip the ™ if it causes encoding issues)
    const partial = displayName.replace('™', '').trim();
    const partialOption = page.locator(`text*="${partial}"`).first();
    await partialOption.click();
    await humanDelay(1000);
  }
  logger.info('Newsletter selected in picker');
}
