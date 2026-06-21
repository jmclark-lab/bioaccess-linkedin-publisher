/**
 * linkedin.ts — Playwright automation for publishing LinkedIn Newsletter articles.
 *
 * LinkedIn has NO public API for newsletter publishing. This module drives the
 * LinkedIn web UI to create and publish newsletter articles.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────
 * 1. Load persistent session cookies from disk.
 * 2. Navigate to https://www.linkedin.com/article/new/
 * 3. Open the "Publish as / Publish to" dropdown at the top of the editor.
 *    a. Under "Publish as": select "Julio G. Martinez-Clark" (personal profile).
 *    b. Under "Publish to": select the target newsletter by display name.
 * 4. In the article editor:
 *    a. Upload cover image (if provided — downloaded from URL, temp file).
 *    b. Fill in the title.
 *    c. Paste the body (markdown → HTML → paste via execCommand).
 * 5. Click "Next" then "Publish".
 * 6. Capture and return the published article URL.
 * 7. Save updated cookies back to disk.
 *
 * ── Why /article/new/ instead of newsletter index page ────────────────────────
 * The previous flow navigated to the newsletter index page and clicked "Write article".
 * For GTA, the index URL (https://www.linkedin.com/newsletters/global-trial-accelerators)
 * has no numeric ID suffix and returns "Something went wrong". The /article/new/ approach
 * uses the LinkedIn article editor directly and presents a newsletter picker dropdown
 * that works reliably for all newsletters the account manages.
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
import type { PublishRequest, PublishResponse } from './types.js';
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
    // ── Step 1: Navigate to the article editor ────────────────────────────────
    // We go directly to /article/new/ rather than the newsletter index page.
    // The newsletter index approach is broken for GTA (URL has no numeric ID).
    // The editor's author/newsletter dropdown lets us select any newsletter.
    logger.info('Navigating to article editor');
    await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded' });

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
    await saveDebugScreenshot(page, `01-editor-opened-${req.newsletter}`);

    // ── Step 2: Select "Julio G. Martinez-Clark" (Publish as) + newsletter ────
    // The editor shows a dropdown at the top-left with "Publish as" and "Publish to"
    // sections. We must select Julio's personal profile and the target newsletter.
    await selectAuthorAndNewsletter(page, newsletter.displayName);
    await saveDebugScreenshot(page, `02-newsletter-selected-${req.newsletter}`);

    // ── Step 3: Upload cover image ────────────────────────────────────────────
    if (req.cover_image_url) {
      await uploadCoverImage(page, req.cover_image_url);
      await saveDebugScreenshot(page, `03-cover-uploaded-${req.newsletter}`);
    }

    // ── Step 4: Fill in title ─────────────────────────────────────────────────
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

    // ── Step 5: Fill in body ──────────────────────────────────────────────────
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

    // ── Step 6: Click "Next" ──────────────────────────────────────────────────
    logger.info('Clicking Next');
    const nextButton = page
      .locator('button:has-text("Next"), [aria-label="Next"]')
      .first();
    await nextButton.waitFor({ state: 'visible', timeout: config.stepTimeoutMs });
    await nextButton.click();
    await humanDelay(2000);
    await saveDebugScreenshot(page, `05-next-clicked-${req.newsletter}`);

    // ── Step 7: Click "Publish" ───────────────────────────────────────────────
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

    // ── Step 8: Save updated session cookies ──────────────────────────────────
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

// ── Author + newsletter picker helper ─────────────────────────────────────────

/**
 * Opens the "Publish as / Publish to" dropdown at the top of the article editor
 * and selects:
 *   - "Publish as": Julio G. Martinez-Clark (personal profile)
 *   - "Publish to": the target newsletter by display name
 *
 * The dropdown is a panel with two sections:
 *   "Publish as" — list of author profiles (personal + company pages)
 *   "Publish to" — "Individual article" or a newsletter
 *
 * Confirmed via browser investigation on 2026-06-21: the dropdown trigger is a
 * button in the editor header containing a profile photo and the current
 * author/newsletter name. After selecting Julio under "Publish as", the URL
 * updates to ?author=urn:li:fsd_profile:... and the "Publish to" list shows
 * "Individual article", "LATAM Regulatory Dispatch™", and "Global Trial Accelerators™".
 */
async function selectAuthorAndNewsletter(
  page: Page,
  newsletterDisplayName: string,
): Promise<void> {
  const AUTHOR_NAME = 'Julio G. Martinez-Clark';

  // ── Open the dropdown ──────────────────────────────────────────────────────
  logger.info('Opening author/newsletter dropdown');
  let dropdownOpened = false;

  // Try Playwright locators first (most stable)
  const triggerSelectors = [
    'button[aria-haspopup="listbox"]',
    'button[aria-haspopup="true"]',
    '[role="button"][aria-haspopup]',
    '.artdeco-dropdown__trigger',
  ];

  for (const sel of triggerSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.click();
      await humanDelay(800);
      const hasPublishAs = await page
        .getByText('Publish as', { exact: false })
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (hasPublishAs) {
        dropdownOpened = true;
        logger.info('Dropdown opened via selector', { sel });
        break;
      }
    }
  }

  // JavaScript fallback: find a small button near the top of the page with a profile photo
  if (!dropdownOpened) {
    logger.info('Trying JS fallback for dropdown trigger');
    const jsOpened = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"]'),
      ) as HTMLElement[];
      for (const el of candidates) {
        if (el.querySelector('img')) {
          const rect = el.getBoundingClientRect();
          // The trigger is in the editor header: y < 150, not far right
          if (rect.top < 150 && rect.top > 5 && rect.left < 700 && rect.width > 40) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (jsOpened) {
      await humanDelay(800);
      dropdownOpened = await page
        .getByText('Publish as', { exact: false })
        .isVisible({ timeout: 3000 })
        .catch(() => false);
    }
  }

  if (!dropdownOpened) {
    await saveDebugScreenshot(page, 'dropdown-open-failed');
    throw new Error(
      'Could not open the author/newsletter dropdown in the article editor. ' +
        'LinkedIn may have updated its UI — check debug screenshots and update selectors in linkedin.ts.',
    );
  }

  // ── Select "Publish as": Julio G. Martinez-Clark ───────────────────────────
  logger.info('Selecting author', { author: AUTHOR_NAME });

  // Prefer clicking the list item (li) that contains the author name
  const authorLi = page.locator('li').filter({ hasText: AUTHOR_NAME }).first();
  if (await authorLi.isVisible({ timeout: 5000 }).catch(() => false)) {
    await authorLi.click();
  } else {
    // Fallback: click directly on the text node
    await page.getByText(AUTHOR_NAME, { exact: false }).first().click();
  }
  await humanDelay(600);
  logger.info('Author selected');

  // ── Select "Publish to": target newsletter ─────────────────────────────────
  logger.info('Selecting newsletter', { newsletter: newsletterDisplayName });

  // Try exact display name first, then strip the ™ symbol as fallback
  const newsletterLi = page.locator('li').filter({ hasText: newsletterDisplayName }).first();
  if (await newsletterLi.isVisible({ timeout: 5000 }).catch(() => false)) {
    await newsletterLi.click();
  } else {
    const partial = newsletterDisplayName.replace(/™/g, '').trim();
    const partialLi = page.locator('li').filter({ hasText: partial }).first();
    if (await partialLi.isVisible({ timeout: 3000 }).catch(() => false)) {
      await partialLi.click();
    } else {
      // Last resort: direct text click
      await page.getByText(partial, { exact: false }).first().click();
    }
  }
  await humanDelay(600);
  logger.info('Newsletter selected');

  // ── Close the dropdown ─────────────────────────────────────────────────────
  // Press Escape or click on the editor area to dismiss the panel
  await page.keyboard.press('Escape');
  await humanDelay(500);
  logger.info('Author/newsletter selection complete');
}
