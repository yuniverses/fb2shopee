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

  // src/shared/runtime.ts
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function pickErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return "Unknown error";
  }

  // src/content/shopeeAdapters.ts
  var FillReporter = class {
    successFields = /* @__PURE__ */ new Set();
    failedFields = /* @__PURE__ */ new Set();
    skippedFields = /* @__PURE__ */ new Set();
    warnings = [];
    pendingActions = [];
    startAt = Date.now();
    success(field) {
      this.successFields.add(field);
    }
    fail(field, reason) {
      this.failedFields.add(field);
      if (reason) {
        this.warn(`[${field}] ${reason}`);
      }
    }
    skip(field, reason) {
      this.skippedFields.add(field);
      if (reason) {
        this.warn(`[${field}] skipped: ${reason}`);
      }
    }
    warn(message) {
      this.warnings.push(message);
    }
    pending(action) {
      this.pendingActions.push(action);
    }
    toJSON() {
      return {
        successFields: Array.from(this.successFields),
        failedFields: Array.from(this.failedFields),
        skippedFields: Array.from(this.skippedFields),
        warnings: this.warnings,
        pendingActions: this.pendingActions,
        durationMs: Date.now() - this.startAt
      };
    }
  };
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function normalizeText(value) {
    return value.replace(/\s+/g, "").toLowerCase();
  }
  function findElementsContainingText(text, root = document) {
    const target = normalizeText(text);
    const nodes = Array.from(root.querySelectorAll("div,span,label,p,button,a"));
    return nodes.filter((node) => {
      const value = normalizeText(node.textContent || "");
      return value.includes(target);
    });
  }
  function findFieldContainerByKeywords(keywords) {
    for (const keyword of keywords) {
      const candidates = findElementsContainingText(keyword);
      for (const node of candidates) {
        const container = node.closest(
          '[class*="field"], [class*="form-item"], [class*="product"], [class*="item"], [data-field], li, section'
        );
        if (container) {
          return container;
        }
      }
    }
    return null;
  }
  function dispatchInputEvents(element) {
    const events = ["input", "change", "blur"];
    for (const eventName of events) {
      element.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
  }
  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }
    dispatchInputEvents(element);
  }
  function setNativeValueCharByChar(element, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value"
    )?.set;
    const setter = nativeSetter ? (v) => nativeSetter.call(element, v) : (v) => {
      element.value = v;
    };
    element.focus();
    setter("");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    for (const ch of value) {
      setter(element.value + ch);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function findInputInContainer(container) {
    if (!container) {
      return null;
    }
    const selector = 'input:not([type="hidden"]):not([type="file"]):not([readonly]), textarea:not([readonly]), [contenteditable="true"]';
    const input = container.querySelector(selector);
    if (input) {
      return input;
    }
    return null;
  }
  function setContentEditableText(element, value) {
    element.focus();
    element.textContent = value;
    dispatchInputEvents(element);
  }
  async function clickByText(textCandidates, root = document) {
    const prioritySelectors = [
      'button, [role="button"], a',
      "div, span"
    ];
    for (const text of textCandidates) {
      const targetText = normalizeText(text);
      for (const selector of prioritySelectors) {
        const elements = Array.from(root.querySelectorAll(selector));
        const found = elements.find((el) => normalizeText(el.textContent || "").includes(targetText));
        if (found) {
          found.click();
          await sleep(120);
          return true;
        }
      }
    }
    return false;
  }
  async function selectDropdownOption(optionText) {
    const optionNodes = Array.from(
      document.querySelectorAll('[role="option"], li, .eds-select-option, .shopee-selector-item')
    );
    const target = optionNodes.find((node) => normalizeText(node.textContent || "").includes(normalizeText(optionText)));
    if (!target) {
      return false;
    }
    target.click();
    await sleep(160);
    return true;
  }
  function base64ToBlob(base64, mimeType) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }
  function base64ToFile(item, index) {
    const ext = item.mimeType.includes("png") ? "png" : item.mimeType.includes("webp") ? "webp" : "jpg";
    const blob = base64ToBlob(item.base64, item.mimeType);
    return new File([blob], `fb-image-${index + 1}.${ext}`, { type: item.mimeType });
  }
  async function fetchImageAsFile(url, index) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`image fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    const ext = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
    return new File([blob], `fb-image-${index + 1}.${ext}`, { type: blob.type || "image/jpeg" });
  }
  async function uploadImagesFromBase64(input, base64List, reporter, fieldName = "images") {
    if (!base64List.length) {
      reporter.skip(fieldName, "no base64 images");
      return;
    }
    const files = [];
    for (let i = 0; i < base64List.length; i += 1) {
      try {
        files.push(base64ToFile(base64List[i], i));
      } catch (error) {
        reporter.warn(`base64 image ${i + 1} failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    if (!files.length) {
      reporter.fail(fieldName, "all base64 conversions failed");
      return;
    }
    const transfer = new DataTransfer();
    for (const file of files) {
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(500);
    reporter.success(fieldName);
  }
  async function uploadSingleBase64(input, item, reporter, fieldName) {
    try {
      const file = base64ToFile(item, item.sourceIndex);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(400);
      reporter.success(fieldName);
      return true;
    } catch (error) {
      reporter.fail(fieldName, error instanceof Error ? error.message : "unknown");
      return false;
    }
  }
  async function uploadImagesFromUrls(input, urls, reporter, fieldName = "images") {
    if (!urls.length) {
      reporter.skip(fieldName, "no image urls");
      return;
    }
    const files = [];
    for (let i = 0; i < urls.length; i += 1) {
      try {
        const file = await fetchImageAsFile(urls[i], i);
        files.push(file);
      } catch (error) {
        reporter.warn(`image ${i + 1} failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    if (!files.length) {
      reporter.fail(fieldName, "all image fetch attempts failed");
      return;
    }
    const transfer = new DataTransfer();
    for (const file of files) {
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(300);
    reporter.success(fieldName);
  }
  function uniqueStringArray(values) {
    const out = [];
    for (const value of values) {
      if (!out.includes(value)) {
        out.push(value);
      }
    }
    return out;
  }

  // src/content/shopee.ts
  var SHOPEE_NEW_PRODUCT_PATH = "/portal/product/new";
  var MAX_DEEP_SCAN_NODES = 12e3;
  var DEFAULT_CONSTRAINTS = {
    imageNumMin: 1,
    imageNumMax: 9,
    priceMin: 1,
    priceMax: 1e6,
    stockMin: 0,
    stockMax: 999999,
    dtsMin: 0,
    dtsMax: 30,
    inStockDts: 2,
    videoDurationMin: 0,
    videoDurationMax: 300,
    videoSizeLimit: 30 * 1024 * 1024
  };
  var FIELD_PROBES = [
    { key: "images", section: "basic", type: "array", requiredByDefault: true, keywords: ["\u5546\u54C1\u5716\u7247", "\u5716\u7247"] },
    { key: "name", section: "basic", type: "string", requiredByDefault: true, keywords: ["\u5546\u54C1\u540D\u7A31", "\u540D\u7A31"] },
    { key: "description", section: "basic", type: "string", requiredByDefault: true, keywords: ["\u5546\u54C1\u63CF\u8FF0", "\u63CF\u8FF0"] },
    { key: "categoryPath", section: "category", type: "array", requiredByDefault: true, keywords: ["\u5546\u54C1\u5206\u985E", "\u5206\u985E"] },
    { key: "brand", section: "basic", type: "string", requiredByDefault: false, keywords: ["\u54C1\u724C"] },
    { key: "tierVariationList", section: "spec", type: "array", requiredByDefault: false, keywords: ["\u5546\u54C1\u898F\u683C", "\u898F\u683C"] },
    { key: "modelList", section: "sales", type: "array", requiredByDefault: false, keywords: ["\u578B\u865F", "\u92B7\u552E\u8CC7\u8A0A"] },
    { key: "weight", section: "shipping", type: "number", requiredByDefault: false, keywords: ["\u91CD\u91CF"] },
    { key: "dimension", section: "shipping", type: "object", requiredByDefault: false, keywords: ["\u5305\u88F9\u5C3A\u5BF8", "\u5C3A\u5BF8"] },
    { key: "logisticsChannels", section: "shipping", type: "array", requiredByDefault: false, keywords: ["\u7269\u6D41", "\u914D\u9001\u65B9\u5F0F"] }
  ];
  var lastFillReport = null;
  function isNewProductPage() {
    return window.location.hostname === "seller.shopee.tw" && window.location.pathname.startsWith(SHOPEE_NEW_PRODUCT_PATH);
  }
  function inferRequired(container, fallback) {
    if (!container) return fallback;
    const text = container.textContent || "";
    if (/\*/.test(text) || /必填/.test(text)) return true;
    if (/選填/.test(text)) return false;
    return fallback;
  }
  function collectFieldOptions(container) {
    if (!container) return void 0;
    const optionNodes = Array.from(
      container.querySelectorAll('button, [role="button"], [role="option"], label, li')
    );
    const options = uniqueStringArray(
      optionNodes.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter((text) => text.length > 0 && text.length < 40)
    );
    return options.length ? options.slice(0, 80) : void 0;
  }
  function collectFieldsSnapshot() {
    const fields = [];
    for (const probe of FIELD_PROBES) {
      const container = findFieldContainerByKeywords(probe.keywords);
      if (!container) continue;
      fields.push({
        key: probe.key,
        section: probe.section,
        type: probe.type,
        required: inferRequired(container, probe.requiredByDefault),
        options: collectFieldOptions(container)
      });
    }
    if (!fields.length) {
      return FIELD_PROBES.map((probe) => ({
        key: probe.key,
        section: probe.section,
        type: probe.type,
        required: probe.requiredByDefault
      }));
    }
    return fields;
  }
  function extractNumber(content, pattern) {
    const match = content.match(pattern);
    if (!match?.[1]) return void 0;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : void 0;
  }
  function extractRange(content, pattern) {
    const match = content.match(pattern);
    if (!match?.[1] || !match?.[2]) return void 0;
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return void 0;
    return [min, max];
  }
  function normalizeWindowPath(path) {
    return path.replace(/\[(\d+)\]/g, ".$1").toLowerCase();
  }
  function maybeAssignConstraint(path, value, target) {
    const key = normalizeWindowPath(path);
    const assign = (constraintKey) => {
      if (target[constraintKey] === void 0) target[constraintKey] = value;
    };
    if (key.includes("image") && key.includes("max")) {
      assign("imageNumMax");
      return;
    }
    if (key.includes("image") && key.includes("min")) {
      assign("imageNumMin");
      return;
    }
    if (key.includes("price") && key.includes("max")) {
      assign("priceMax");
      return;
    }
    if (key.includes("price") && key.includes("min")) {
      assign("priceMin");
      return;
    }
    if ((key.includes("stock") || key.includes("qty")) && key.includes("max")) {
      assign("stockMax");
      return;
    }
    if ((key.includes("stock") || key.includes("qty")) && key.includes("min")) {
      assign("stockMin");
      return;
    }
    if ((key.includes("dts") || key.includes("days_to_ship") || key.includes("preorder")) && key.includes("max")) {
      assign("dtsMax");
      return;
    }
    if ((key.includes("dts") || key.includes("days_to_ship") || key.includes("preorder")) && key.includes("min")) {
      assign("dtsMin");
      return;
    }
    if (key.includes("instock") && (key.includes("dts") || key.includes("days"))) {
      assign("inStockDts");
      return;
    }
    if (key.includes("video") && key.includes("duration") && key.includes("max")) {
      assign("videoDurationMax");
      return;
    }
    if (key.includes("video") && key.includes("duration") && key.includes("min")) {
      assign("videoDurationMin");
      return;
    }
    if (key.includes("video") && (key.includes("size") || key.includes("filesize") || key.includes("file_size"))) {
      assign("videoSizeLimit");
    }
  }
  function deepScanConstraints(value, target, path, visited, count) {
    if (count.scanned >= MAX_DEEP_SCAN_NODES || value == null) return;
    if (typeof value === "number" && Number.isFinite(value)) {
      maybeAssignConstraint(path, value, target);
      count.scanned += 1;
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        deepScanConstraints(value[i], target, `${path}[${i}]`, visited, count);
      }
      count.scanned += 1;
      return;
    }
    if (typeof value !== "object") {
      count.scanned += 1;
      return;
    }
    const obj = value;
    if (visited.has(obj)) return;
    visited.add(obj);
    for (const [key, child] of Object.entries(obj)) {
      deepScanConstraints(child, target, path ? `${path}.${key}` : key, visited, count);
    }
    count.scanned += 1;
  }
  function collectConstraintsFromWindow() {
    const collected = {};
    const win = window;
    const candidates = [win.__INITIAL_STATE__, win.__PRELOADED_STATE__, win.__NEXT_DATA__, win.__NUXT__, win.__APP_STATE__];
    const visited = /* @__PURE__ */ new WeakSet();
    const count = { scanned: 0 };
    for (const item of candidates) {
      deepScanConstraints(item, collected, "", visited, count);
    }
    return collected;
  }
  function collectConstraintsFromText() {
    const text = (document.body?.textContent || "").replace(/\s+/g, " ");
    const constraints = {};
    const imageRange = extractRange(text, /圖片[^\d]{0,20}(\d+)\D+(\d+)\s*張/i);
    if (imageRange) {
      constraints.imageNumMin = imageRange[0];
      constraints.imageNumMax = imageRange[1];
    }
    constraints.imageNumMax = constraints.imageNumMax ?? extractNumber(text, /最多[^\d]{0,20}(\d+)\s*張(?:商品)?圖片/i);
    constraints.imageNumMin = constraints.imageNumMin ?? extractNumber(text, /至少[^\d]{0,20}(\d+)\s*張(?:商品)?圖片/i);
    const priceRange = extractRange(text, /價格[^\d]{0,20}(\d+)\D+(\d+)/i);
    if (priceRange) {
      constraints.priceMin = priceRange[0];
      constraints.priceMax = priceRange[1];
    }
    const stockRange = extractRange(text, /庫存[^\d]{0,20}(\d+)\D+(\d+)/i);
    if (stockRange) {
      constraints.stockMin = stockRange[0];
      constraints.stockMax = stockRange[1];
    }
    const dtsRange = extractRange(text, /(?:備貨|出貨)[^\d]{0,20}(\d+)\D+(\d+)\s*天/i);
    if (dtsRange) {
      constraints.dtsMin = dtsRange[0];
      constraints.dtsMax = dtsRange[1];
    }
    constraints.inStockDts = extractNumber(text, /現貨[^\d]{0,20}(\d+)\s*天/i);
    const videoDuration = extractRange(text, /影片[^\d]{0,20}(\d+)\D+(\d+)\s*秒/i);
    if (videoDuration) {
      constraints.videoDurationMin = videoDuration[0];
      constraints.videoDurationMax = videoDuration[1];
    }
    const videoSizeMB = extractNumber(text, /影片[^\d]{0,20}(\d+)\s*(?:mb|m)/i);
    if (videoSizeMB !== void 0) {
      constraints.videoSizeLimit = videoSizeMB * 1024 * 1024;
    }
    return constraints;
  }
  function mergeConstraints(...parts) {
    const out = {};
    for (const part of parts) {
      for (const [k, v] of Object.entries(part)) {
        if (v !== void 0) out[k] = v;
      }
    }
    return out;
  }
  function collectSchemaSnapshot() {
    return {
      version: "v1",
      region: "tw",
      capturedAtISO: nowIso(),
      fields: collectFieldsSnapshot(),
      constraints: mergeConstraints(DEFAULT_CONSTRAINTS, collectConstraintsFromWindow(), collectConstraintsFromText())
    };
  }
  function findMainImageUploadInput() {
    const allUploads = Array.from(
      document.querySelectorAll('.eds-upload__input, input[type="file"][accept*="image"]')
    );
    return allUploads.find((input) => input.hasAttribute("multiple")) ?? allUploads[0] ?? null;
  }
  function findNameInput() {
    const byPlaceholder = document.querySelector(
      'input[placeholder*="\u54C1\u724C\u540D\u7A31"], input[placeholder*="\u5546\u54C1\u985E\u578B"]'
    );
    if (byPlaceholder) return byPlaceholder;
    const container = findFieldContainerByKeywords(["\u5546\u54C1\u540D\u7A31"]);
    return container?.querySelector('input.eds-input__input, input[type="text"]') ?? null;
  }
  function findDescriptionEditor() {
    const editor = document.querySelector('.ql-editor[contenteditable="true"]');
    if (editor) return editor;
    return document.querySelector(
      '[contenteditable="true"][data-placeholder*="\u5546\u54C1\u63CF\u8FF0"], [contenteditable="true"][data-placeholder*="\u63CF\u8FF0"]'
    ) ?? null;
  }
  async function waitForSelector(selector, timeoutMs = 3e3) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(150);
    }
    return null;
  }
  function resolveImageAssignment(fb, draft) {
    const variantImageMap = /* @__PURE__ */ new Map();
    const variantUsedIndices = /* @__PURE__ */ new Set();
    for (const binding of draft.variantImageBindings) {
      if (binding.imageSourceIndex < fb.imageUrlsOrdered.length) {
        variantImageMap.set(binding.tier1Option, binding.imageSourceIndex);
        variantUsedIndices.add(binding.imageSourceIndex);
      }
    }
    const mainImageIndices = [];
    for (const item of draft.shopee.images) {
      if (!variantUsedIndices.has(item.sourceIndex) && item.sourceIndex < fb.imageUrlsOrdered.length) {
        if (!mainImageIndices.includes(item.sourceIndex)) {
          mainImageIndices.push(item.sourceIndex);
        }
      }
    }
    if (!mainImageIndices.length) {
      for (let i = 0; i < fb.imageUrlsOrdered.length; i += 1) {
        if (!variantUsedIndices.has(i)) {
          mainImageIndices.push(i);
        }
      }
    }
    return { mainImageIndices, variantImageMap };
  }
  async function fillBasicInfo(fb, draft, imageAssignment, reporter) {
    const imageInput = findMainImageUploadInput();
    if (imageInput) {
      const mainBase64 = [];
      for (const idx of imageAssignment.mainImageIndices) {
        const item = fb.imageBase64List?.find((b) => b.sourceIndex === idx);
        if (item) mainBase64.push(item);
      }
      if (mainBase64.length > 0) {
        await uploadImagesFromBase64(imageInput, mainBase64, reporter, "images");
      } else {
        const urls = imageAssignment.mainImageIndices.map((i) => fb.imageUrlsOrdered[i]).filter(Boolean);
        await uploadImagesFromUrls(imageInput, urls, reporter, "images");
      }
    } else {
      reporter.fail("images", "main image upload input not found");
    }
    const nameInput = findNameInput();
    if (nameInput) {
      setNativeValue(nameInput, draft.shopee.title);
      reporter.success("name");
    } else {
      reporter.fail("name", "product name input not found");
    }
    const descEditor = findDescriptionEditor();
    if (descEditor) {
      descEditor.focus();
      descEditor.innerHTML = "";
      descEditor.textContent = draft.shopee.description;
      dispatchInputEvents(descEditor);
      descEditor.dispatchEvent(new Event("input", { bubbles: true }));
      reporter.success("description");
    } else {
      const fallback = document.querySelector('textarea[placeholder*="\u63CF\u8FF0"]') ?? document.querySelector('[contenteditable="true"]');
      if (fallback) {
        if (fallback instanceof HTMLTextAreaElement) {
          setNativeValue(fallback, draft.shopee.description);
        } else {
          setContentEditableText(fallback, draft.shopee.description);
        }
        reporter.success("description");
      } else {
        reporter.fail("description", "description editor not found");
      }
    }
  }
  async function closeCategoryModal() {
    const modal = document.querySelector(".product-category-selector-modal");
    if (!modal) return;
    const isVisible = modal.offsetParent !== null || getComputedStyle(modal).display !== "none";
    if (!isVisible) return;
    console.log("[fb2shopee] force-closing category modal");
    const confirmBtn = modal.querySelector(".eds-modal__footer-buttons .eds-button--primary");
    if (confirmBtn) {
      console.log("[fb2shopee] clicking confirm inside category modal");
      confirmBtn.click();
      await sleep(800);
      if (!document.querySelector(".product-category-selector-modal")) return;
    }
    const cancelBtn = modal.querySelector(".eds-modal__footer-buttons .eds-button--normal");
    if (cancelBtn) {
      console.log("[fb2shopee] clicking cancel inside category modal");
      cancelBtn.click();
      await sleep(600);
      if (!document.querySelector(".product-category-selector-modal")) return;
    }
    const closeIcon = modal.querySelector(".eds-modal__close");
    if (closeIcon) {
      closeIcon.click();
      await sleep(500);
      if (!document.querySelector(".product-category-selector-modal")) return;
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
  }
  async function fillCategoryPath(categoryPath, reporter) {
    if (!categoryPath.length) {
      reporter.fail("categoryPath", "empty category path");
      return false;
    }
    const directTrigger = document.querySelector(".product-category-box");
    if (directTrigger) {
      console.log("[fb2shopee] clicking .product-category-box");
      directTrigger.click();
    } else {
      const categoryContainer = findFieldContainerByKeywords(["\u5546\u54C1\u5206\u985E", "\u5206\u985E"]);
      const triggerButton = categoryContainer?.querySelector('button, [role="button"], a, div');
      if (triggerButton) {
        triggerButton.click();
      } else if (categoryContainer) {
        categoryContainer.click();
      } else {
        await clickByText(["\u8ACB\u9078\u64C7\u5546\u54C1\u5206\u985E", "\u7DE8\u8F2F\u5206\u985E"]);
      }
    }
    await sleep(500);
    const modal = await waitForSelector(".product-category-selector-modal .category-wrap, .category-wrap", 3e3);
    if (!modal) {
      await clickByText(["\u7DE8\u8F2F\u5206\u985E", "\u9078\u64C7\u5206\u985E"]);
      await sleep(500);
    }
    const modalRoot = document.querySelector(".product-category-selector-modal") ?? document;
    let allSegmentsMatched = true;
    for (let i = 0; i < categoryPath.length; i += 1) {
      const segment = categoryPath[i];
      await sleep(300);
      const categoryItems = Array.from(
        modalRoot.querySelectorAll(".category-item")
      );
      const normalizedSegment = normalizeText(segment);
      const exactMatch = categoryItems.find((item) => {
        const p = item.querySelector("p");
        const itemText = normalizeText(p?.textContent || item.textContent || "");
        return itemText === normalizedSegment;
      });
      const partialMatch = !exactMatch ? categoryItems.find((item) => {
        const p = item.querySelector("p");
        const itemText = normalizeText(p?.textContent || item.textContent || "");
        return itemText.includes(normalizedSegment);
      }) : null;
      const reverseMatch = !exactMatch && !partialMatch ? categoryItems.find((item) => {
        const p = item.querySelector("p");
        const itemText = normalizeText(p?.textContent || item.textContent || "");
        return normalizedSegment.includes(itemText) && itemText.length > 1;
      }) : null;
      const match = exactMatch ?? partialMatch ?? reverseMatch;
      if (match) {
        console.log(`[fb2shopee] category step ${i}: clicking "${segment}"`);
        match.click();
        await sleep(400);
        continue;
      }
      const searchInput = modalRoot.querySelector(
        'input[placeholder*="\u8ACB\u8F38\u5165\u81F3\u5C11"], input[placeholder*="\u641C\u5C0B"]'
      );
      if (searchInput) {
        console.log(`[fb2shopee] category step ${i}: searching for "${segment}"`);
        setNativeValue(searchInput, segment);
        await sleep(600);
        const searchResults = Array.from(
          modalRoot.querySelectorAll('.category-item, [class*="search-result"]')
        );
        const searchMatch = searchResults.find((item) => {
          const text = normalizeText(item.textContent || "");
          return text.includes(normalizedSegment) || normalizedSegment.includes(normalizeText(item.querySelector("p")?.textContent || ""));
        });
        if (searchMatch) {
          searchMatch.click();
          await sleep(400);
          setNativeValue(searchInput, "");
          await sleep(300);
          continue;
        }
        setNativeValue(searchInput, "");
        await sleep(200);
      }
      const optionSelected = await selectDropdownOption(segment);
      if (optionSelected) continue;
      reporter.warn(`category segment not found: ${segment} (step ${i + 1}/${categoryPath.length})`);
      allSegmentsMatched = false;
      break;
    }
    await sleep(200);
    await closeCategoryModal();
    await sleep(1500);
    if (allSegmentsMatched) {
      reporter.success("categoryPath");
      return true;
    }
    const categoryBox = document.querySelector(".product-category-box");
    const selectedText = categoryBox?.textContent?.trim() || "";
    if (selectedText && !selectedText.includes("\u8ACB\u9078\u64C7")) {
      console.log(`[fb2shopee] partial category selected: "${selectedText}"`);
      reporter.warn(`category partially matched: ${selectedText}`);
      return true;
    }
    reporter.fail("categoryPath", `category not fully matched`);
    return false;
  }
  async function fillAttributes(draft, reporter) {
    const attributes = draft.shopee.attributes;
    const brand = draft.shopee.brand;
    const attrMap = /* @__PURE__ */ new Map();
    if (brand) attrMap.set("\u54C1\u724C", brand);
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        attrMap.set(key, value);
      }
    }
    if (attrMap.size === 0) {
      reporter.skip("attributes", "no attributes in AI draft");
      return;
    }
    let filled = 0;
    for (const [attrName, attrValue] of attrMap) {
      const value = Array.isArray(attrValue) ? attrValue[0] : attrValue;
      if (!value) continue;
      console.log(`[fb2shopee] filling attribute "${attrName}" = "${value}"`);
      const container = findFieldContainerByKeywords([attrName]);
      if (!container) {
        reporter.warn(`attribute field not found: ${attrName}`);
        continue;
      }
      const selectTrigger = container.querySelector(
        '.eds-select, [class*="eds-select"], [class*="select-trigger"], [role="combobox"]'
      );
      if (selectTrigger) {
        selectTrigger.click();
        await sleep(300);
        const options = Array.from(document.querySelectorAll(
          '.eds-select-option, [class*="eds-select-option"], [role="option"], .eds-dropdown-item, [class*="dropdown-item"]'
        ));
        const normalizedValue = normalizeText(value);
        const match = options.find((opt) => {
          const optText = normalizeText(opt.textContent || "");
          return optText === normalizedValue || optText.includes(normalizedValue);
        });
        if (match) {
          match.click();
          await sleep(200);
          filled++;
        } else {
          const searchInput = document.querySelector(
            '.eds-select input, [class*="eds-select"] input, .eds-popover input'
          );
          if (searchInput) {
            setNativeValue(searchInput, value);
            await sleep(400);
            const filteredOptions = Array.from(document.querySelectorAll(
              '.eds-select-option, [role="option"]'
            )).filter((o) => o.offsetParent !== null);
            if (filteredOptions.length > 0) {
              filteredOptions[0].click();
              await sleep(200);
              filled++;
            } else {
              reporter.warn(`attribute option not found for "${attrName}": "${value}"`);
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              await sleep(100);
            }
          } else {
            reporter.warn(`attribute option not found for "${attrName}": "${value}"`);
            document.body.click();
            await sleep(100);
          }
        }
      } else {
        const input = findInputInContainer(container);
        if (input && (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
          setNativeValue(input, value);
          filled++;
        } else {
          reporter.warn(`attribute input not found for "${attrName}"`);
        }
      }
    }
    if (filled > 0) {
      reporter.success("attributes");
    } else {
      reporter.fail("attributes", "could not fill any attributes");
    }
  }
  function emitEnter(input) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  }
  function findTierNameInputs() {
    return Array.from(
      document.querySelectorAll(
        'input[placeholder*="\u4F8B\u5982: \u984F\u8272"], input[placeholder*="\u4F8B\u5982: \u5C3A\u5BF8"], input[placeholder*="\u898F\u683C\u540D\u7A31"], input[placeholder*="Variation"]'
      )
    );
  }
  function findOptionInputInTierSection(tierSection) {
    const original = tierSection.querySelector(
      'input[placeholder*="\u4F8B\u5982: \u7D05\u8272"], input[placeholder*="\u4F8B\u5982: S"], input[placeholder*="\u8F38\u5165\u9078\u9805"], input[placeholder*="option"]'
    );
    if (original) return original;
    const allInputs = Array.from(
      tierSection.querySelectorAll('input[placeholder="\u8F38\u5165"]')
    ).filter((inp) => inp.offsetParent !== null && inp.type !== "file");
    const emptyInput = allInputs.filter((inp) => !inp.value.trim());
    return emptyInput[emptyInput.length - 1] ?? allInputs[allInputs.length - 1] ?? null;
  }
  async function fillTierVariations(draft, reporter) {
    const tiers = draft.shopee.tierVariationList;
    if (!tiers?.length) {
      reporter.skip("tierVariationList", "no tier variations in AI draft");
      return;
    }
    const opened = await clickByText(["\u958B\u555F\u5546\u54C1\u898F\u683C", "\u65B0\u589E\u898F\u683C", "\u555F\u7528\u898F\u683C"]);
    if (!opened) {
      const existing = findTierNameInputs();
      if (!existing.length) {
        reporter.fail("tierVariationList", "cannot open variation section");
        return;
      }
    }
    let tierInputsReady = false;
    for (let attempt = 1; attempt <= 8; attempt++) {
      await sleep(attempt <= 2 ? 400 : 600);
      if (findTierNameInputs().length > 0) {
        tierInputsReady = true;
        console.log(`[fb2shopee] tier name inputs appeared after attempt ${attempt}`);
        break;
      }
      console.log(`[fb2shopee] waiting for tier name inputs (${attempt}/8)...`);
    }
    if (!tierInputsReady) {
      reporter.fail("tierVariationList", "tier name inputs never appeared after opening spec section");
      return;
    }
    for (let i = 0; i < tiers.length; i += 1) {
      const tier = tiers[i];
      console.log(`[fb2shopee] Filling tier ${i + 1}: "${tier.name}" with ${tier.options.length} options`);
      if (i > 0) {
        const addClicked = await clickByText([`\u65B0\u589E\u898F\u683C`, "Add variation"]);
        if (addClicked) await sleep(400);
      }
      let nameInput = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const nameInputs = findTierNameInputs();
        nameInput = nameInputs[i] ?? nameInputs[nameInputs.length - 1] ?? null;
        if (nameInput) break;
        await sleep(400);
      }
      if (!nameInput) {
        reporter.fail("tierVariationList", `tier ${i + 1} name input not found`);
        continue;
      }
      nameInput.focus();
      setNativeValueCharByChar(nameInput, tier.name);
      await sleep(300);
      const tierSection = nameInput.closest(
        '.edit-row, [class*="variation"], [class*="spec"], [class*="tier"], section, .product-edit-form-item-content'
      ) ?? nameInput.parentElement?.parentElement?.parentElement ?? nameInput.parentElement;
      for (const option of tier.options) {
        const optionInput = findOptionInputInTierSection(tierSection);
        if (!optionInput) {
          console.warn(`[fb2shopee] option input not found for "${option}" in tier "${tier.name}"`);
          reporter.warn(`option input not found for tier "${tier.name}" option "${option}"`);
          continue;
        }
        optionInput.focus();
        setNativeValueCharByChar(optionInput, option);
        await sleep(100);
        emitEnter(optionInput);
        await sleep(300);
      }
      await sleep(300);
    }
    await sleep(800);
    reporter.success("tierVariationList");
  }
  async function fillStandalonePrice(draft, reporter) {
    const models = draft.shopee.modelList;
    const price = models?.[0]?.price;
    const priceContainer = findFieldContainerByKeywords(["\u50F9\u683C"]);
    const priceInput = priceContainer?.querySelector(
      '.price-input input, input.eds-input__input, input[type="text"], input[type="number"]'
    );
    if (priceInput && price !== void 0 && price > 0) {
      console.log(`[fb2shopee] filling standalone price: ${price}`);
      setNativeValueCharByChar(priceInput, String(price));
      reporter.success("price");
    } else if (!price) {
      reporter.skip("price", "no price in AI draft");
    } else {
      reporter.fail("price", "standalone price input not found");
    }
    const stockContainer = findFieldContainerByKeywords(["\u5546\u54C1\u6578\u91CF"]);
    const stockInput = stockContainer?.querySelector(
      'input.eds-input__input, input[type="text"], input[type="number"]'
    );
    if (stockInput) {
      const currentVal = stockInput.value?.trim();
      if (!currentVal || currentVal === "0") {
        console.log("[fb2shopee] filling stock: 99");
        setNativeValueCharByChar(stockInput, "99");
        reporter.success("stock");
      } else {
        reporter.skip("stock", "stock already has value");
      }
    } else {
      reporter.skip("stock", "stock input not found (may be inside spec table)");
    }
  }
  function findVariantRowInputs() {
    const table = document.querySelector(".variation-model-table");
    if (!table) return [];
    const batchRow = document.querySelector(".batch-edit-row");
    const batchInputSet = new Set(
      batchRow ? Array.from(batchRow.querySelectorAll("input")) : []
    );
    const allInputs = Array.from(table.querySelectorAll("input")).filter((inp) => !batchInputSet.has(inp) && inp.type !== "file");
    const variants = [];
    let current = null;
    for (const inp of allInputs) {
      const isPrice = !!inp.closest(".price-input");
      if (isPrice) {
        current = { price: inp, stock: null, sku: null };
        variants.push(current);
      } else if (current) {
        if (!current.stock) {
          current.stock = inp;
        } else if (!current.sku) {
          current.sku = inp;
        }
      }
    }
    return variants;
  }
  async function fillModels(draft, reporter) {
    const models = draft.shopee.modelList;
    if (!models?.length) {
      reporter.skip("modelList", "no model list in AI draft");
      await fillStandalonePrice(draft, reporter);
      return;
    }
    await sleep(500);
    const allSamePrice = models.every((m) => m.price === models[0].price);
    const batchRow = document.querySelector(".batch-edit-row");
    if (allSamePrice && batchRow) {
      console.log(`[fb2shopee] Using batch apply: price=${models[0].price}, stock=99`);
      const batchPriceInput = batchRow.querySelector(".price-input input");
      const batchStockInput = Array.from(batchRow.querySelectorAll("input")).find((inp) => inp.placeholder === "\u5546\u54C1\u6578\u91CF");
      if (batchPriceInput) {
        setNativeValueCharByChar(batchPriceInput, String(models[0].price));
        await sleep(150);
      }
      if (batchStockInput) {
        setNativeValueCharByChar(batchStockInput, "99");
        await sleep(150);
      }
      const applyBtn = batchRow.querySelector(".batch-apply-button");
      if (applyBtn) {
        await sleep(200);
        applyBtn.click();
        await sleep(500);
        console.log("[fb2shopee] Batch apply clicked");
        reporter.success("modelList");
        reporter.success("stock");
        return;
      }
    }
    const variantRows = findVariantRowInputs();
    console.log(`[fb2shopee] Found ${variantRows.length} variant rows for ${models.length} models`);
    if (!variantRows.length) {
      if (batchRow && models[0]?.price) {
        const batchPriceInput = batchRow.querySelector(".price-input input");
        const batchStockInput = Array.from(batchRow.querySelectorAll("input")).find((inp) => inp.placeholder === "\u5546\u54C1\u6578\u91CF");
        if (batchPriceInput) {
          setNativeValueCharByChar(batchPriceInput, String(models[0].price));
          await sleep(150);
        }
        if (batchStockInput) {
          setNativeValueCharByChar(batchStockInput, "99");
          await sleep(150);
        }
        const applyBtn = batchRow.querySelector(".batch-apply-button");
        if (applyBtn) {
          await sleep(200);
          applyBtn.click();
          await sleep(500);
          reporter.success("modelList");
          reporter.success("stock");
          return;
        }
      }
      reporter.fail("modelList", "no variant rows found in spec table");
      return;
    }
    let successCount = 0;
    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const row = variantRows[i];
      if (!row) {
        reporter.warn(`variant row ${i} not found for model: ${model.variationValues?.join("/") || "-"}`);
        continue;
      }
      if (row.price && model.price > 0) {
        setNativeValueCharByChar(row.price, String(model.price));
        await sleep(100);
        successCount += 1;
      }
      const stockVal = model.stock !== null && model.stock !== void 0 ? model.stock : 99;
      if (row.stock) {
        setNativeValueCharByChar(row.stock, String(stockVal));
        await sleep(100);
      }
      if (row.sku && model.sku) {
        setNativeValueCharByChar(row.sku, model.sku);
        await sleep(100);
      }
    }
    if (successCount > 0) {
      reporter.success("modelList");
      reporter.success("stock");
    } else {
      reporter.fail("modelList", "no model prices were set");
    }
  }
  async function waitForVariantTable(maxAttempts = 6, delayMs = 800) {
    const selectors = [
      ".variation-model-table-fixed-left .variation-model-table-body",
      ".variation-model-table .variation-model-table-body",
      ".variation-model-table-container .table-cell-wrapper"
    ];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          console.log(`[fb2shopee] variant table found via "${selector}" (attempt ${attempt})`);
          return el;
        }
      }
      if (attempt < maxAttempts) {
        console.log(`[fb2shopee] variant table not found, retrying (${attempt}/${maxAttempts})...`);
        await sleep(delayMs);
      }
    }
    return null;
  }
  function findCellFileInput(cell) {
    const direct = cell.querySelector('input[type="file"]');
    if (direct) return direct;
    const uploadBtn = cell.querySelector(
      '.image-upload-button, .upload-button, [class*="upload"], .eds-button'
    );
    if (uploadBtn) {
      uploadBtn.click();
      const revealed = cell.querySelector('input[type="file"]');
      if (revealed) return revealed;
    }
    return null;
  }
  async function bindVariantImages(fb, draft, imageAssignment, reporter) {
    if (!imageAssignment.variantImageMap.size) {
      if (draft.variantImageBindings.length === 0) {
        reporter.skip("variantImageBindings", "no high-confidence bindings");
      }
      for (const pending of draft.pendingVariantImageBindings) {
        reporter.pending(`\u624B\u52D5\u88DC\u898F\u683C\u5716\uFF1A${pending.tier1Option}\uFF08${pending.reason}\uFF09`);
      }
      return;
    }
    console.log(
      `[fb2shopee] bindVariantImages: ${imageAssignment.variantImageMap.size} bindings to apply`,
      Object.fromEntries(imageAssignment.variantImageMap)
    );
    let successCount = 0;
    const tableBody = await waitForVariantTable();
    const cellWrappers = tableBody ? Array.from(tableBody.querySelectorAll(".table-cell-wrapper")) : [];
    if (!cellWrappers.length) {
      const fallbackCells = Array.from(
        document.querySelectorAll(
          ".variation-model-table-container .table-cell-wrapper"
        )
      );
      if (fallbackCells.length) {
        cellWrappers.push(...fallbackCells);
        console.log(`[fb2shopee] using fallback selector, found ${fallbackCells.length} cell wrappers`);
      }
    }
    console.log(`[fb2shopee] found ${cellWrappers.length} cell wrappers for variant images`);
    const tier1Options = draft.shopee.tierVariationList?.[0]?.options ?? [];
    for (const [optionName, sourceIndex] of imageAssignment.variantImageMap) {
      const base64Item = fb.imageBase64List?.find((b) => b.sourceIndex === sourceIndex);
      let uploaded = false;
      console.log(`[fb2shopee] binding variant image: "${optionName}" -> image[${sourceIndex}] (base64: ${!!base64Item})`);
      const optionIndex = tier1Options.indexOf(optionName);
      if (optionIndex >= 0 && optionIndex < cellWrappers.length) {
        const cell = cellWrappers[optionIndex];
        const fileInput = findCellFileInput(cell);
        if (fileInput && base64Item) {
          uploaded = await uploadSingleBase64(fileInput, base64Item, reporter, `variantImage:${optionName}`);
          console.log(`[fb2shopee] strategy 1 (position match) for "${optionName}": ${uploaded ? "OK" : "FAIL"}`);
        } else {
          console.log(`[fb2shopee] strategy 1 for "${optionName}": fileInput=${!!fileInput} base64=${!!base64Item}`);
        }
      }
      if (!uploaded) {
        const optionElements = findElementsContainingText(optionName);
        for (const optionEl of optionElements) {
          const container = optionEl.closest(
            '.table-cell-wrapper, [class*="variation"], [class*="model"], div'
          ) ?? optionEl;
          const fileInput = findCellFileInput(container);
          if (!fileInput) continue;
          if (base64Item) {
            uploaded = await uploadSingleBase64(fileInput, base64Item, reporter, `variantImage:${optionName}`);
          } else {
            const url = fb.imageUrlsOrdered[sourceIndex];
            if (url) {
              await uploadImagesFromUrls(fileInput, [url], reporter, `variantImage:${optionName}`);
              uploaded = true;
            }
          }
          if (uploaded) {
            console.log(`[fb2shopee] strategy 2 (text match) for "${optionName}": OK`);
            break;
          }
        }
      }
      if (uploaded) {
        successCount += 1;
      } else {
        console.log(`[fb2shopee] FAILED to bind variant image for "${optionName}"`);
        reporter.pending(`\u624B\u52D5\u88DC\u898F\u683C\u5716\uFF1A${optionName}\uFF08\u627E\u4E0D\u5230\u4E0A\u50B3\u6B04\u4F4D\uFF09`);
      }
    }
    for (const pending of draft.pendingVariantImageBindings) {
      reporter.pending(`\u624B\u52D5\u88DC\u898F\u683C\u5716\uFF1A${pending.tier1Option}\uFF08${pending.reason}\uFF09`);
    }
    if (successCount > 0) {
      reporter.success("variantImageBindings");
      console.log(`[fb2shopee] variant image binding complete: ${successCount}/${imageAssignment.variantImageMap.size} uploaded`);
    }
  }
  async function fillShipping(draft, reporter) {
    const shipping = draft.shopee.shipping;
    if (!shipping) {
      reporter.skip("shipping", "no shipping draft");
      return;
    }
    if (shipping.weight) {
      const container = findFieldContainerByKeywords(["\u91CD\u91CF"]);
      const input = findInputInContainer(container);
      if (input && (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
        const value = shipping.weight.unit === "KG" ? shipping.weight.value : shipping.weight.value / 1e3;
        setNativeValue(input, String(value));
        reporter.success("shipping.weight");
      } else {
        reporter.fail("shipping.weight", "weight field not found");
      }
    } else {
      reporter.skip("shipping.weight", "missing shipping weight");
    }
    if (shipping.dimension) {
      const dims = [
        { keyword: "\u9577", value: shipping.dimension.length },
        { keyword: "\u5BEC", value: shipping.dimension.width },
        { keyword: "\u9AD8", value: shipping.dimension.height }
      ];
      let dimSuccess = true;
      for (const dim of dims) {
        const container = findFieldContainerByKeywords([dim.keyword]);
        const input = findInputInContainer(container);
        if (input && (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
          setNativeValue(input, String(dim.value));
        } else {
          reporter.warn(`dimension field not found: ${dim.keyword}`);
          dimSuccess = false;
        }
      }
      if (dimSuccess) {
        reporter.success("shipping.dimension");
      } else {
        reporter.fail("shipping.dimension", "one or more dimension fields missing");
      }
    } else {
      reporter.skip("shipping.dimension", "no package dimension provided");
    }
    if (shipping.preOrderDaysToShip !== void 0) {
      const preOrderClicked = await clickByText(["\u662F"], findFieldContainerByKeywords(["\u8F03\u9577\u5099\u8CA8", "\u5099\u8CA8"]) ?? void 0);
      if (preOrderClicked) {
        await sleep(200);
        const daysField = findFieldContainerByKeywords(["\u5099\u8CA8\u5929\u6578", "\u51FA\u8CA8\u5929\u6578", "\u5929"]);
        const daysInput = findInputInContainer(daysField);
        if (daysInput && (daysInput instanceof HTMLInputElement || daysInput instanceof HTMLTextAreaElement)) {
          setNativeValue(daysInput, String(shipping.preOrderDaysToShip));
          reporter.success("shipping.preOrderDaysToShip");
        } else {
          reporter.fail("shipping.preOrderDaysToShip", "days input not found after enabling pre-order");
        }
      } else {
        reporter.fail("shipping.preOrderDaysToShip", "pre-order toggle not found");
      }
    } else {
      reporter.skip("shipping.preOrderDaysToShip", "no pre-order days value");
    }
    if (shipping.logisticsChannels?.length) {
      let matched = 0;
      for (const channel of shipping.logisticsChannels) {
        const labels = findElementsContainingText(channel);
        const target = labels[0];
        if (!target) {
          reporter.warn(`logistics channel not found: ${channel}`);
          continue;
        }
        const container = target.closest("div, label, li, section") ?? target;
        const toggle = container.querySelector(
          '[class*="switch"], [class*="toggle"], input[type="checkbox"], [role="switch"]'
        );
        if (toggle) {
          const isOn = toggle.classList.contains("is-checked") || toggle.getAttribute("aria-checked") === "true" || toggle instanceof HTMLInputElement && toggle.checked;
          if (!isOn) {
            toggle.click();
            await sleep(200);
          }
          matched += 1;
        } else {
          target.click();
          matched += 1;
          await sleep(100);
        }
      }
      if (matched > 0) {
        reporter.success("logisticsChannels");
      } else {
        reporter.fail("logisticsChannels", "no logistics channel matched");
      }
    } else {
      reporter.skip("logisticsChannels", "no logistics channels provided");
    }
  }
  async function reattachBase64FromStorage(fb) {
    if (fb.imageBase64List?.length) {
      return fb;
    }
    try {
      const stored = await chrome.storage.local.get("lastFbBase64Images");
      const base64List = stored.lastFbBase64Images;
      if (Array.isArray(base64List) && base64List.length > 0) {
        return { ...fb, imageBase64List: base64List };
      }
    } catch {
    }
    return fb;
  }
  async function applyDraft(payload) {
    if (!isNewProductPage()) {
      throw new Error("Current page is not Shopee new product page");
    }
    const reporter = new FillReporter();
    const fb = await reattachBase64FromStorage(payload.fb);
    const { draft } = payload;
    console.log("[fb2shopee] applyDraft started", {
      imageUrls: fb.imageUrlsOrdered.length,
      hasBase64: Boolean(fb.imageBase64List?.length),
      base64Count: fb.imageBase64List?.length ?? 0,
      title: draft.shopee.title?.slice(0, 30),
      tiers: draft.shopee.tierVariationList?.length ?? 0,
      models: draft.shopee.modelList?.length ?? 0,
      mainImages: draft.shopee.images.length,
      variantBindings: draft.variantImageBindings.length
    });
    for (const warning of draft.warnings) {
      reporter.warn(warning);
    }
    const imageAssignment = resolveImageAssignment(fb, draft);
    try {
      console.log("[fb2shopee] Step 1: Filling category", draft.shopee.categoryPath);
      await fillCategoryPath(draft.shopee.categoryPath, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 1 error:", e);
      reporter.fail("categoryPath", `exception: ${e instanceof Error ? e.message : "unknown"}`);
      try {
        await closeCategoryModal();
      } catch {
      }
    }
    try {
      console.log("[fb2shopee] Step 2: Filling basic info");
      await fillBasicInfo(fb, draft, imageAssignment, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 2 error:", e);
      reporter.fail("basicInfo", `exception: ${e instanceof Error ? e.message : "unknown"}`);
    }
    try {
      console.log("[fb2shopee] Step 3: Filling attributes");
      await fillAttributes(draft, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 3 error:", e);
      reporter.fail("attributes", `exception: ${e instanceof Error ? e.message : "unknown"}`);
    }
    try {
      console.log("[fb2shopee] Step 4: Filling tier variations");
      await fillTierVariations(draft, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 4 error:", e);
      reporter.fail("tierVariationList", `exception: ${e instanceof Error ? e.message : "unknown"}`);
    }
    try {
      console.log("[fb2shopee] Step 5: Filling models/price");
      await fillModels(draft, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 5 error:", e);
      reporter.fail("modelList", `exception: ${e instanceof Error ? e.message : "unknown"}`);
    }
    try {
      console.log("[fb2shopee] Step 6: Binding variant images");
      await bindVariantImages(fb, draft, imageAssignment, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 6 error:", e);
      reporter.fail("variantImageBindings", `exception: ${e instanceof Error ? e.message : "unknown"}`);
    }
    try {
      console.log("[fb2shopee] Step 7: Filling shipping");
      await fillShipping(draft, reporter);
    } catch (e) {
      console.error("[fb2shopee] Step 7 error:", e);
      reporter.fail("shipping", `exception: ${e instanceof Error ? e.message : "unknown"}`);
    }
    reporter.skip("publish", "publish action is intentionally disabled by design");
    lastFillReport = reporter.toJSON();
    console.log("[fb2shopee] applyDraft finished", lastFillReport);
    return lastFillReport;
  }
  var SHOPEE_LISTENER_KEY = "__fb2shopee_shopee_listener__";
  if (!window[SHOPEE_LISTENER_KEY]) {
    window[SHOPEE_LISTENER_KEY] = true;
    console.log("[fb2shopee] Registering Shopee content script message listener");
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const knownTypes = [MSG.collect_shopee_schema, MSG.apply_shopee_draft, MSG.get_fill_report];
      if (!knownTypes.includes(message.type ?? "")) {
        return false;
      }
      let responded = false;
      const safeRespond = (data) => {
        if (responded) return;
        responded = true;
        try {
          sendResponse(data);
        } catch (e) {
          console.error("[fb2shopee] sendResponse failed (channel likely closed):", e);
        }
      };
      void (async () => {
        try {
          if (message.type === MSG.collect_shopee_schema) {
            if (!isNewProductPage()) {
              throw new Error("Please open Shopee new product page first");
            }
            const payload = collectSchemaSnapshot();
            safeRespond({ ok: true, payload });
            return;
          }
          if (message.type === MSG.apply_shopee_draft) {
            console.log("[fb2shopee] Received apply_shopee_draft message");
            const payload = await applyDraft(message.payload);
            safeRespond({ ok: true, payload });
            return;
          }
          if (message.type === MSG.get_fill_report) {
            safeRespond({ ok: true, payload: lastFillReport ?? void 0 });
            return;
          }
        } catch (error) {
          console.error("[fb2shopee] Message handler error:", error);
          safeRespond({ ok: false, error: pickErrorMessage(error) });
        }
      })();
      return true;
    });
  } else {
    console.log("[fb2shopee] Shopee content script listener already registered, skipping");
  }
})();
//# sourceMappingURL=content-shopee.js.map
