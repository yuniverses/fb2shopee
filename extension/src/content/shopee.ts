import type {
  AiProductDraftV2,
  AiModel,
  FBPostPayload,
  FillReportV2,
  ShopeeConstraints,
  ShopeeFieldSection,
  ShopeeSchemaField,
  ShopeeSchemaSnapshot
} from '@shared/contracts';
import { MSG, type AnyRuntimeRequest } from '@shared/messages';
import { nowIso, pickErrorMessage } from '@shared/runtime';
import {
  FillReporter,
  clickByText,
  fillPriceInputInRow,
  fillSkuInputInRow,
  findElementsContainingText,
  findFieldContainerByKeywords,
  findFileInputByContext,
  findInputInContainer,
  findModelRow,
  normalizeText,
  selectDropdownOption,
  setContentEditableText,
  setNativeValue,
  sleep,
  uploadImagesFromUrls,
  uniqueStringArray
} from './shopeeAdapters';

const SHOPEE_NEW_PRODUCT_PATH = '/portal/product/new';
const MAX_DEEP_SCAN_NODES = 12000;

const DEFAULT_CONSTRAINTS: Required<ShopeeConstraints> = {
  imageNumMin: 1,
  imageNumMax: 9,
  priceMin: 1,
  priceMax: 1000000,
  stockMin: 0,
  stockMax: 999999,
  dtsMin: 0,
  dtsMax: 30,
  inStockDts: 2,
  videoDurationMin: 0,
  videoDurationMax: 300,
  videoSizeLimit: 30 * 1024 * 1024
};

interface FieldProbe {
  key: string;
  section: ShopeeFieldSection;
  type: ShopeeSchemaField['type'];
  requiredByDefault: boolean;
  keywords: string[];
}

const FIELD_PROBES: FieldProbe[] = [
  {
    key: 'images',
    section: 'basic',
    type: 'array',
    requiredByDefault: true,
    keywords: ['商品圖片', '圖片']
  },
  {
    key: 'name',
    section: 'basic',
    type: 'string',
    requiredByDefault: true,
    keywords: ['商品名稱', '名稱']
  },
  {
    key: 'description',
    section: 'basic',
    type: 'string',
    requiredByDefault: true,
    keywords: ['商品描述', '描述']
  },
  {
    key: 'categoryPath',
    section: 'category',
    type: 'array',
    requiredByDefault: true,
    keywords: ['商品分類', '分類']
  },
  {
    key: 'brand',
    section: 'basic',
    type: 'string',
    requiredByDefault: false,
    keywords: ['品牌']
  },
  {
    key: 'tierVariationList',
    section: 'spec',
    type: 'array',
    requiredByDefault: false,
    keywords: ['商品規格', '規格']
  },
  {
    key: 'modelList',
    section: 'sales',
    type: 'array',
    requiredByDefault: false,
    keywords: ['型號', '型號資訊', '銷售資訊']
  },
  {
    key: 'weight',
    section: 'shipping',
    type: 'number',
    requiredByDefault: false,
    keywords: ['重量']
  },
  {
    key: 'dimension',
    section: 'shipping',
    type: 'object',
    requiredByDefault: false,
    keywords: ['包裹尺寸', '尺寸']
  },
  {
    key: 'logisticsChannels',
    section: 'shipping',
    type: 'array',
    requiredByDefault: false,
    keywords: ['物流', '配送方式']
  }
];

let lastFillReport: FillReportV2 | null = null;

function isNewProductPage(): boolean {
  return (
    window.location.hostname === 'seller.shopee.tw' &&
    window.location.pathname.startsWith(SHOPEE_NEW_PRODUCT_PATH)
  );
}

function inferRequired(container: HTMLElement | null, fallback: boolean): boolean {
  if (!container) {
    return fallback;
  }
  const text = container.textContent || '';
  if (/\*/.test(text) || /必填/.test(text)) {
    return true;
  }
  if (/選填/.test(text)) {
    return false;
  }
  return fallback;
}

function collectFieldOptions(container: HTMLElement | null): string[] | undefined {
  if (!container) {
    return undefined;
  }

  const optionNodes = Array.from(
    container.querySelectorAll<HTMLElement>('button, [role="button"], [role="option"], label, li')
  );

  const options = uniqueStringArray(
    optionNodes
      .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 0 && text.length < 40)
  );

  return options.length ? options.slice(0, 80) : undefined;
}

function collectFieldsSnapshot(): ShopeeSchemaField[] {
  const fields: ShopeeSchemaField[] = [];

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

function extractNumber(content: string, pattern: RegExp): number | undefined {
  const match = content.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractRange(content: string, pattern: RegExp): [number, number] | undefined {
  const match = content.match(pattern);
  if (!match?.[1] || !match?.[2]) {
    return undefined;
  }

  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }

  return [min, max];
}

function normalizeWindowPath(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1').toLowerCase();
}

function maybeAssignConstraint(path: string, value: number, target: ShopeeConstraints): void {
  const key = normalizeWindowPath(path);

  const assign = (constraintKey: keyof ShopeeConstraints): void => {
    const existing = target[constraintKey];
    if (existing === undefined) {
      target[constraintKey] = value;
    }
  };

  if (key.includes('image') && key.includes('max')) {
    assign('imageNumMax');
    return;
  }
  if (key.includes('image') && key.includes('min')) {
    assign('imageNumMin');
    return;
  }
  if (key.includes('price') && key.includes('max')) {
    assign('priceMax');
    return;
  }
  if (key.includes('price') && key.includes('min')) {
    assign('priceMin');
    return;
  }
  if ((key.includes('stock') || key.includes('qty')) && key.includes('max')) {
    assign('stockMax');
    return;
  }
  if ((key.includes('stock') || key.includes('qty')) && key.includes('min')) {
    assign('stockMin');
    return;
  }
  if ((key.includes('dts') || key.includes('days_to_ship') || key.includes('preorder')) && key.includes('max')) {
    assign('dtsMax');
    return;
  }
  if ((key.includes('dts') || key.includes('days_to_ship') || key.includes('preorder')) && key.includes('min')) {
    assign('dtsMin');
    return;
  }
  if (key.includes('instock') && (key.includes('dts') || key.includes('days'))) {
    assign('inStockDts');
    return;
  }
  if (key.includes('video') && key.includes('duration') && key.includes('max')) {
    assign('videoDurationMax');
    return;
  }
  if (key.includes('video') && key.includes('duration') && key.includes('min')) {
    assign('videoDurationMin');
    return;
  }
  if (key.includes('video') && (key.includes('size') || key.includes('filesize') || key.includes('file_size'))) {
    assign('videoSizeLimit');
  }
}

function deepScanConstraints(
  value: unknown,
  target: ShopeeConstraints,
  path: string,
  visited: WeakSet<object>,
  count: { scanned: number }
): void {
  if (count.scanned >= MAX_DEEP_SCAN_NODES || value == null) {
    return;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
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

  if (typeof value !== 'object') {
    count.scanned += 1;
    return;
  }

  const obj = value as Record<string, unknown>;
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

function collectConstraintsFromWindow(): ShopeeConstraints {
  const collected: ShopeeConstraints = {};
  const win = window as unknown as Record<string, unknown>;

  const candidates = [
    win.__INITIAL_STATE__,
    win.__PRELOADED_STATE__,
    win.__NEXT_DATA__,
    win.__NUXT__,
    win.__APP_STATE__
  ];

  const visited = new WeakSet<object>();
  const count = { scanned: 0 };
  for (const item of candidates) {
    deepScanConstraints(item, collected, '', visited, count);
  }

  return collected;
}

function collectConstraintsFromText(): ShopeeConstraints {
  const text = (document.body?.textContent || '').replace(/\s+/g, ' ');
  const constraints: ShopeeConstraints = {};

  const imageRange = extractRange(text, /圖片[^\d]{0,20}(\d+)\D+(\d+)\s*張/i);
  if (imageRange) {
    constraints.imageNumMin = imageRange[0];
    constraints.imageNumMax = imageRange[1];
  }

  constraints.imageNumMax =
    constraints.imageNumMax ?? extractNumber(text, /最多[^\d]{0,20}(\d+)\s*張(?:商品)?圖片/i);
  constraints.imageNumMin =
    constraints.imageNumMin ?? extractNumber(text, /至少[^\d]{0,20}(\d+)\s*張(?:商品)?圖片/i);

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
  if (videoSizeMB !== undefined) {
    constraints.videoSizeLimit = videoSizeMB * 1024 * 1024;
  }

  return constraints;
}

function mergeConstraints(...parts: ShopeeConstraints[]): ShopeeConstraints {
  const out: ShopeeConstraints = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part) as Array<[keyof ShopeeConstraints, number | undefined]>) {
      if (v === undefined) {
        continue;
      }
      out[k] = v;
    }
  }
  return out;
}

function collectSchemaSnapshot(): ShopeeSchemaSnapshot {
  const constraints = mergeConstraints(
    DEFAULT_CONSTRAINTS,
    collectConstraintsFromWindow(),
    collectConstraintsFromText()
  );

  return {
    version: 'v1',
    region: 'tw',
    capturedAtISO: nowIso(),
    fields: collectFieldsSnapshot(),
    constraints
  };
}

function resolveOrderedImages(fb: FBPostPayload, draft: AiProductDraftV2): string[] {
  const mapped: string[] = [];
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

function resolveTextFieldInput(keywords: string[]): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const container = findFieldContainerByKeywords(keywords);
  const direct = findInputInContainer(container);
  if (direct) {
    return direct;
  }

  const editable = container?.querySelector<HTMLElement>('[contenteditable="true"]');
  if (editable) {
    return editable;
  }

  const generic = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], textarea, [contenteditable="true"]'
  );
  return generic;
}

function applyTextValue(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null,
  value: string,
  reporter: FillReporter
): boolean {
  if (!target) {
    reporter.fail(field, 'field not found');
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

async function fillBasicInfo(
  fb: FBPostPayload,
  draft: AiProductDraftV2,
  reporter: FillReporter
): Promise<void> {
  const imageInput = findFileInputByContext(['商品圖片', '圖片']);
  if (imageInput) {
    const orderedImages = resolveOrderedImages(fb, draft);
    await uploadImagesFromUrls(imageInput, orderedImages, reporter, 'images');
  } else {
    reporter.fail('images', 'image upload input not found');
  }

  applyTextValue(
    'name',
    resolveTextFieldInput(['商品名稱', '名稱']),
    draft.shopee.title,
    reporter
  );

  applyTextValue(
    'description',
    resolveTextFieldInput(['商品描述', '描述']),
    draft.shopee.description,
    reporter
  );

  if (draft.shopee.brand) {
    const ok = applyTextValue('brand', resolveTextFieldInput(['品牌']), draft.shopee.brand, reporter);
    if (!ok) {
      reporter.skip('brand', 'brand field not found');
    }
  } else {
    reporter.skip('brand', 'no brand in AI draft');
  }
}

async function fillCategoryPath(categoryPath: string[], reporter: FillReporter): Promise<boolean> {
  if (!categoryPath.length) {
    reporter.fail('categoryPath', 'empty category path');
    return false;
  }

  const categoryContainer = findFieldContainerByKeywords(['商品分類', '分類']);
  if (!categoryContainer) {
    reporter.fail('categoryPath', 'category field not found');
    return false;
  }

  const button = categoryContainer.querySelector<HTMLElement>('button, [role="button"]');
  if (button) {
    button.click();
  } else {
    categoryContainer.click();
  }

  await sleep(180);

  const openCategoryPanel = await clickByText(['編輯分類', '選擇分類', '新增分類']);
  if (openCategoryPanel) {
    await sleep(180);
  }

  for (const segment of categoryPath) {
    const selected = await selectDropdownOption(segment);
    if (selected) {
      continue;
    }

    const searchInput = document.querySelector<HTMLInputElement>(
      'input[placeholder*="搜尋"], input[placeholder*="Search"], input[placeholder*="分類"]'
    );

    if (searchInput) {
      setNativeValue(searchInput, segment);
      await sleep(200);
      if (await selectDropdownOption(segment)) {
        continue;
      }
    }

    reporter.fail('categoryPath', `category option not found: ${segment}`);
    return false;
  }

  await clickByText(['確認', '儲存', '完成']);
  reporter.success('categoryPath');
  return true;
}

function emitEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
}

function queryTierNameInputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[placeholder*="規格名稱" i], input[placeholder*="Variation" i], input[placeholder*="tier" i], input[aria-label*="規格" i]'
    )
  );
}

function queryOptionInputNear(anchor: HTMLElement | null): HTMLInputElement | null {
  if (!anchor) {
    return null;
  }

  const scope =
    anchor.closest<HTMLElement>('[class*="variation" i], [class*="spec" i], [class*="model" i]') ||
    anchor.parentElement ||
    anchor;

  return (
    scope.querySelector<HTMLInputElement>(
      'input[placeholder*="選項" i], input[placeholder*="option" i], input[placeholder*="輸入" i], input[aria-label*="選項" i]'
    ) || null
  );
}

async function maybeAddTierVariation(index: number): Promise<void> {
  if (index === 0) {
    return;
  }

  const clicked = await clickByText(['新增規格', '新增第一層規格', '新增第二層規格', 'Add variation']);
  if (clicked) {
    await sleep(200);
  }
}

async function fillTierVariations(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  const tiers = draft.shopee.tierVariationList;
  if (!tiers?.length) {
    reporter.skip('tierVariationList', 'no tier variations in AI draft');
    return;
  }

  await clickByText(['開啟商品規格', '新增規格', '啟用規格']);
  await sleep(180);

  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    await maybeAddTierVariation(i);

    const nameInputs = queryTierNameInputs();
    const nameInput = nameInputs[i] || nameInputs[nameInputs.length - 1] || null;

    if (!nameInput) {
      reporter.fail('tierVariationList', `tier name input missing for ${tier.name}`);
      continue;
    }

    setNativeValue(nameInput, tier.name);
    await sleep(120);

    const optionInput = queryOptionInputNear(nameInput);
    if (!optionInput) {
      reporter.fail('tierVariationList', `tier option input missing for ${tier.name}`);
      continue;
    }

    for (const option of tier.options) {
      setNativeValue(optionInput, option);
      emitEnter(optionInput);
      await sleep(80);
    }
  }

  reporter.success('tierVariationList');
}

function fillModelRow(row: HTMLElement, model: AiModel, reporter: FillReporter): boolean {
  let success = true;

  if (!fillPriceInputInRow(row, model.price)) {
    reporter.fail('modelList', 'price input not found for one model row');
    success = false;
  }

  if (model.sku && !fillSkuInputInRow(row, model.sku)) {
    reporter.warn(`sku input not found for model ${model.variationValues?.join('/') || '-'}`);
  }

  return success;
}

async function fillModels(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  const models = draft.shopee.modelList;
  if (!models?.length) {
    reporter.skip('modelList', 'no model list in AI draft');
    reporter.skip('stock', 'stock is always manual');
    return;
  }

  await sleep(250);

  let successCount = 0;
  for (const model of models) {
    const row = findModelRow(model);
    if (!row) {
      reporter.fail('modelList', `model row not found for ${model.variationValues?.join('/') || '-'}`);
      continue;
    }

    if (fillModelRow(row, model, reporter)) {
      successCount += 1;
    }
  }

  if (successCount > 0) {
    reporter.success('modelList');
  }

  reporter.skip('stock', 'stock is intentionally left blank for manual input');
}

async function uploadVariantImageForOption(
  option: string,
  imageUrl: string,
  reporter: FillReporter
): Promise<boolean> {
  const optionMatches = findElementsContainingText(option).filter((el) => {
    const normalized = normalizeText(el.textContent || '');
    return normalized.includes(normalizeText(option));
  });

  for (const match of optionMatches) {
    const block =
      match.closest<HTMLElement>('[class*="variation" i], [class*="spec" i], [class*="model" i], li, tr, div') ||
      match;
    const fileInput = block.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      continue;
    }

    await uploadImagesFromUrls(fileInput, [imageUrl], reporter, `variantImage:${option}`);
    return true;
  }

  return false;
}

async function bindVariantImages(
  fb: FBPostPayload,
  draft: AiProductDraftV2,
  reporter: FillReporter
): Promise<void> {
  if (!draft.variantImageBindings.length) {
    reporter.skip('variantImageBindings', 'no high-confidence binding');
  }

  let successCount = 0;

  for (const item of draft.variantImageBindings) {
    const imageUrl = fb.imageUrlsOrdered[item.imageSourceIndex];
    if (!imageUrl) {
      reporter.pending(`手動補規格圖：${item.tier1Option}（找不到來源圖片）`);
      continue;
    }

    const uploaded = await uploadVariantImageForOption(item.tier1Option, imageUrl, reporter);
    if (!uploaded) {
      reporter.pending(`手動補規格圖：${item.tier1Option}（頁面找不到規格圖上傳欄位）`);
      continue;
    }

    successCount += 1;
  }

  for (const pending of draft.pendingVariantImageBindings) {
    reporter.pending(`手動補規格圖：${pending.tier1Option}（${pending.reason}）`);
  }

  if (successCount > 0) {
    reporter.success('variantImageBindings');
  }
}

function fillDimensionValue(keyword: string, value: number, reporter: FillReporter): boolean {
  const container = findFieldContainerByKeywords([keyword]);
  const input = findInputInContainer(container);
  if (!input || !(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    reporter.warn(`dimension field not found: ${keyword}`);
    return false;
  }

  setNativeValue(input, String(value));
  return true;
}

async function fillShipping(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  const shipping = draft.shopee.shipping;
  if (!shipping) {
    reporter.skip('shipping', 'no shipping draft');
    return;
  }

  if (shipping.weight) {
    const container = findFieldContainerByKeywords(['重量']);
    const input = findInputInContainer(container);
    if (input && (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
      const value = shipping.weight.unit === 'KG' ? shipping.weight.value : shipping.weight.value / 1000;
      setNativeValue(input, String(value));
      reporter.success('shipping.weight');
    } else {
      reporter.fail('shipping.weight', 'weight field not found');
    }
  } else {
    reporter.skip('shipping.weight', 'missing shipping weight');
  }

  if (shipping.dimension) {
    const ok = [
      fillDimensionValue('長', shipping.dimension.length, reporter),
      fillDimensionValue('寬', shipping.dimension.width, reporter),
      fillDimensionValue('高', shipping.dimension.height, reporter)
    ].every(Boolean);

    if (ok) {
      reporter.success('shipping.dimension');
    } else {
      reporter.fail('shipping.dimension', 'one or more dimension fields missing');
    }
  } else {
    reporter.skip('shipping.dimension', 'no package dimension provided');
  }

  if (shipping.preOrderDaysToShip !== undefined) {
    const daysField = findFieldContainerByKeywords(['備貨天數', '出貨天數']);
    if (daysField) {
      daysField.click();
      await sleep(100);
      const selected = await selectDropdownOption(`${shipping.preOrderDaysToShip}`);
      if (selected) {
        reporter.success('shipping.preOrderDaysToShip');
      } else {
        reporter.fail('shipping.preOrderDaysToShip', 'days-to-ship option not found');
      }
    } else {
      reporter.fail('shipping.preOrderDaysToShip', 'days-to-ship field not found');
    }
  } else {
    reporter.skip('shipping.preOrderDaysToShip', 'no pre-order days value');
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

      const checkbox =
        target.closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"]') ||
        target.querySelector<HTMLInputElement>('input[type="checkbox"]');

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
      reporter.success('logisticsChannels');
    } else {
      reporter.fail('logisticsChannels', 'no logistics channel matched');
    }
  } else {
    reporter.skip('logisticsChannels', 'no logistics channels provided');
  }
}

async function applyDraft(payload: { fb: FBPostPayload; draft: AiProductDraftV2 }): Promise<FillReportV2> {
  if (!isNewProductPage()) {
    throw new Error('Current page is not Shopee new product page');
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

  reporter.skip('publish', 'publish action is intentionally disabled by design');

  lastFillReport = reporter.toJSON();
  return lastFillReport;
}

chrome.runtime.onMessage.addListener((message: AnyRuntimeRequest, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message.type === MSG.collect_shopee_schema) {
        if (!isNewProductPage()) {
          throw new Error('Please open Shopee new product page first');
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
        sendResponse({ ok: true, payload: lastFillReport ?? undefined });
        return;
      }
    } catch (error) {
      sendResponse({ ok: false, error: pickErrorMessage(error) });
    }
  })();

  return true;
});
