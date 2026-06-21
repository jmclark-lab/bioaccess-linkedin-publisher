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
    // Use the persistent volume path so screenshots survive redeploys
    const dir = path.join('/data', 'debug-screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    logger.info('Debug screenshot saved', { file });
  } catch {
    // Non-fatal
  }
}

// ── Julio's LinkedIn profile URN ──────────────────────────────────────────────
// Confirmed via browser investigation 2026-06-21. The article editor URL's
// ?author= parameter accepts this URN to pre-select Julio as the publisher,
// skipping the "Publish as" dropdown step entirely.
const JULIO_PROFILE_URN = 'urn:li:fsd_profile:ACoAAAANE8MBRcTFSYWJy3xBByRzEB2dsaCuYOg';

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
    // ── Step 1: Navigate to the article editor with Julio pre-selected ────────
    // We include ?author=<JULIO_URN> so LinkedIn pre-selects "Julio G. Martinez-Clark"
    // under "Publish as". We still need to select the newsletter under "Publish to".
    // This avoids the need to interact with the "Publish as" section of the dropdown.
    const authorParam = encodeURIComponent(JULIO_PROFILE_URN);
    const editorUrl = `https://www.linkedin.com/article/new/?author=${authorParam}`;
    logger.info('Navigating to article editor', { url: editorUrl });
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded' });

    // Check for auth wall
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      return {
        success: false,
        error: 'LinkedIn session has expired. Use POST /admin/update-session to re-authenticate.',
        error_code: 'SESSION_EXPIRED',
      };
    }

    // Wait for the editor title field to appear — confirms the editor is ready
    await page
      .locator('[placeholder*="Title" i], h1[contenteditable="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: config.navTimeoutMs });
    await humanDelay(1500);
    await saveDebugScreenshot(page, `01-editor-opened-${req.newsletter}`);

    // ── Step 2: Open the dropdown and select the target newsletter ────────────
    // "Publish as" is already set via the URL. We only need to select "Publish to".
    await selectNewsletterFromDropdown(page, newsletter.displayName);
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

// ── Newsletter picker helper ───────────────────────────────────────────────────

/**
 * Opens the "Publish as / Publish to" dropdown and selects the target newsletter
 * under "Publish to". Since we navigate with ?author=<JULIO_URN>, the "Publish as"
 * section is already set to Julio G. Martinez-Clark — we only need to click the
 * correct newsletter.
 *
 * All element targeting uses getBoundingClientRect() visibility checks (via
 * page.evaluate) to avoid matching LinkedIn's hidden JSON data blobs, which appear
 * as <code> elements containing the same text strings and cause Playwright locators
 * to resolve to the wrong (invisible) element.
 */
async function selectNewsletterFromDropdown(
  page: Page,
  newsletterDisplayName: string,
): Promise<void> {
  // ── Open the dropdown trigger ──────────────────────────────────────────────
  logger.info('Opening newsletter picker dropdown');

  // Use JS to find and click the dropdown trigger. The trigger is the widest
  // visible button in the editor header (top ~120px). Formatting toolbar buttons
  // are narrow (~30px each); the author/newsletter trigger is wide (~150–200px).
  const triggerClicked = await page.evaluate((): boolean => {
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 5) return false;
      if (rect.top < 0 || rect.top > window.innerHeight) return false;
      const s = window.getComputedStyle(el as HTMLElement);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.1;
    };

    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"]'),
    ) as HTMLElement[];

    // Candidates: visible buttons in the editor header area
    const candidates = buttons
      .filter((btn) => isVisible(btn))
      .map((btn) => ({ btn, rect: btn.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top > 5 && rect.top < 120 && rect.left < 700 && rect.width > 80);

    if (candidates.length === 0) return false;

    // Click the widest candidate — that's the author/newsletter dropdown trigger
    candidates.sort((a, b) => b.rect.width - a.rect.width);
    candidates[0].btn.click();
    return true;
  });

  if (!triggerClicked) {
    await saveDebugScreenshot(page, 'dropdown-trigger-not-found');
    throw new Error(
      'Could not find the newsletter picker dropdown trigger in the editor header. ' +
        'Check debug screenshots. LinkedIn may have updated its UI.',
    );
  }

  await humanDelay(1000);

  // ── Verify dropdown opened (real visibility check) ─────────────────────────
  // Use getBoundingClientRect() rather than Playwright .isVisible() to avoid
  // false-positives from hidden <code> JSON blobs that contain the same text.
  const dropdownOpen = await page.evaluate((): boolean => {
    const isReallyVisible = (el: Element | null): boolean => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.top < 0 || rect.bottom > window.innerHeight + 200) return false;
      const s = window.getComputedStyle(el as HTMLElement);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.1;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = ((node as Text).textContent ?? '').trim();
      if ((t === 'Publish as' || t === 'Publish to') && isReallyVisible((node as Text).parentElement)) {
        return true;
      }
    }
    return false;
  });

  if (!dropdownOpen) {
    await saveDebugScreenshot(page, 'dropdown-not-open');
    logger.warn('Dropdown may not be visible — trying coordinate-based click fallback');
    // Fallback: click at the known approximate position of the trigger in a 1280×900 viewport.
    // Measured during browser investigation on 2026-06-21: trigger is at ~(260, 57).
    await page.mouse.click(260, 57);
    await humanDelay(1000);
  }

  // ── Click the target newsletter ────────────────────────────────────────────
  // Walk all visible text nodes looking for the newsletter name. "LATAM Regulatory
  // Dispatch" and "Global Trial Accelerators" appear in the dropdown items, but also
  // in hidden JSON blobs. getBoundingClientRect() lets us skip the hidden ones.
  const searchText = newsletterDisplayName.replace(/™/g, '').trim();
  logger.info('Clicking newsletter option', { searchText });

  let clicked = false;
  for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
    if (attempt > 0) {
      logger.info('Retrying newsletter click', { attempt });
      await humanDelay(600);
    }

    clicked = await page.evaluate((text): boolean => {
      const isReallyVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 5) return false;
        if (rect.top < 0 || rect.top > window.innerHeight) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.1;
      };

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!((node as Text).textContent ?? '').includes(text)) continue;
        // Walk up the DOM to find the nearest visible ancestor we can click
        let el: HTMLElement | null = (node as Text).parentElement;
        for (let i = 0; i < 8; i++) {
          if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') break;
          if (isReallyVisible(el)) {
            el.click();
            return true;
          }
          el = el.parentElement;
        }
      }
      return false;
    }, searchText);
  }

  if (!clicked) {
    await saveDebugScreenshot(page, 'newsletter-item-not-found');
    throw new Error(
      `Could not find a visible "${newsletterDisplayName}" item in the newsletter dropdown. ` +
        'Check debug screenshots.',
    );
  }

  await humanDelay(600);

  // Close dropdown if still open
  await page.keyboard.press('Escape');
  await humanDelay(500);

  logger.info('Newsletter selection complete', { newsletter: newsletterDisplayName });
}
