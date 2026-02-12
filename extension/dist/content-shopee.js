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
    const clickableSelector = 'button, [role="button"], a, div, span';
    for (const text of textCandidates) {
      const targetText = normalizeText(text);
      const elements = Array.from(root.querySelectorAll(clickableSelector));
      const found = elements.find((el) => normalizeText(el.textContent || "").includes(targetText));
      if (found) {
        found.click();
        await sleep(120);
        return true;
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
  function findFileInputByContext(contextKeywords) {
    const container = findFieldContainerByKeywords(contextKeywords);
    const scopedInput = container?.querySelector('input[type="file"]');
    if (scopedInput) {
      return scopedInput;
    }
    return document.querySelector('input[type="file"]');
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
  function findModelRow(model) {
    const rows = Array.from(document.querySelectorAll('tr, [class*="model-row"], [class*="variation-row"]'));
    if (!model.variationValues?.length) {
      return rows[0] || null;
    }
    const normalizedTargets = model.variationValues.map((x) => normalizeText(x));
    return rows.find((row) => {
      const rowText = normalizeText(row.textContent || "");
      return normalizedTargets.every((target) => rowText.includes(target));
    }) || null;
  }
  function fillPriceInputInRow(row, price) {
    const candidates = Array.from(
      row.querySelectorAll('input[type="text"], input[type="number"]')
    ).filter((input) => {
      const p = normalizeText(input.placeholder || "");
      return p.includes("\u50F9\u683C") || p.includes("price") || p.includes("\u552E\u50F9");
    });
    const target = candidates[0] || row.querySelector('input[type="text"], input[type="number"]');
    if (!target) {
      return false;
    }
    setNativeValue(target, String(price));
    return true;
  }
  function fillSkuInputInRow(row, sku) {
    const candidates = Array.from(
      row.querySelectorAll('input[type="text"], input[type="number"]')
    ).filter((input) => {
      const p = normalizeText(input.placeholder || "");
      return p.includes("sku") || p.includes("\u578B\u865F") || p.includes("\u8CE3\u5BB6");
    });
    const target = candidates[0];
    if (!target) {
      return false;
    }
    setNativeValue(target, sku);
    return true;
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
    {
      key: "images",
      section: "basic",
      type: "array",
      requiredByDefault: true,
      keywords: ["\u5546\u54C1\u5716\u7247", "\u5716\u7247"]
    },
    {
      key: "name",
      section: "basic",
      type: "string",
      requiredByDefault: true,
      keywords: ["\u5546\u54C1\u540D\u7A31", "\u540D\u7A31"]
    },
    {
      key: "description",
      section: "basic",
      type: "string",
      requiredByDefault: true,
      keywords: ["\u5546\u54C1\u63CF\u8FF0", "\u63CF\u8FF0"]
    },
    {
      key: "categoryPath",
      section: "category",
      type: "array",
      requiredByDefault: true,
      keywords: ["\u5546\u54C1\u5206\u985E", "\u5206\u985E"]
    },
    {
      key: "brand",
      section: "basic",
      type: "string",
      requiredByDefault: false,
      keywords: ["\u54C1\u724C"]
    },
    {
      key: "tierVariationList",
      section: "spec",
      type: "array",
      requiredByDefault: false,
      keywords: ["\u5546\u54C1\u898F\u683C", "\u898F\u683C"]
    },
    {
      key: "modelList",
      section: "sales",
      type: "array",
      requiredByDefault: false,
      keywords: ["\u578B\u865F", "\u578B\u865F\u8CC7\u8A0A", "\u92B7\u552E\u8CC7\u8A0A"]
    },
    {
      key: "weight",
      section: "shipping",
      type: "number",
      requiredByDefault: false,
      keywords: ["\u91CD\u91CF"]
    },
    {
      key: "dimension",
      section: "shipping",
      type: "object",
      requiredByDefault: false,
      keywords: ["\u5305\u88F9\u5C3A\u5BF8", "\u5C3A\u5BF8"]
    },
    {
      key: "logisticsChannels",
      section: "shipping",
      type: "array",
      requiredByDefault: false,
      keywords: ["\u7269\u6D41", "\u914D\u9001\u65B9\u5F0F"]
    }
  ];
  var lastFillReport = null;
  function isNewProductPage() {
    return window.location.hostname === "seller.shopee.tw" && window.location.pathname.startsWith(SHOPEE_NEW_PRODUCT_PATH);
  }
  function inferRequired(container, fallback) {
    if (!container) {
      return fallback;
    }
    const text = container.textContent || "";
    if (/\*/.test(text) || /必填/.test(text)) {
      return true;
    }
    if (/選填/.test(text)) {
      return false;
    }
    return fallback;
  }
  function collectFieldOptions(container) {
    if (!container) {
      return void 0;
    }
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
      if (!container) {
        continue;
      }
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
    if (!match?.[1]) {
      return void 0;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : void 0;
  }
  function extractRange(content, pattern) {
    const match = content.match(pattern);
    if (!match?.[1] || !match?.[2]) {
      return void 0;
    }
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return void 0;
    }
    return [min, max];
  }
  function normalizeWindowPath(path) {
    return path.replace(/\[(\d+)\]/g, ".$1").toLowerCase();
  }
  function maybeAssignConstraint(path, value, target) {
    const key = normalizeWindowPath(path);
    const assign = (constraintKey) => {
      const existing = target[constraintKey];
      if (existing === void 0) {
        target[constraintKey] = value;
      }
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
    if (count.scanned >= MAX_DEEP_SCAN_NODES || value == null) {
      return;
    }
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
    if (visited.has(obj)) {
      return;
    }
    visited.add(obj);
    for (const [key, child] of Object.entries(obj)) {
      const nextPath = path ? `${path}.${key}` : key;
      deepScanConstraints(child, target, nextPath, visited, count);
    }
    count.scanned += 1;
  }
  function collectConstraintsFromWindow() {
    const collected = {};
    const win = window;
    const candidates = [
      win.__INITIAL_STATE__,
      win.__PRELOADED_STATE__,
      win.__NEXT_DATA__,
      win.__NUXT__,
      win.__APP_STATE__
    ];
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
        if (v === void 0) {
          continue;
        }
        out[k] = v;
      }
    }
    return out;
  }
  function collectSchemaSnapshot() {
    const constraints = mergeConstraints(
      DEFAULT_CONSTRAINTS,
      collectConstraintsFromWindow(),
      collectConstraintsFromText()
    );
    return {
      version: "v1",
      region: "tw",
      capturedAtISO: nowIso(),
      fields: collectFieldsSnapshot(),
      constraints
    };
  }
  function resolveOrderedImages(fb, draft) {
    const mapped = [];
    for (const item of draft.shopee.images) {
      const url = fb.imageUrlsOrdered[item.sourceIndex];
      if (url && !mapped.includes(url)) {
        mapped.push(url);
      }
    }
    if (!mapped.length) {
      return fb.imageUrlsOrdered.slice();
    }
    return mapped;
  }
  function resolveTextFieldInput(keywords) {
    const container = findFieldContainerByKeywords(keywords);
    const direct = findInputInContainer(container);
    if (direct) {
      return direct;
    }
    const editable = container?.querySelector('[contenteditable="true"]');
    if (editable) {
      return editable;
    }
    const generic = document.querySelector(
      'input[type="text"], textarea, [contenteditable="true"]'
    );
    return generic;
  }
  function applyTextValue(field, target, value, reporter) {
    if (!target) {
      reporter.fail(field, "field not found");
      return false;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      setNativeValue(target, value);
      reporter.success(field);
      return true;
    }
    setContentEditableText(target, value);
    reporter.success(field);
    return true;
  }
  async function fillBasicInfo(fb, draft, reporter) {
    const imageInput = findFileInputByContext(["\u5546\u54C1\u5716\u7247", "\u5716\u7247"]);
    if (imageInput) {
      const orderedImages = resolveOrderedImages(fb, draft);
      await uploadImagesFromUrls(imageInput, orderedImages, reporter, "images");
    } else {
      reporter.fail("images", "image upload input not found");
    }
    applyTextValue(
      "name",
      resolveTextFieldInput(["\u5546\u54C1\u540D\u7A31", "\u540D\u7A31"]),
      draft.shopee.title,
      reporter
    );
    applyTextValue(
      "description",
      resolveTextFieldInput(["\u5546\u54C1\u63CF\u8FF0", "\u63CF\u8FF0"]),
      draft.shopee.description,
      reporter
    );
    if (draft.shopee.brand) {
      const ok = applyTextValue("brand", resolveTextFieldInput(["\u54C1\u724C"]), draft.shopee.brand, reporter);
      if (!ok) {
        reporter.skip("brand", "brand field not found");
      }
    } else {
      reporter.skip("brand", "no brand in AI draft");
    }
  }
  async function fillCategoryPath(categoryPath, reporter) {
    if (!categoryPath.length) {
      reporter.fail("categoryPath", "empty category path");
      return false;
    }
    const categoryContainer = findFieldContainerByKeywords(["\u5546\u54C1\u5206\u985E", "\u5206\u985E"]);
    if (!categoryContainer) {
      reporter.fail("categoryPath", "category field not found");
      return false;
    }
    const button = categoryContainer.querySelector('button, [role="button"]');
    if (button) {
      button.click();
    } else {
      categoryContainer.click();
    }
    await sleep(180);
    const openCategoryPanel = await clickByText(["\u7DE8\u8F2F\u5206\u985E", "\u9078\u64C7\u5206\u985E", "\u65B0\u589E\u5206\u985E"]);
    if (openCategoryPanel) {
      await sleep(180);
    }
    for (const segment of categoryPath) {
      const selected = await selectDropdownOption(segment);
      if (selected) {
        continue;
      }
      const searchInput = document.querySelector(
        'input[placeholder*="\u641C\u5C0B"], input[placeholder*="Search"], input[placeholder*="\u5206\u985E"]'
      );
      if (searchInput) {
        setNativeValue(searchInput, segment);
        await sleep(200);
        if (await selectDropdownOption(segment)) {
          continue;
        }
      }
      reporter.fail("categoryPath", `category option not found: ${segment}`);
      return false;
    }
    await clickByText(["\u78BA\u8A8D", "\u5132\u5B58", "\u5B8C\u6210"]);
    reporter.success("categoryPath");
    return true;
  }
  function emitEnter(input) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  }
  function queryTierNameInputs() {
    return Array.from(
      document.querySelectorAll(
        'input[placeholder*="\u898F\u683C\u540D\u7A31" i], input[placeholder*="Variation" i], input[placeholder*="tier" i], input[aria-label*="\u898F\u683C" i]'
      )
    );
  }
  function queryOptionInputNear(anchor) {
    if (!anchor) {
      return null;
    }
    const scope = anchor.closest('[class*="variation" i], [class*="spec" i], [class*="model" i]') || anchor.parentElement || anchor;
    return scope.querySelector(
      'input[placeholder*="\u9078\u9805" i], input[placeholder*="option" i], input[placeholder*="\u8F38\u5165" i], input[aria-label*="\u9078\u9805" i]'
    ) || null;
  }
  async function maybeAddTierVariation(index) {
    if (index === 0) {
      return;
    }
    const clicked = await clickByText(["\u65B0\u589E\u898F\u683C", "\u65B0\u589E\u7B2C\u4E00\u5C64\u898F\u683C", "\u65B0\u589E\u7B2C\u4E8C\u5C64\u898F\u683C", "Add variation"]);
    if (clicked) {
      await sleep(200);
    }
  }
  async function fillTierVariations(draft, reporter) {
    const tiers = draft.shopee.tierVariationList;
    if (!tiers?.length) {
      reporter.skip("tierVariationList", "no tier variations in AI draft");
      return;
    }
    await clickByText(["\u958B\u555F\u5546\u54C1\u898F\u683C", "\u65B0\u589E\u898F\u683C", "\u555F\u7528\u898F\u683C"]);
    await sleep(180);
    for (let i = 0; i < tiers.length; i += 1) {
      const tier = tiers[i];
      await maybeAddTierVariation(i);
      const nameInputs = queryTierNameInputs();
      const nameInput = nameInputs[i] || nameInputs[nameInputs.length - 1] || null;
      if (!nameInput) {
        reporter.fail("tierVariationList", `tier name input missing for ${tier.name}`);
        continue;
      }
      setNativeValue(nameInput, tier.name);
      await sleep(120);
      const optionInput = queryOptionInputNear(nameInput);
      if (!optionInput) {
        reporter.fail("tierVariationList", `tier option input missing for ${tier.name}`);
        continue;
      }
      for (const option of tier.options) {
        setNativeValue(optionInput, option);
        emitEnter(optionInput);
        await sleep(80);
      }
    }
    reporter.success("tierVariationList");
  }
  function fillModelRow(row, model, reporter) {
    let success = true;
    if (!fillPriceInputInRow(row, model.price)) {
      reporter.fail("modelList", "price input not found for one model row");
      success = false;
    }
    if (model.sku && !fillSkuInputInRow(row, model.sku)) {
      reporter.warn(`sku input not found for model ${model.variationValues?.join("/") || "-"}`);
    }
    return success;
  }
  async function fillModels(draft, reporter) {
    const models = draft.shopee.modelList;
    if (!models?.length) {
      reporter.skip("modelList", "no model list in AI draft");
      reporter.skip("stock", "stock is always manual");
      return;
    }
    await sleep(250);
    let successCount = 0;
    for (const model of models) {
      const row = findModelRow(model);
      if (!row) {
        reporter.fail("modelList", `model row not found for ${model.variationValues?.join("/") || "-"}`);
        continue;
      }
      if (fillModelRow(row, model, reporter)) {
        successCount += 1;
      }
    }
    if (successCount > 0) {
      reporter.success("modelList");
    }
    reporter.skip("stock", "stock is intentionally left blank for manual input");
  }
  async function uploadVariantImageForOption(option, imageUrl, reporter) {
    const optionMatches = findElementsContainingText(option).filter((el) => {
      const normalized = normalizeText(el.textContent || "");
      return normalized.includes(normalizeText(option));
    });
    for (const match of optionMatches) {
      const block = match.closest('[class*="variation" i], [class*="spec" i], [class*="model" i], li, tr, div') || match;
      const fileInput = block.querySelector('input[type="file"]');
      if (!fileInput) {
        continue;
      }
      await uploadImagesFromUrls(fileInput, [imageUrl], reporter, `variantImage:${option}`);
      return true;
    }
    return false;
  }
  async function bindVariantImages(fb, draft, reporter) {
    if (!draft.variantImageBindings.length) {
      reporter.skip("variantImageBindings", "no high-confidence binding");
    }
    let successCount = 0;
    for (const item of draft.variantImageBindings) {
      const imageUrl = fb.imageUrlsOrdered[item.imageSourceIndex];
      if (!imageUrl) {
        reporter.pending(`\u624B\u52D5\u88DC\u898F\u683C\u5716\uFF1A${item.tier1Option}\uFF08\u627E\u4E0D\u5230\u4F86\u6E90\u5716\u7247\uFF09`);
        continue;
      }
      const uploaded = await uploadVariantImageForOption(item.tier1Option, imageUrl, reporter);
      if (!uploaded) {
        reporter.pending(`\u624B\u52D5\u88DC\u898F\u683C\u5716\uFF1A${item.tier1Option}\uFF08\u9801\u9762\u627E\u4E0D\u5230\u898F\u683C\u5716\u4E0A\u50B3\u6B04\u4F4D\uFF09`);
        continue;
      }
      successCount += 1;
    }
    for (const pending of draft.pendingVariantImageBindings) {
      reporter.pending(`\u624B\u52D5\u88DC\u898F\u683C\u5716\uFF1A${pending.tier1Option}\uFF08${pending.reason}\uFF09`);
    }
    if (successCount > 0) {
      reporter.success("variantImageBindings");
    }
  }
  function fillDimensionValue(keyword, value, reporter) {
    const container = findFieldContainerByKeywords([keyword]);
    const input = findInputInContainer(container);
    if (!input || !(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
      reporter.warn(`dimension field not found: ${keyword}`);
      return false;
    }
    setNativeValue(input, String(value));
    return true;
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
      const ok = [
        fillDimensionValue("\u9577", shipping.dimension.length, reporter),
        fillDimensionValue("\u5BEC", shipping.dimension.width, reporter),
        fillDimensionValue("\u9AD8", shipping.dimension.height, reporter)
      ].every(Boolean);
      if (ok) {
        reporter.success("shipping.dimension");
      } else {
        reporter.fail("shipping.dimension", "one or more dimension fields missing");
      }
    } else {
      reporter.skip("shipping.dimension", "no package dimension provided");
    }
    if (shipping.preOrderDaysToShip !== void 0) {
      const daysField = findFieldContainerByKeywords(["\u5099\u8CA8\u5929\u6578", "\u51FA\u8CA8\u5929\u6578"]);
      if (daysField) {
        daysField.click();
        await sleep(100);
        const selected = await selectDropdownOption(`${shipping.preOrderDaysToShip}`);
        if (selected) {
          reporter.success("shipping.preOrderDaysToShip");
        } else {
          reporter.fail("shipping.preOrderDaysToShip", "days-to-ship option not found");
        }
      } else {
        reporter.fail("shipping.preOrderDaysToShip", "days-to-ship field not found");
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
        const checkbox = target.closest("label")?.querySelector('input[type="checkbox"]') || target.querySelector('input[type="checkbox"]');
        if (checkbox) {
          if (!checkbox.checked) {
            checkbox.click();
            await sleep(60);
          }
          matched += 1;
          continue;
        }
        target.click();
        matched += 1;
        await sleep(60);
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
  async function applyDraft(payload) {
    if (!isNewProductPage()) {
      throw new Error("Current page is not Shopee new product page");
    }
    const reporter = new FillReporter();
    const { fb, draft } = payload;
    for (const warning of draft.warnings) {
      reporter.warn(warning);
    }
    await fillBasicInfo(fb, draft, reporter);
    const categoryOk = await fillCategoryPath(draft.shopee.categoryPath, reporter);
    if (!categoryOk) {
      lastFillReport = reporter.toJSON();
      return lastFillReport;
    }
    await fillTierVariations(draft, reporter);
    await fillModels(draft, reporter);
    await bindVariantImages(fb, draft, reporter);
    await fillShipping(draft, reporter);
    reporter.skip("publish", "publish action is intentionally disabled by design");
    lastFillReport = reporter.toJSON();
    return lastFillReport;
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      try {
        if (message.type === MSG.collect_shopee_schema) {
          if (!isNewProductPage()) {
            throw new Error("Please open Shopee new product page first");
          }
          const payload = collectSchemaSnapshot();
          sendResponse({ ok: true, payload });
          return;
        }
        if (message.type === MSG.apply_shopee_draft) {
          const payload = await applyDraft(message.payload);
          sendResponse({ ok: true, payload });
          return;
        }
        if (message.type === MSG.get_fill_report) {
          sendResponse({ ok: true, payload: lastFillReport ?? void 0 });
          return;
        }
      } catch (error) {
        sendResponse({ ok: false, error: pickErrorMessage(error) });
      }
    })();
    return true;
  });
})();
//# sourceMappingURL=content-shopee.js.map
