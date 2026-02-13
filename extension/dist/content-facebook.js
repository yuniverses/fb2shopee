"use strict";
(() => {
  // src/shared/messages.ts
  var MSG = {
    collect_fb_post: "collect_fb_post",
    collect_shopee_schema: "collect_shopee_schema",
    generate_ai_draft: "generate_ai_draft",
    apply_shopee_draft: "apply_shopee_draft",
    get_fill_report: "get_fill_report",
    get_pipeline_debug: "get_pipeline_debug",
    run_pipeline: "run_pipeline",
    cancel_pipeline: "cancel_pipeline",
    open_shopee_tab: "open_shopee_tab"
  };

  // src/content/facebook.ts
  var VIEWER_WAIT_TIMEOUT_MS = 4e3;
  var IMAGE_RENDER_WAIT_MS = 6e3;
  function normalizePostUrl(current) {
    const url = new URL(current);
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  function textFromNode(node) {
    if (!node) {
      return "";
    }
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  }
  function parseSrcsetLargest(srcset) {
    if (!srcset) {
      return null;
    }
    const candidates = srcset.split(",").map((item) => item.trim()).map((item) => {
      const [url, size] = item.split(/\s+/);
      const sizeNum = size?.endsWith("w") ? Number(size.slice(0, -1)) : 0;
      return { url, size: Number.isFinite(sizeNum) ? sizeNum : 0 };
    }).filter((item) => Boolean(item.url));
    if (!candidates.length) {
      return null;
    }
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0]?.url || null;
  }
  function asAbsoluteUrl(url) {
    try {
      return new URL(url, window.location.origin).toString();
    } catch {
      return url;
    }
  }
  function keyForUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      const fbid = parsed.searchParams.get("fbid");
      if (fbid) {
        return `fbid:${fbid}`;
      }
      if (parsed.hostname.includes("fbcdn.net")) {
        return `${parsed.hostname}${parsed.pathname}`;
      }
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }
  function mergeUniqueOrdered(urls) {
    const seen = /* @__PURE__ */ new Set();
    const merged = [];
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
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) {
        return true;
      }
      await sleep(120);
    }
    return false;
  }
  function findMainArticle() {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    if (!articles.length) {
      return null;
    }
    const topLevel = articles.filter((a) => {
      const parent = a.parentElement?.closest('[role="article"]');
      return !parent;
    });
    const candidates = topLevel.length ? topLevel : articles;
    let best = null;
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
    let bestLen = 0;
    for (const a of candidates) {
      const len = (a.textContent || "").length;
      if (len > bestLen) {
        bestLen = len;
        best = a;
      }
    }
    return best || candidates[0] || null;
  }
  function isInsideCommentArticle(node, root) {
    const parentArticle = node.parentElement?.closest('[role="article"]');
    return parentArticle !== null && parentArticle !== root;
  }
  function isLikelyProductImageUrl(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes("fbcdn.net")) {
        return false;
      }
      if (parsed.hostname === "static.xx.fbcdn.net") {
        return false;
      }
      const path = parsed.pathname;
      if (path.includes("emoji.php") || path.includes("/emoji/") || path.includes("rsrc.php") || path.includes("safe_image.php")) {
        return false;
      }
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
  function isLikelyPostImage(img) {
    const src = parseSrcsetLargest(img.getAttribute("srcset")) || img.currentSrc || img.src;
    if (!src || !src.startsWith("http")) {
      return false;
    }
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width > 0 && height > 0 && (width < 80 || height < 80)) {
      return false;
    }
    if (width === 0 || height === 0) {
      return isLikelyProductImageUrl(src);
    }
    return isLikelyProductImageUrl(src);
  }
  function collectPostText() {
    const article = findMainArticle();
    if (!article) {
      return "";
    }
    const selectors = [
      '[data-ad-preview="message"]',
      'div[dir="auto"] span',
      'div[dir="auto"]'
    ];
    for (const selector of selectors) {
      const nodes = Array.from(article.querySelectorAll(selector)).filter((node) => !isInsideCommentArticle(node, article));
      if (!nodes.length) {
        continue;
      }
      const text = nodes.map((node) => textFromNode(node)).filter((x) => x.length > 0).join("\n").trim();
      if (text) {
        return text;
      }
    }
    return textFromNode(article);
  }
  async function waitForArticleImages(root) {
    await waitFor(() => {
      for (const img of root.querySelectorAll("img")) {
        const src = img.currentSrc || img.src;
        if (src && src.includes("fbcdn.net") && !src.includes("emoji") && !src.includes("rsrc.php")) {
          return true;
        }
      }
      const photoLinks = root.querySelectorAll('a[href*="/photo/?"], a[href*="fbid="]');
      return photoLinks.length > 0;
    }, IMAGE_RENDER_WAIT_MS);
  }
  function collectImagesFromPhotoLinks(root) {
    const anchors = Array.from(
      root.querySelectorAll('a[href*="/photo/?"], a[href*="fbid="], a[href*="/photos/"]')
    );
    const out = [];
    for (const anchor of anchors) {
      if (!anchor.getAttribute("href")) {
        continue;
      }
      if (isInsideCommentArticle(anchor, root)) {
        continue;
      }
      const childImg = anchor.querySelector("img");
      if (childImg instanceof HTMLImageElement) {
        const imageUrl = parseSrcsetLargest(childImg.getAttribute("srcset")) || childImg.currentSrc || childImg.src;
        if (imageUrl && imageUrl.startsWith("http") && isLikelyProductImageUrl(asAbsoluteUrl(imageUrl))) {
          out.push(asAbsoluteUrl(imageUrl));
        }
      }
    }
    return out;
  }
  function collectImagesFromArticleImages(root) {
    const out = [];
    for (const node of root.querySelectorAll("img")) {
      if (!(node instanceof HTMLImageElement) || !isLikelyPostImage(node)) {
        continue;
      }
      if (isInsideCommentArticle(node, root)) {
        continue;
      }
      const url = parseSrcsetLargest(node.getAttribute("srcset")) || node.currentSrc || node.src;
      if (url) {
        out.push(asAbsoluteUrl(url));
      }
    }
    return out;
  }
  function collectHiddenMoreCount(root) {
    let maxCount = 0;
    for (const node of root.querySelectorAll("span,div")) {
      const text = (node.textContent || "").replace(/\s+/g, "");
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
  function findPhotoLinks(root) {
    return Array.from(
      root.querySelectorAll('a[href*="/photo/?"], a[href*="fbid="], a[href*="/photos/"]')
    ).filter((a) => !isInsideCommentArticle(a, root));
  }
  function getViewerCurrentImage() {
    const marked = document.querySelector('img[data-visualcompletion="media-vc-image"]');
    if (marked) {
      const src = parseSrcsetLargest(marked.getAttribute("srcset")) || marked.currentSrc || marked.src;
      if (src && src.startsWith("http") && isLikelyProductImageUrl(asAbsoluteUrl(src))) {
        return asAbsoluteUrl(src);
      }
    }
    const mainRegion = document.querySelector('[role="main"]');
    if (!mainRegion) {
      return null;
    }
    let best = null;
    let bestArea = 0;
    for (const img of mainRegion.querySelectorAll("img")) {
      const rect = img.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) {
        continue;
      }
      const src = parseSrcsetLargest(img.getAttribute("srcset")) || img.currentSrc || img.src;
      if (!src || !src.startsWith("http") || !isLikelyProductImageUrl(asAbsoluteUrl(src))) {
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
    return asAbsoluteUrl(parseSrcsetLargest(best.getAttribute("srcset")) || best.currentSrc || best.src);
  }
  function findNextPhotoButton() {
    for (const el of document.querySelectorAll('[role="button"], div[tabindex="0"]')) {
      const label = el.getAttribute("aria-label") || "";
      if (/下一張相片|下一張照片|Next photo/i.test(label)) {
        return el;
      }
    }
    for (const el of document.querySelectorAll('[role="button"], div[tabindex="0"]')) {
      const label = el.getAttribute("aria-label") || "";
      if (/下一個項目|next/i.test(label)) {
        return el;
      }
    }
    return null;
  }
  function currentFbid() {
    const match = window.location.href.match(/fbid=(\d+)/);
    return match ? match[1] : null;
  }
  async function collectImagesViaPhotoViewer(firstPhotoLink, expectedCount) {
    const originalUrl = window.location.href;
    firstPhotoLink.click();
    const navigated = await waitFor(
      () => window.location.href !== originalUrl && window.location.href.includes("fbid="),
      VIEWER_WAIT_TIMEOUT_MS
    );
    if (!navigated) {
      if (window.location.href !== originalUrl) {
        window.history.back();
        await sleep(500);
      }
      return [];
    }
    await sleep(1200);
    const collected = [];
    let navCount = 1;
    let firstFbid = null;
    const seenFbids = /* @__PURE__ */ new Set();
    for (let step = 0; step < expectedCount + 10; step += 1) {
      const fbid = currentFbid();
      if (step === 0 && fbid) {
        firstFbid = fbid;
      }
      if (fbid && seenFbids.has(fbid)) {
        break;
      }
      if (fbid) {
        seenFbids.add(fbid);
      }
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
      await waitFor(() => window.location.href !== prevHref, 2e3);
      await sleep(600);
    }
    for (let i = 0; i < navCount; i += 1) {
      window.history.back();
    }
    await waitFor(
      () => window.location.href.includes("/posts/") || window.location.href === originalUrl,
      5e3
    );
    await sleep(300);
    return collected;
  }
  async function collectImageUrlsOrdered() {
    const root = findMainArticle() || document.body;
    await waitForArticleImages(root);
    const domUrls = [
      ...collectImagesFromPhotoLinks(root),
      ...collectImagesFromArticleImages(root)
    ];
    const base = mergeUniqueOrdered(domUrls);
    const hiddenMoreCount = collectHiddenMoreCount(root);
    const photoLinks = findPhotoLinks(root);
    const expectedCount = photoLinks.length + hiddenMoreCount;
    if (hiddenMoreCount <= 0 || photoLinks.length === 0) {
      return base;
    }
    const viewerUrls = await collectImagesViaPhotoViewer(photoLinks[0], expectedCount);
    if (!viewerUrls.length) {
      return base;
    }
    return mergeUniqueOrdered([...viewerUrls, ...base]);
  }
  var IMAGE_FETCH_TIMEOUT_MS = 12e3;
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  function resolveMimeFromResponse(contentType, url) {
    if (contentType && contentType.includes("/")) {
      return contentType.split(";")[0]?.trim() ?? "image/jpeg";
    }
    if (url.endsWith(".png")) return "image/png";
    if (url.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  }
  async function fetchImageAsBase64(url, index) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        redirect: "follow",
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) {
        return null;
      }
      const mime = resolveMimeFromResponse(response.headers.get("content-type"), response.url || url);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 500) {
        return null;
      }
      return {
        base64: arrayBufferToBase64(buffer),
        mimeType: mime,
        sourceIndex: index
      };
    } catch {
      return null;
    }
  }
  async function prefetchImagesAsBase64(urls) {
    const tasks = urls.map((url, index) => fetchImageAsBase64(url, index));
    const settled = await Promise.all(tasks);
    return settled.filter((item) => item !== null);
  }
  async function collectFbPayload() {
    const postUrl = normalizePostUrl(window.location.href);
    const postText = collectPostText();
    const imageUrlsOrdered = await collectImageUrlsOrdered();
    if (!postText && !imageUrlsOrdered.length) {
      throw new Error("No post text or images found on current FB page");
    }
    const imageBase64List = await prefetchImagesAsBase64(imageUrlsOrdered);
    return {
      postUrl,
      postText,
      imageUrlsOrdered,
      imageBase64List,
      capturedAtISO: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== MSG.collect_fb_post) {
      return;
    }
    void (async () => {
      try {
        const payload = await collectFbPayload();
        if (payload.imageBase64List?.length) {
          try {
            await chrome.storage.local.set({ lastFbBase64Images: payload.imageBase64List });
          } catch {
          }
        }
        const { imageBase64List: _strip, ...payloadWithoutBase64 } = payload;
        sendResponse({ ok: true, payload: payloadWithoutBase64 });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Failed to collect FB post" });
      }
    })();
    return true;
  });
})();
//# sourceMappingURL=content-facebook.js.map
