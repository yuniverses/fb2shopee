import type { FBPostPayload } from '@shared/contracts';
import { MSG } from '@shared/messages';

const VIEWER_WAIT_TIMEOUT_MS = 4000;
const IMAGE_RENDER_WAIT_MS = 6000;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function normalizePostUrl(current: string): string {
  const url = new URL(current);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function textFromNode(node: Element | null): string {
  if (!node) {
    return '';
  }
  return (node.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseSrcsetLargest(srcset: string | null): string | null {
  if (!srcset) {
    return null;
  }

  const candidates = srcset
    .split(',')
    .map((item) => item.trim())
    .map((item) => {
      const [url, size] = item.split(/\s+/);
      const sizeNum = size?.endsWith('w') ? Number(size.slice(0, -1)) : 0;
      return { url, size: Number.isFinite(sizeNum) ? sizeNum : 0 };
    })
    .filter((item) => Boolean(item.url));

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]?.url || null;
}

function asAbsoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

function keyForUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    const fbid = parsed.searchParams.get('fbid');
    if (fbid) {
      return `fbid:${fbid}`;
    }

    if (parsed.hostname.includes('fbcdn.net')) {
      return `${parsed.hostname}${parsed.pathname}`;
    }

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function mergeUniqueOrdered(urls: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const url of urls) {
    const normalized = asAbsoluteUrl(url);
    const key = keyForUrl(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }

  return merged;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await sleep(120);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Article detection
// ---------------------------------------------------------------------------

/**
 * Find the main post article on the page.
 *
 * FB post detail pages have many [role="article"] elements:
 * recommended posts, the main post, and comment articles nested inside.
 *
 * Strategy: filter out nested (comment) articles, then pick the one
 * with the most photo links.  Fallback to longest text.
 */
function findMainArticle(): Element | null {
  const articles = Array.from(document.querySelectorAll<HTMLElement>('[role="article"]'));
  if (!articles.length) {
    return null;
  }

  // Filter out comment articles (nested inside another article)
  const topLevel = articles.filter((a) => {
    const parent = a.parentElement?.closest('[role="article"]');
    return !parent;
  });

  const candidates = topLevel.length ? topLevel : articles;

  // Prefer the article that has photo links — that's the one with product images
  let best: Element | null = null;
  let bestPhotoLinks = 0;
  for (const a of candidates) {
    const count = a.querySelectorAll('a[href*="/photo"], a[href*="fbid="]').length;
    if (count > bestPhotoLinks) {
      bestPhotoLinks = count;
      best = a;
    }
  }
  if (best) {
    return best;
  }

  // Fallback: pick the article with the most text content
  let bestLen = 0;
  for (const a of candidates) {
    const len = (a.textContent || '').length;
    if (len > bestLen) {
      bestLen = len;
      best = a;
    }
  }

  return best || candidates[0] || null;
}

/** Check if node is inside a nested comment article (not the root article). */
function isInsideCommentArticle(node: Element, root: ParentNode): boolean {
  const parentArticle = node.parentElement?.closest('[role="article"]');
  return parentArticle !== null && parentArticle !== root;
}

// ---------------------------------------------------------------------------
// Image filtering
// ---------------------------------------------------------------------------

/** URL-only filter — works without a DOM element. */
function isLikelyProductImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('fbcdn.net')) {
      return false;
    }
    // Block known non-product patterns
    if (parsed.hostname === 'static.xx.fbcdn.net') {
      return false;
    }
    const path = parsed.pathname;
    if (
      path.includes('emoji.php') ||
      path.includes('/emoji/') ||
      path.includes('rsrc.php') ||
      path.includes('safe_image.php')
    ) {
      return false;
    }
    // Accept FB photo CDN paths
    if (/\/v\/t\d+\.\d+-\d+\//.test(path)) {
      return true;
    }
    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(path)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** DOM element filter for <img> nodes. */
function isLikelyPostImage(img: HTMLImageElement): boolean {
  const src = parseSrcsetLargest(img.getAttribute('srcset')) || img.currentSrc || img.src;
  if (!src || !src.startsWith('http')) {
    return false;
  }

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  // Known tiny → icon / avatar / emoji
  if (width > 0 && height > 0 && (width < 80 || height < 80)) {
    return false;
  }

  // If dimensions unknown (lazy-loaded), fall back to URL check
  if (width === 0 || height === 0) {
    return isLikelyProductImageUrl(src);
  }

  // Known dimensions, large enough → accept if URL is a product image
  return isLikelyProductImageUrl(src);
}

// ---------------------------------------------------------------------------
// Text collection
// ---------------------------------------------------------------------------

function collectPostText(): string {
  const article = findMainArticle();
  if (!article) {
    return '';
  }

  const selectors = [
    '[data-ad-preview="message"]',
    'div[dir="auto"] span',
    'div[dir="auto"]'
  ];

  for (const selector of selectors) {
    const nodes = Array.from(article.querySelectorAll(selector))
      .filter((node) => !isInsideCommentArticle(node, article));
    if (!nodes.length) {
      continue;
    }

    const text = nodes
      .map((node) => textFromNode(node))
      .filter((x) => x.length > 0)
      .join('\n')
      .trim();

    if (text) {
      return text;
    }
  }

  return textFromNode(article);
}

// ---------------------------------------------------------------------------
// DOM image collection
// ---------------------------------------------------------------------------

/** Wait for FB React to render images inside the article. */
async function waitForArticleImages(root: ParentNode): Promise<void> {
  await waitFor(() => {
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
      const src = img.currentSrc || img.src;
      if (src && src.includes('fbcdn.net') && !src.includes('emoji') && !src.includes('rsrc.php')) {
        return true;
      }
    }
    const photoLinks = root.querySelectorAll('a[href*="/photo/?"], a[href*="fbid="]');
    return photoLinks.length > 0;
  }, IMAGE_RENDER_WAIT_MS);
}

/** Collect images from photo links (a[href*="/photo/"] etc). */
function collectImagesFromPhotoLinks(root: ParentNode): string[] {
  const anchors = Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/photo/?"], a[href*="fbid="], a[href*="/photos/"]')
  );

  const out: string[] = [];
  for (const anchor of anchors) {
    if (!anchor.getAttribute('href')) {
      continue;
    }
    if (isInsideCommentArticle(anchor, root)) {
      continue;
    }

    const childImg = anchor.querySelector('img');
    if (childImg instanceof HTMLImageElement) {
      const imageUrl = parseSrcsetLargest(childImg.getAttribute('srcset')) || childImg.currentSrc || childImg.src;
      if (imageUrl && imageUrl.startsWith('http') && isLikelyProductImageUrl(asAbsoluteUrl(imageUrl))) {
        out.push(asAbsoluteUrl(imageUrl));
      }
    }
  }

  return out;
}

/** Collect <img> inside the article that look like product images. */
function collectImagesFromArticleImages(root: ParentNode): string[] {
  const out: string[] = [];

  for (const node of root.querySelectorAll('img')) {
    if (!(node instanceof HTMLImageElement) || !isLikelyPostImage(node)) {
      continue;
    }
    if (isInsideCommentArticle(node, root)) {
      continue;
    }
    const url = parseSrcsetLargest(node.getAttribute('srcset')) || node.currentSrc || node.src;
    if (url) {
      out.push(asAbsoluteUrl(url));
    }
  }

  return out;
}

/** Detect the "+N" hidden image count overlay. */
function collectHiddenMoreCount(root: ParentNode): number {
  let maxCount = 0;
  for (const node of root.querySelectorAll<HTMLElement>('span,div')) {
    const text = (node.textContent || '').replace(/\s+/g, '');
    const match = text.match(/^\+(\d{1,2})$/);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > maxCount) {
        maxCount = value;
      }
    }
  }
  return maxCount;
}

// ---------------------------------------------------------------------------
// Photo Viewer SPA traversal (for hidden "+N" images)
//
// FB post detail pages show a limited grid of images with a "+N" overlay.
// The hidden images are NOT in the DOM.  To collect them we:
//   1. Click the first photo <a> link → FB does SPA navigation to /photo/
//   2. On the photo viewer page, grab the large image
//   3. Click "下一張相片" to advance, repeat until we have all images
//   4. history.back() to return to the post page
// Because FB uses pushState (SPA), our content script stays alive.
// ---------------------------------------------------------------------------

/** Find photo <a> links inside the article (not in comment articles). */
function findPhotoLinks(root: ParentNode): HTMLAnchorElement[] {
  return Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/photo/?"], a[href*="fbid="], a[href*="/photos/"]')
  ).filter((a) => !isInsideCommentArticle(a, root));
}

/**
 * On the photo viewer page, find the current main image.
 * FB marks it with data-visualcompletion="media-vc-image".
 * Falls back to the largest visible product image inside [role="main"].
 */
function getViewerCurrentImage(): string | null {
  // Primary: the explicitly marked image
  const marked = document.querySelector<HTMLImageElement>('img[data-visualcompletion="media-vc-image"]');
  if (marked) {
    const src = parseSrcsetLargest(marked.getAttribute('srcset')) || marked.currentSrc || marked.src;
    if (src && src.startsWith('http') && isLikelyProductImageUrl(asAbsoluteUrl(src))) {
      return asAbsoluteUrl(src);
    }
  }

  // Fallback: largest visible product image inside [role="main"]
  const mainRegion = document.querySelector('[role="main"]');
  if (!mainRegion) {
    return null;
  }
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const img of mainRegion.querySelectorAll<HTMLImageElement>('img')) {
    const rect = img.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) {
      continue;
    }
    const src = parseSrcsetLargest(img.getAttribute('srcset')) || img.currentSrc || img.src;
    if (!src || !src.startsWith('http') || !isLikelyProductImageUrl(asAbsoluteUrl(src))) {
      continue;
    }
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      best = img;
    }
  }
  if (!best) {
    return null;
  }
  return asAbsoluteUrl(parseSrcsetLargest(best.getAttribute('srcset')) || best.currentSrc || best.src);
}

/** Find the "next photo" button on the photo viewer page. */
function findNextPhotoButton(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[role="button"], div[tabindex="0"]')) {
    const label = el.getAttribute('aria-label') || '';
    if (/下一張相片|下一張照片|Next photo/i.test(label)) {
      return el;
    }
  }
  // Broader fallback
  for (const el of document.querySelectorAll<HTMLElement>('[role="button"], div[tabindex="0"]')) {
    const label = el.getAttribute('aria-label') || '';
    if (/下一個項目|next/i.test(label)) {
      return el;
    }
  }
  return null;
}

/** Extract fbid from current URL. */
function currentFbid(): string | null {
  const match = window.location.href.match(/fbid=(\d+)/);
  return match ? match[1] : null;
}

/**
 * Navigate into the photo viewer via SPA, traverse all photos, then
 * go back to the original page.  Returns high-res image URLs.
 */
async function collectImagesViaPhotoViewer(
  firstPhotoLink: HTMLAnchorElement,
  expectedCount: number
): Promise<string[]> {
  const originalUrl = window.location.href;

  // Click the first photo link → SPA navigates to /photo/ page
  firstPhotoLink.click();

  // Wait until URL changes to a /photo/ page
  const navigated = await waitFor(
    () => window.location.href !== originalUrl && window.location.href.includes('fbid='),
    VIEWER_WAIT_TIMEOUT_MS
  );

  if (!navigated) {
    if (window.location.href !== originalUrl) {
      window.history.back();
      await sleep(500);
    }
    return [];
  }

  // Give the photo viewer time to fully render the first image
  await sleep(1200);

  const collected: string[] = [];
  let navCount = 1; // We already navigated once (from post to viewer)
  let firstFbid: string | null = null;

  const seenFbids = new Set<string>();

  for (let step = 0; step < expectedCount + 10; step += 1) {
    const fbid = currentFbid();
    if (step === 0 && fbid) {
      firstFbid = fbid;
    }

    // Detect loop — if we see an fbid we've already collected, stop
    if (fbid && seenFbids.has(fbid)) {
      break;
    }
    if (fbid) {
      seenFbids.add(fbid);
    }

    // Grab the current viewer image
    const src = getViewerCurrentImage();
    if (src && !collected.includes(src)) {
      collected.push(src);
    }

    if (collected.length >= expectedCount) {
      break;
    }

    const nextBtn = findNextPhotoButton();
    if (!nextBtn) {
      break;
    }

    const prevHref = window.location.href;
    nextBtn.click();
    navCount += 1;

    // Wait for URL to change (fbid changes on SPA navigation)
    await waitFor(() => window.location.href !== prevHref, 2000);

    // Wait for the image to actually update
    await sleep(600);
  }

  // Go back to the original post page
  for (let i = 0; i < navCount; i += 1) {
    window.history.back();
  }
  await waitFor(
    () => window.location.href.includes('/posts/') || window.location.href === originalUrl,
    5000
  );
  await sleep(300);

  return collected;
}

// ---------------------------------------------------------------------------
// Main collection pipeline
// ---------------------------------------------------------------------------

async function collectImageUrlsOrdered(): Promise<string[]> {
  const root = findMainArticle() || document.body;

  // Wait for FB React to render images
  await waitForArticleImages(root);

  // DOM scraping — collect visible images
  const domUrls = [
    ...collectImagesFromPhotoLinks(root),
    ...collectImagesFromArticleImages(root)
  ];
  const base = mergeUniqueOrdered(domUrls);

  // Check if there are hidden images behind "+N" overlay
  const hiddenMoreCount = collectHiddenMoreCount(root);
  const photoLinks = findPhotoLinks(root);
  const expectedCount = photoLinks.length + hiddenMoreCount;

  if (hiddenMoreCount <= 0 || photoLinks.length === 0) {
    return base;
  }

  // Use Photo Viewer SPA traversal to get ALL images including hidden ones
  const viewerUrls = await collectImagesViaPhotoViewer(photoLinks[0], expectedCount);
  if (!viewerUrls.length) {
    return base;
  }

  // Viewer images are highest quality — put them first, then merge with DOM
  return mergeUniqueOrdered([...viewerUrls, ...base]);
}

async function collectFbPayload(): Promise<FBPostPayload> {
  const postUrl = normalizePostUrl(window.location.href);
  const postText = collectPostText();
  const imageUrlsOrdered = await collectImageUrlsOrdered();

  if (!postText && !imageUrlsOrdered.length) {
    throw new Error('No post text or images found on current FB page');
  }

  return {
    postUrl,
    postText,
    imageUrlsOrdered,
    capturedAtISO: new Date().toISOString()
  };
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== MSG.collect_fb_post) {
    return;
  }

  void (async () => {
    try {
      const payload = await collectFbPayload();
      sendResponse({ ok: true, payload });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Failed to collect FB post' });
    }
  })();

  return true;
});
