import type {
  AiProductDraftV2,
  AiModel,
  FBImageBase64,
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
  dispatchInputEvents,
  findElementsContainingText,
  findFieldContainerByKeywords,
  findInputInContainer,
  normalizeText,
  selectDropdownOption,
  setContentEditableText,
  setNativeValue,
  setNativeValueCharByChar,
  sleep,
  uploadImagesFromBase64,
  uploadImagesFromUrls,
  uploadSingleBase64,
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
  { key: 'images', section: 'basic', type: 'array', requiredByDefault: true, keywords: ['商品圖片', '圖片'] },
  { key: 'name', section: 'basic', type: 'string', requiredByDefault: true, keywords: ['商品名稱', '名稱'] },
  { key: 'description', section: 'basic', type: 'string', requiredByDefault: true, keywords: ['商品描述', '描述'] },
  { key: 'categoryPath', section: 'category', type: 'array', requiredByDefault: true, keywords: ['商品分類', '分類'] },
  { key: 'brand', section: 'basic', type: 'string', requiredByDefault: false, keywords: ['品牌'] },
  { key: 'tierVariationList', section: 'spec', type: 'array', requiredByDefault: false, keywords: ['商品規格', '規格'] },
  { key: 'modelList', section: 'sales', type: 'array', requiredByDefault: false, keywords: ['型號', '銷售資訊'] },
  { key: 'weight', section: 'shipping', type: 'number', requiredByDefault: false, keywords: ['重量'] },
  { key: 'dimension', section: 'shipping', type: 'object', requiredByDefault: false, keywords: ['包裹尺寸', '尺寸'] },
  { key: 'logisticsChannels', section: 'shipping', type: 'array', requiredByDefault: false, keywords: ['物流', '配送方式'] }
];

let lastFillReport: FillReportV2 | null = null;

// ---------------------------------------------------------------------------
// Page detection
// ---------------------------------------------------------------------------

function isNewProductPage(): boolean {
  return (
    window.location.hostname === 'seller.shopee.tw' &&
    window.location.pathname.startsWith(SHOPEE_NEW_PRODUCT_PATH)
  );
}

// ---------------------------------------------------------------------------
// Schema collection (unchanged logic)
// ---------------------------------------------------------------------------

function inferRequired(container: HTMLElement | null, fallback: boolean): boolean {
  if (!container) return fallback;
  const text = container.textContent || '';
  if (/\*/.test(text) || /必填/.test(text)) return true;
  if (/選填/.test(text)) return false;
  return fallback;
}

function collectFieldOptions(container: HTMLElement | null): string[] | undefined {
  if (!container) return undefined;
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
      key: probe.key, section: probe.section, type: probe.type, required: probe.requiredByDefault
    }));
  }
  return fields;
}

function extractNumber(content: string, pattern: RegExp): number | undefined {
  const match = content.match(pattern);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractRange(content: string, pattern: RegExp): [number, number] | undefined {
  const match = content.match(pattern);
  if (!match?.[1] || !match?.[2]) return undefined;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  return [min, max];
}

function normalizeWindowPath(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1').toLowerCase();
}

function maybeAssignConstraint(path: string, value: number, target: ShopeeConstraints): void {
  const key = normalizeWindowPath(path);
  const assign = (constraintKey: keyof ShopeeConstraints): void => {
    if (target[constraintKey] === undefined) target[constraintKey] = value;
  };
  if (key.includes('image') && key.includes('max')) { assign('imageNumMax'); return; }
  if (key.includes('image') && key.includes('min')) { assign('imageNumMin'); return; }
  if (key.includes('price') && key.includes('max')) { assign('priceMax'); return; }
  if (key.includes('price') && key.includes('min')) { assign('priceMin'); return; }
  if ((key.includes('stock') || key.includes('qty')) && key.includes('max')) { assign('stockMax'); return; }
  if ((key.includes('stock') || key.includes('qty')) && key.includes('min')) { assign('stockMin'); return; }
  if ((key.includes('dts') || key.includes('days_to_ship') || key.includes('preorder')) && key.includes('max')) { assign('dtsMax'); return; }
  if ((key.includes('dts') || key.includes('days_to_ship') || key.includes('preorder')) && key.includes('min')) { assign('dtsMin'); return; }
  if (key.includes('instock') && (key.includes('dts') || key.includes('days'))) { assign('inStockDts'); return; }
  if (key.includes('video') && key.includes('duration') && key.includes('max')) { assign('videoDurationMax'); return; }
  if (key.includes('video') && key.includes('duration') && key.includes('min')) { assign('videoDurationMin'); return; }
  if (key.includes('video') && (key.includes('size') || key.includes('filesize') || key.includes('file_size'))) { assign('videoSizeLimit'); }
}

function deepScanConstraints(
  value: unknown, target: ShopeeConstraints, path: string, visited: WeakSet<object>, count: { scanned: number }
): void {
  if (count.scanned >= MAX_DEEP_SCAN_NODES || value == null) return;
  if (typeof value === 'number' && Number.isFinite(value)) { maybeAssignConstraint(path, value, target); count.scanned += 1; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) { deepScanConstraints(value[i], target, `${path}[${i}]`, visited, count); } count.scanned += 1; return; }
  if (typeof value !== 'object') { count.scanned += 1; return; }
  const obj = value as Record<string, unknown>;
  if (visited.has(obj)) return;
  visited.add(obj);
  for (const [key, child] of Object.entries(obj)) { deepScanConstraints(child, target, path ? `${path}.${key}` : key, visited, count); }
  count.scanned += 1;
}

function collectConstraintsFromWindow(): ShopeeConstraints {
  const collected: ShopeeConstraints = {};
  const win = window as unknown as Record<string, unknown>;
  const candidates = [win.__INITIAL_STATE__, win.__PRELOADED_STATE__, win.__NEXT_DATA__, win.__NUXT__, win.__APP_STATE__];
  const visited = new WeakSet<object>();
  const count = { scanned: 0 };
  for (const item of candidates) { deepScanConstraints(item, collected, '', visited, count); }
  return collected;
}

function collectConstraintsFromText(): ShopeeConstraints {
  const text = (document.body?.textContent || '').replace(/\s+/g, ' ');
  const constraints: ShopeeConstraints = {};
  const imageRange = extractRange(text, /圖片[^\d]{0,20}(\d+)\D+(\d+)\s*張/i);
  if (imageRange) { constraints.imageNumMin = imageRange[0]; constraints.imageNumMax = imageRange[1]; }
  constraints.imageNumMax = constraints.imageNumMax ?? extractNumber(text, /最多[^\d]{0,20}(\d+)\s*張(?:商品)?圖片/i);
  constraints.imageNumMin = constraints.imageNumMin ?? extractNumber(text, /至少[^\d]{0,20}(\d+)\s*張(?:商品)?圖片/i);
  const priceRange = extractRange(text, /價格[^\d]{0,20}(\d+)\D+(\d+)/i);
  if (priceRange) { constraints.priceMin = priceRange[0]; constraints.priceMax = priceRange[1]; }
  const stockRange = extractRange(text, /庫存[^\d]{0,20}(\d+)\D+(\d+)/i);
  if (stockRange) { constraints.stockMin = stockRange[0]; constraints.stockMax = stockRange[1]; }
  const dtsRange = extractRange(text, /(?:備貨|出貨)[^\d]{0,20}(\d+)\D+(\d+)\s*天/i);
  if (dtsRange) { constraints.dtsMin = dtsRange[0]; constraints.dtsMax = dtsRange[1]; }
  constraints.inStockDts = extractNumber(text, /現貨[^\d]{0,20}(\d+)\s*天/i);
  const videoDuration = extractRange(text, /影片[^\d]{0,20}(\d+)\D+(\d+)\s*秒/i);
  if (videoDuration) { constraints.videoDurationMin = videoDuration[0]; constraints.videoDurationMax = videoDuration[1]; }
  const videoSizeMB = extractNumber(text, /影片[^\d]{0,20}(\d+)\s*(?:mb|m)/i);
  if (videoSizeMB !== undefined) { constraints.videoSizeLimit = videoSizeMB * 1024 * 1024; }
  return constraints;
}

function mergeConstraints(...parts: ShopeeConstraints[]): ShopeeConstraints {
  const out: ShopeeConstraints = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part) as Array<[keyof ShopeeConstraints, number | undefined]>) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

function collectSchemaSnapshot(): ShopeeSchemaSnapshot {
  return {
    version: 'v1',
    region: 'tw',
    capturedAtISO: nowIso(),
    fields: collectFieldsSnapshot(),
    constraints: mergeConstraints(DEFAULT_CONSTRAINTS, collectConstraintsFromWindow(), collectConstraintsFromText())
  };
}

// ---------------------------------------------------------------------------
// DOM helpers specific to Shopee seller center
// ---------------------------------------------------------------------------

/** Find the main product image upload input (the first .eds-upload__input with multiple). */
function findMainImageUploadInput(): HTMLInputElement | null {
  // The product images section has a dragger with input[type="file"][multiple]
  const allUploads = Array.from(
    document.querySelectorAll<HTMLInputElement>('.eds-upload__input, input[type="file"][accept*="image"]')
  );
  // First one that supports multiple is the main product image upload
  return allUploads.find((input) => input.hasAttribute('multiple')) ?? allUploads[0] ?? null;
}

/** Find the product name input. */
function findNameInput(): HTMLInputElement | null {
  // The product name input has a distinctive placeholder
  const byPlaceholder = document.querySelector<HTMLInputElement>(
    'input[placeholder*="品牌名稱"], input[placeholder*="商品類型"]'
  );
  if (byPlaceholder) return byPlaceholder;

  // Fallback: find by nearby label text "商品名稱"
  const container = findFieldContainerByKeywords(['商品名稱']);
  return container?.querySelector<HTMLInputElement>('input.eds-input__input, input[type="text"]') ?? null;
}

/** Find the Quill description editor. */
function findDescriptionEditor(): HTMLElement | null {
  // Shopee uses Quill — look for .ql-editor
  const editor = document.querySelector<HTMLElement>('.ql-editor[contenteditable="true"]');
  if (editor) return editor;

  // Fallback: any contenteditable with matching placeholder
  return document.querySelector<HTMLElement>(
    '[contenteditable="true"][data-placeholder*="商品描述"], [contenteditable="true"][data-placeholder*="描述"]'
  ) ?? null;
}

/** Wait for an element matching a selector to appear. */
async function waitForSelector(selector: string, timeoutMs = 3000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    await sleep(150);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image resolution — which images go to main vs variant
// ---------------------------------------------------------------------------

interface ResolvedImages {
  /** Images for the main product gallery (sourceIndex list). */
  mainImageIndices: number[];
  /** Map of tier1Option → sourceIndex for variant images. */
  variantImageMap: Map<string, number>;
}

function resolveImageAssignment(fb: FBPostPayload, draft: AiProductDraftV2): ResolvedImages {
  const variantImageMap = new Map<string, number>();
  const variantUsedIndices = new Set<number>();

  // Assign variant images from high-confidence bindings
  for (const binding of draft.variantImageBindings) {
    if (binding.imageSourceIndex < fb.imageUrlsOrdered.length) {
      variantImageMap.set(binding.tier1Option, binding.imageSourceIndex);
      variantUsedIndices.add(binding.imageSourceIndex);
    }
  }

  // Main images: AI-ordered images minus variant-assigned ones
  const mainImageIndices: number[] = [];
  for (const item of draft.shopee.images) {
    if (!variantUsedIndices.has(item.sourceIndex) && item.sourceIndex < fb.imageUrlsOrdered.length) {
      if (!mainImageIndices.includes(item.sourceIndex)) {
        mainImageIndices.push(item.sourceIndex);
      }
    }
  }

  // If AI didn't produce any main images, use all non-variant images in order
  if (!mainImageIndices.length) {
    for (let i = 0; i < fb.imageUrlsOrdered.length; i += 1) {
      if (!variantUsedIndices.has(i)) {
        mainImageIndices.push(i);
      }
    }
  }

  return { mainImageIndices, variantImageMap };
}

// ---------------------------------------------------------------------------
// Fill: Basic info (images, name, description)
// ---------------------------------------------------------------------------

async function fillBasicInfo(
  fb: FBPostPayload,
  draft: AiProductDraftV2,
  imageAssignment: ResolvedImages,
  reporter: FillReporter
): Promise<void> {
  // --- Main product images ---
  const imageInput = findMainImageUploadInput();
  if (imageInput) {
    const mainBase64: FBImageBase64[] = [];
    for (const idx of imageAssignment.mainImageIndices) {
      const item = fb.imageBase64List?.find((b) => b.sourceIndex === idx);
      if (item) mainBase64.push(item);
    }

    if (mainBase64.length > 0) {
      await uploadImagesFromBase64(imageInput, mainBase64, reporter, 'images');
    } else {
      // Fallback to URL fetch (may fail due to CORS)
      const urls = imageAssignment.mainImageIndices.map((i) => fb.imageUrlsOrdered[i]).filter(Boolean);
      await uploadImagesFromUrls(imageInput, urls, reporter, 'images');
    }
  } else {
    reporter.fail('images', 'main image upload input not found');
  }

  // --- Product name ---
  const nameInput = findNameInput();
  if (nameInput) {
    setNativeValue(nameInput, draft.shopee.title);
    reporter.success('name');
  } else {
    reporter.fail('name', 'product name input not found');
  }

  // --- Description (Quill editor) ---
  const descEditor = findDescriptionEditor();
  if (descEditor) {
    descEditor.focus();
    // Clear existing content
    descEditor.innerHTML = '';
    // Set text content — Quill will pick up the change
    descEditor.textContent = draft.shopee.description;
    dispatchInputEvents(descEditor);
    // Also try dispatching Quill-compatible events
    descEditor.dispatchEvent(new Event('input', { bubbles: true }));
    reporter.success('description');
  } else {
    // Fallback: try textarea or plain contenteditable
    const fallback = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="描述"]') ??
      document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (fallback) {
      if (fallback instanceof HTMLTextAreaElement) {
        setNativeValue(fallback, draft.shopee.description);
      } else {
        setContentEditableText(fallback, draft.shopee.description);
      }
      reporter.success('description');
    } else {
      reporter.fail('description', 'description editor not found');
    }
  }
}

// ---------------------------------------------------------------------------
// Fill: Category (cascading 3-column selector in modal)
// ---------------------------------------------------------------------------

/**
 * Force-close the category modal — always call this at the end of fillCategoryPath.
 *
 * IMPORTANT: The confirm button is in `.eds-modal__footer-buttons`, which is a SIBLING
 * of `.product-category-selector-modal`, NOT a child. So we must search the parent
 * `.eds-modal` container or use document-level selectors.
 */
async function closeCategoryModal(): Promise<void> {
  const modal = document.querySelector<HTMLElement>('.product-category-selector-modal');
  if (!modal) return;

  // NOTE: .eds-modal and .product-category-selector-modal are the SAME element (both classes
  // on one div). The confirm/cancel buttons are INSIDE this element at:
  //   .product-category-selector-modal .eds-modal__footer-buttons .eds-button--primary
  // DO NOT use document.querySelector('.eds-modal__footer-buttons') — that can match other
  // hidden modals' footers (e.g. the "儲存" confirmation modal) instead of the category modal.

  // Check if modal is visible (position:fixed elements may have null offsetParent)
  const isVisible = modal.offsetParent !== null ||
    getComputedStyle(modal).display !== 'none';
  if (!isVisible) return;

  console.log('[fb2shopee] force-closing category modal');

  // Strategy 1: Click confirm button INSIDE the category modal
  const confirmBtn = modal.querySelector<HTMLElement>('.eds-modal__footer-buttons .eds-button--primary');
  if (confirmBtn) {
    console.log('[fb2shopee] clicking confirm inside category modal');
    confirmBtn.click();
    await sleep(800);
    if (!document.querySelector('.product-category-selector-modal')) return; // Modal removed from DOM
  }

  // Strategy 2: Click cancel button INSIDE the category modal
  const cancelBtn = modal.querySelector<HTMLElement>('.eds-modal__footer-buttons .eds-button--normal');
  if (cancelBtn) {
    console.log('[fb2shopee] clicking cancel inside category modal');
    cancelBtn.click();
    await sleep(600);
    if (!document.querySelector('.product-category-selector-modal')) return;
  }

  // Strategy 3: Click the X close button (top-right)
  const closeIcon = modal.querySelector<HTMLElement>('.eds-modal__close');
  if (closeIcon) {
    closeIcon.click();
    await sleep(500);
    if (!document.querySelector('.product-category-selector-modal')) return;
  }

  // Strategy 4: Press Escape
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
}

async function fillCategoryPath(categoryPath: string[], reporter: FillReporter): Promise<boolean> {
  if (!categoryPath.length) {
    reporter.fail('categoryPath', 'empty category path');
    return false;
  }

  // Click the "請選擇商品分類" box to open category modal
  // Primary: the exact trigger element observed in the DOM
  const directTrigger = document.querySelector<HTMLElement>('.product-category-box');
  if (directTrigger) {
    console.log('[fb2shopee] clicking .product-category-box');
    directTrigger.click();
  } else {
    // Fallback: look for the category field area
    const categoryContainer = findFieldContainerByKeywords(['商品分類', '分類']);
    const triggerButton = categoryContainer?.querySelector<HTMLElement>('button, [role="button"], a, div');
    if (triggerButton) {
      triggerButton.click();
    } else if (categoryContainer) {
      categoryContainer.click();
    } else {
      await clickByText(['請選擇商品分類', '編輯分類']);
    }
  }

  await sleep(500);

  // Wait for the category modal to become visible (it's always in DOM but may be hidden)
  const modal = await waitForSelector('.product-category-selector-modal .category-wrap, .category-wrap', 3000);
  if (!modal) {
    // Try alternate approach: click "編輯分類" text
    await clickByText(['編輯分類', '選擇分類']);
    await sleep(500);
  }

  // Scope category items to within the modal to avoid matching sidebar items
  const modalRoot = document.querySelector<HTMLElement>('.product-category-selector-modal') ?? document;

  let allSegmentsMatched = true;

  // Now navigate the cascading category columns
  for (let i = 0; i < categoryPath.length; i += 1) {
    const segment = categoryPath[i];
    await sleep(300);

    // Find category items scoped within the modal
    const categoryItems = Array.from(
      modalRoot.querySelectorAll<HTMLElement>('.category-item')
    );

    const normalizedSegment = normalizeText(segment);
    // Prefer exact match, then partial match, to avoid picking wrong level
    const exactMatch = categoryItems.find((item) => {
      const p = item.querySelector('p');
      const itemText = normalizeText(p?.textContent || item.textContent || '');
      return itemText === normalizedSegment;
    });
    const partialMatch = !exactMatch
      ? categoryItems.find((item) => {
          const p = item.querySelector('p');
          const itemText = normalizeText(p?.textContent || item.textContent || '');
          return itemText.includes(normalizedSegment);
        })
      : null;
    // Also try: the segment is contained in item text (reverse partial match)
    const reverseMatch = (!exactMatch && !partialMatch)
      ? categoryItems.find((item) => {
          const p = item.querySelector('p');
          const itemText = normalizeText(p?.textContent || item.textContent || '');
          return normalizedSegment.includes(itemText) && itemText.length > 1;
        })
      : null;
    const match = exactMatch ?? partialMatch ?? reverseMatch;

    if (match) {
      console.log(`[fb2shopee] category step ${i}: clicking "${segment}"`);
      match.click();
      await sleep(400);
      continue;
    }

    // Try search — the category modal has a search input
    const searchInput = modalRoot.querySelector<HTMLInputElement>(
      'input[placeholder*="請輸入至少"], input[placeholder*="搜尋"]'
    );

    if (searchInput) {
      console.log(`[fb2shopee] category step ${i}: searching for "${segment}"`);
      setNativeValue(searchInput, segment);
      await sleep(600);

      // After search, try to find and click the result
      const searchResults = Array.from(
        modalRoot.querySelectorAll<HTMLElement>('.category-item, [class*="search-result"]')
      );

      const searchMatch = searchResults.find((item) => {
        const text = normalizeText(item.textContent || '');
        return text.includes(normalizedSegment) || normalizedSegment.includes(normalizeText(item.querySelector('p')?.textContent || ''));
      });

      if (searchMatch) {
        searchMatch.click();
        await sleep(400);
        // Clear search for next level
        setNativeValue(searchInput, '');
        await sleep(300);
        continue;
      }

      // Clear the search so it doesn't interfere with confirm
      setNativeValue(searchInput, '');
      await sleep(200);
    }

    // Try generic dropdown option approach
    const optionSelected = await selectDropdownOption(segment);
    if (optionSelected) continue;

    reporter.warn(`category segment not found: ${segment} (step ${i + 1}/${categoryPath.length})`);
    allSegmentsMatched = false;
    // Don't return early — still try to confirm what we have so far
    break;
  }

  // ALWAYS close the modal — this is critical to avoid blocking the rest of the form
  await sleep(200);
  await closeCategoryModal();
  await sleep(1500); // Wait for form to update with new category fields (Shopee loads sales/shipping via AJAX)

  if (allSegmentsMatched) {
    reporter.success('categoryPath');
    return true;
  }

  // Even if not all segments matched, the partial selection may have been confirmed.
  // Check if the category box now shows a selected category.
  const categoryBox = document.querySelector<HTMLElement>('.product-category-box');
  const selectedText = categoryBox?.textContent?.trim() || '';
  if (selectedText && !selectedText.includes('請選擇')) {
    console.log(`[fb2shopee] partial category selected: "${selectedText}"`);
    reporter.warn(`category partially matched: ${selectedText}`);
    // Partial category is better than none — continue with form filling
    return true;
  }

  reporter.fail('categoryPath', `category not fully matched`);
  return false;
}

// ---------------------------------------------------------------------------
// Fill: Attributes (品牌, 產地, 材質, etc.)
// ---------------------------------------------------------------------------

async function fillAttributes(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  const attributes = draft.shopee.attributes;
  const brand = draft.shopee.brand;

  // Collect all attribute values to fill
  const attrMap = new Map<string, string | string[]>();
  if (brand) attrMap.set('品牌', brand);
  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      attrMap.set(key, value);
    }
  }

  if (attrMap.size === 0) {
    reporter.skip('attributes', 'no attributes in AI draft');
    return;
  }

  let filled = 0;

  for (const [attrName, attrValue] of attrMap) {
    const value = Array.isArray(attrValue) ? attrValue[0] : attrValue;
    if (!value) continue;

    console.log(`[fb2shopee] filling attribute "${attrName}" = "${value}"`);

    // Strategy 1: Find a labeled field container for this attribute
    const container = findFieldContainerByKeywords([attrName]);
    if (!container) {
      reporter.warn(`attribute field not found: ${attrName}`);
      continue;
    }

    // Check if it's a dropdown (eds-select) or text input
    const selectTrigger = container.querySelector<HTMLElement>(
      '.eds-select, [class*="eds-select"], [class*="select-trigger"], [role="combobox"]'
    );

    if (selectTrigger) {
      // Dropdown: click to open, then select the matching option
      selectTrigger.click();
      await sleep(300);

      // Look for dropdown options in the whole document (they might be in a portal/overlay)
      const options = Array.from(document.querySelectorAll<HTMLElement>(
        '.eds-select-option, [class*="eds-select-option"], [role="option"], ' +
        '.eds-dropdown-item, [class*="dropdown-item"]'
      ));

      const normalizedValue = normalizeText(value);
      const match = options.find((opt) => {
        const optText = normalizeText(opt.textContent || '');
        return optText === normalizedValue || optText.includes(normalizedValue);
      });

      if (match) {
        match.click();
        await sleep(200);
        filled++;
      } else {
        // Try typing into the select's search input
        const searchInput = document.querySelector<HTMLInputElement>(
          '.eds-select input, [class*="eds-select"] input, .eds-popover input'
        );
        if (searchInput) {
          setNativeValue(searchInput, value);
          await sleep(400);
          // Click the first visible option
          const filteredOptions = Array.from(document.querySelectorAll<HTMLElement>(
            '.eds-select-option, [role="option"]'
          )).filter(o => o.offsetParent !== null);
          if (filteredOptions.length > 0) {
            filteredOptions[0].click();
            await sleep(200);
            filled++;
          } else {
            reporter.warn(`attribute option not found for "${attrName}": "${value}"`);
            // Close dropdown by pressing Escape
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(100);
          }
        } else {
          reporter.warn(`attribute option not found for "${attrName}": "${value}"`);
          // Close dropdown
          document.body.click();
          await sleep(100);
        }
      }
    } else {
      // Text input
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
    reporter.success('attributes');
  } else {
    reporter.fail('attributes', 'could not fill any attributes');
  }
}

// ---------------------------------------------------------------------------
// Fill: Tier variations (規格)
// ---------------------------------------------------------------------------

function emitEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
}

/** Find tier name inputs — Shopee uses placeholder "輸入選項，例如: 顏色" for tier 1 name. */
function findTierNameInputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[placeholder*="例如: 顏色"], input[placeholder*="例如: 尺寸"], ' +
      'input[placeholder*="規格名稱"], input[placeholder*="Variation"]'
    )
  );
}

/**
 * Find the empty option input in a tier section.
 * After filling the tier name (e.g. "顏色"), option inputs have placeholder="輸入".
 * Before filling, they have placeholder like "例如: 紅色".
 * We look for any visible text input with a short placeholder that is currently empty.
 */
function findOptionInputInTierSection(
  tierSection: HTMLElement,
  currentTierNameInput?: HTMLInputElement
): HTMLInputElement | null {
  // IMPORTANT: Do not pick the tier name input itself (placeholder usually "...例如: 顏色/尺寸").
  const tierNameInputs = new Set(
    Array.from(tierSection.querySelectorAll<HTMLInputElement>(
      'input[placeholder*="例如: 顏色"], input[placeholder*="例如: 尺寸"], input[placeholder*="規格名稱"]'
    ))
  );
  if (currentTierNameInput) {
    tierNameInputs.add(currentTierNameInput);
  }

  const root = tierSection.querySelector<HTMLElement>('.variation-option-panel')
    ?? currentTierNameInput?.closest<HTMLElement>('.variation-edit-item-content')?.querySelector<HTMLElement>('.variation-option-panel')
    ?? tierSection;

  const pickVisibleInputs = (selector: string): HTMLInputElement[] =>
    Array.from(root.querySelectorAll<HTMLInputElement>(selector)).filter((inp) => {
      if (inp.type === 'file' || inp.disabled || inp.readOnly) return false;
      if (inp.offsetParent === null) return false;
      if (tierNameInputs.has(inp)) return false;
      return true;
    });

  // Priority 1 (most reliable for Shopee current DOM):
  // the "next to fill" row appears as options-item/virtual-options-item with placeholder="輸入".
  const strictOptionInputs = [
    ...pickVisibleInputs('.option-container .options-item.virtual-options-item input[placeholder="輸入"]'),
    ...pickVisibleInputs('.option-container .options-item input[placeholder="輸入"]'),
    ...pickVisibleInputs('.options-item.virtual-options-item input[placeholder="輸入"]'),
    ...pickVisibleInputs('.options-item input[placeholder="輸入"]')
  ];
  if (strictOptionInputs.length > 0) {
    const empty = strictOptionInputs.filter((inp) => !inp.value.trim());
    return empty[empty.length - 1] ?? strictOptionInputs[strictOptionInputs.length - 1] ?? null;
  }

  const visibleInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input'))
    .filter((inp) => {
      if (inp.type === 'file' || inp.disabled || inp.readOnly) return false;
      if (inp.offsetParent === null) return false;
      if (tierNameInputs.has(inp)) return false;
      return true;
    });

  // Priority 2: option-style placeholders (before option chips are created).
  const optionPlaceholderInputs = visibleInputs.filter((inp) => {
    const placeholder = (inp.placeholder || '').trim();
    if (!placeholder) return false;
    if (!/輸入選項|例如:/i.test(placeholder)) return false;
    if (/顏色|尺寸|variation/i.test(placeholder)) return false;
    return true;
  });
  if (optionPlaceholderInputs.length > 0) {
    const empty = optionPlaceholderInputs.filter((inp) => !inp.value.trim());
    return empty[empty.length - 1] ?? optionPlaceholderInputs[optionPlaceholderInputs.length - 1] ?? null;
  }

  // Priority 3: generic placeholder fallback.
  const genericOptionInputs = visibleInputs.filter((inp) => {
    const placeholder = (inp.placeholder || '').trim();
    return placeholder === '輸入' || /option/i.test(placeholder);
  });
  if (genericOptionInputs.length > 0) {
    const empty = genericOptionInputs.filter((inp) => !inp.value.trim());
    return empty[empty.length - 1] ?? genericOptionInputs[genericOptionInputs.length - 1] ?? null;
  }

  // Last resort: any empty visible text input within the tier section.
  const emptyInput = visibleInputs.filter((inp) => !inp.value.trim());
  const localFallback = emptyInput[emptyInput.length - 1] ?? visibleInputs[visibleInputs.length - 1] ?? null;
  if (localFallback) return localFallback;

  // Final fallback: query from the whole tier edit item.
  const globalRoot = currentTierNameInput?.closest<HTMLElement>('.variation-edit-item-content') ?? document;
  const globalInputs = Array.from(
    globalRoot.querySelectorAll<HTMLInputElement>(
      '.variation-option-panel .options-item input[placeholder="輸入"], .variation-option-panel input[placeholder="輸入"]'
    )
  ).filter((inp) => {
    if (inp.type === 'file' || inp.disabled || inp.readOnly) return false;
    if (inp.offsetParent === null) return false;
    return !tierNameInputs.has(inp);
  });
  if (globalInputs.length > 0) {
    const emptyGlobal = globalInputs.filter((inp) => !inp.value.trim());
    return emptyGlobal[emptyGlobal.length - 1] ?? globalInputs[globalInputs.length - 1] ?? null;
  }

  return null;
}

function resolveTierSectionFromNameInput(nameInput: HTMLInputElement): HTMLElement {
  // Must cover both "規格名稱" panel and "選項" panel in the same tier.
  const editItem = nameInput.closest<HTMLElement>('.variation-edit-item-content');
  if (editItem) return editItem;

  const itemAlt = nameInput.closest<HTMLElement>('.variation-edit-item');
  if (itemAlt) return itemAlt;

  const namePanel = nameInput.closest<HTMLElement>('.variation-name-panel');
  if (namePanel?.parentElement instanceof HTMLElement) return namePanel.parentElement;

  const formItem = nameInput.closest<HTMLElement>('.product-edit-form-item');
  if (formItem) return formItem;

  return nameInput.parentElement ?? nameInput;
}

function countVisibleOptionRows(tierSection: HTMLElement): number {
  const root = tierSection.querySelector<HTMLElement>('.variation-option-panel') ?? tierSection;
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>('.option-container .options-item, .options-item')
  ).filter((row) => row.offsetParent !== null);
  return rows.length;
}

async function waitForNextOptionSlot(
  tierSection: HTMLElement,
  previousInput: HTMLInputElement,
  previousRowCount: number,
  currentTierNameInput?: HTMLInputElement,
  timeoutMs = 3500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rowCount = countVisibleOptionRows(tierSection);
    if (rowCount > previousRowCount) return true;

    const nextInput = findOptionInputInTierSection(tierSection, currentTierNameInput);
    if (nextInput && nextInput !== previousInput) return true;

    // Some Shopee builds reuse the same input element and only clear its value.
    if (previousInput.value.trim() === '') return true;

    await sleep(120);
  }
  return false;
}

function isVisibleElement(el: HTMLElement): boolean {
  if (el.offsetParent === null) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function textMatchesSpecOpenButton(el: HTMLElement): boolean {
  const t = normalizeText(el.textContent || '');
  return t.includes(normalizeText('開啟商品規格'))
    || t.includes(normalizeText('新增規格'))
    || t.includes(normalizeText('啟用規格'));
}

function clickSpecButton(button: HTMLElement): boolean {
  try {
    button.scrollIntoView({ block: 'center', inline: 'center' });
  } catch {
    // ignore
  }
  button.click();
  return true;
}

async function openVariationSection(): Promise<boolean> {
  if (findTierNameInputs().length > 0) return true;

  for (let attempt = 1; attempt <= 7; attempt++) {
    // Strategy 1: exact Shopee spec-open button selector from sales section.
    const directButtons = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.variation-add-button button, .variation-add-button .eds-button, button.primary-dash-button'
      )
    ).filter((btn) => isVisibleElement(btn) && textMatchesSpecOpenButton(btn));
    for (const btn of directButtons) {
      if (clickSpecButton(btn)) {
        await sleep(300);
        if (findTierNameInputs().length > 0) return true;
      }
    }

    // Strategy 2: find "規格" row, then click button within that row.
    const labels = findElementsContainingText('規格')
      .filter((el) => isVisibleElement(el))
      .slice(0, 20);
    for (const label of labels) {
      const row = label.closest<HTMLElement>('.edit-row, [class*="edit-row"], [class*="variation"]');
      if (!row) continue;
      const rowButtons = Array.from(row.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .filter((btn) => isVisibleElement(btn) && textMatchesSpecOpenButton(btn));
      for (const btn of rowButtons) {
        if (clickSpecButton(btn)) {
          await sleep(300);
          if (findTierNameInputs().length > 0) return true;
        }
      }
    }

    // Strategy 3: scoped text click inside sales section.
    const salesSection = findFieldContainerByKeywords(['銷售資訊']) ?? document;
    const openedInSales = await clickByText(['開啟商品規格', '新增規格', '啟用規格'], salesSection);
    if (openedInSales) {
      await sleep(300);
      if (findTierNameInputs().length > 0) return true;
    }

    // Strategy 4: global text click fallback.
    const openedGlobal = await clickByText(['開啟商品規格', '新增規格', '啟用規格']);
    if (openedGlobal) {
      await sleep(300);
      if (findTierNameInputs().length > 0) return true;
    }

    if (attempt < 7) {
      await sleep(attempt <= 2 ? 250 : 450);
    }
  }

  return findTierNameInputs().length > 0;
}

async function fillTierVariations(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  const tiers = draft.shopee.tierVariationList;
  if (!tiers?.length) {
    reporter.skip('tierVariationList', 'no tier variations in AI draft');
    return;
  }

  // Click "開啟商品規格" button in sales section.
  const opened = await openVariationSection();
  if (!opened) {
    // Maybe it's already open — check if tier name inputs exist
    const existing = findTierNameInputs();
    if (!existing.length) {
      reporter.fail('tierVariationList', 'cannot open variation section');
      return;
    }
  }

  // Wait for the spec section to render with retries — Vue needs time after button click
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
    reporter.fail('tierVariationList', 'tier name inputs never appeared after opening spec section');
    return;
  }

  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    console.log(`[fb2shopee] Filling tier ${i + 1}: "${tier.name}" with ${tier.options.length} options`);

    // For tier 2+, click "新增規格" button
    if (i > 0) {
      const addClicked = await clickByText([`新增規格`, 'Add variation']);
      if (addClicked) await sleep(400);
    }

    // Find the tier name input (with retry for slow Vue rendering)
    let nameInput: HTMLInputElement | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const nameInputs = findTierNameInputs();
      nameInput = nameInputs[i] ?? nameInputs[nameInputs.length - 1] ?? null;
      if (nameInput) break;
      await sleep(400);
    }
    if (!nameInput) {
      reporter.fail('tierVariationList', `tier ${i + 1} name input not found`);
      continue;
    }

    // Fill tier name using char-by-char (Vue reactivity)
    nameInput.focus();
    setNativeValueCharByChar(nameInput, tier.name);
    await sleep(300);

    // The tier section must contain BOTH the tier name input AND the option inputs.
    // Shopee DOM: .variation-edit-item-content > (.variation-selector-group (name) + .variation-selector-group (options))
    // The [class*="variation"] in .closest() used to match the name input's own wrapper (too narrow).
    const tierSection = resolveTierSectionFromNameInput(nameInput);
    console.log(`[fb2shopee] tierSection for "${tier.name}": ${tierSection.tagName}.${tierSection.className?.split(' ')[0] ?? ''}`);

    // Fill each option (e.g., "紅色", "藍色") — must re-find the empty input each time
    for (const option of tier.options) {
      // Re-find the empty option input each time since a new empty one appears after each entry
      const optionInput = findOptionInputInTierSection(tierSection, nameInput);
      if (!optionInput) {
        console.warn(`[fb2shopee] option input not found for "${option}" in tier "${tier.name}"`);
        reporter.warn(`option input not found for tier "${tier.name}" option "${option}"`);
        continue;
      }

      const beforeRowCount = countVisibleOptionRows(tierSection);
      optionInput.focus();
      setNativeValueCharByChar(optionInput, option);
      await sleep(80);
      emitEnter(optionInput);
      optionInput.dispatchEvent(new Event('blur', { bubbles: true }));

      // Wait until Shopee accepts this option and exposes the next slot.
      const advanced = await waitForNextOptionSlot(tierSection, optionInput, beforeRowCount, nameInput);
      if (!advanced) {
        reporter.warn(`option "${option}" may not be committed yet for tier "${tier.name}"`);
        await sleep(250);
      }
    }

    await sleep(300);
  }

  await sleep(800); // Wait for the spec table to fully render
  reporter.success('tierVariationList');
}

// ---------------------------------------------------------------------------
// Fill: Models (price, SKU in the spec table)
// ---------------------------------------------------------------------------

async function fillStandalonePrice(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  // When there are no tier variations, there's a standalone 價格 and 商品數量 field
  const models = draft.shopee.modelList;
  const price = models?.[0]?.price;

  // Fill the standalone price field (NT$ input)
  // Look for the price input specifically in the 銷售資訊 section (not the batch row)
  const priceContainer = findFieldContainerByKeywords(['價格']);
  const priceInput = priceContainer?.querySelector<HTMLInputElement>(
    '.price-input input, input.eds-input__input, input[type="text"], input[type="number"]'
  );
  if (priceInput && price !== undefined && price > 0) {
    console.log(`[fb2shopee] filling standalone price: ${price}`);
    setNativeValueCharByChar(priceInput, String(price));
    reporter.success('price');
  } else if (!price) {
    reporter.skip('price', 'no price in AI draft');
  } else {
    reporter.fail('price', 'standalone price input not found');
  }

  // Fill the stock field — default to 99 if not set
  const stockContainer = findFieldContainerByKeywords(['商品數量']);
  const stockInput = stockContainer?.querySelector<HTMLInputElement>(
    'input.eds-input__input, input[type="text"], input[type="number"]'
  );
  if (stockInput) {
    const currentVal = stockInput.value?.trim();
    if (!currentVal || currentVal === '0') {
      console.log('[fb2shopee] filling stock: 99');
      setNativeValueCharByChar(stockInput, '99');
      reporter.success('stock');
    } else {
      reporter.skip('stock', 'stock already has value');
    }
  } else {
    reporter.skip('stock', 'stock input not found (may be inside spec table)');
  }
}

/**
 * Shopee's spec table is NOT an HTML <table> — it's built with divs:
 *
 * .variation-model-table-container
 *   .variation-model-table-main
 *     .variation-model-table-fixed-left   (variant names column)
 *       .variation-model-table-header     (tier column header, e.g. "顏色")
 *       .variation-model-table-body       (variant rows)
 *         .table-cell-wrapper             (紅色 + image upload)
 *         .table-cell-wrapper             (藍色 + image upload)
 *     .middle-scroll-container            (price/stock/SKU columns)
 *
 * The batch apply row (.batch-edit-row) is ABOVE the table and has:
 *   .price-input input[placeholder="價格"]
 *   input[placeholder="商品數量"]
 *   input[placeholder="商品選項貨號"]
 *   .batch-apply-button (全部套用)
 *
 * Per-variant inputs inside the table:
 *   .price-input input   → price (has NT$ prefix)
 *   next input           → stock (value defaults to "0")
 *   next input           → SKU
 */

interface VariantRowInputs {
  price: HTMLInputElement | null;
  stock: HTMLInputElement | null;
  sku: HTMLInputElement | null;
}

function findVariantRowInputs(): VariantRowInputs[] {
  const table = document.querySelector<HTMLElement>('.variation-model-table');
  if (!table) return [];

  // Collect all non-file data inputs inside the table (excluding batch row)
  const batchRow = document.querySelector<HTMLElement>('.batch-edit-row');
  const batchInputSet = new Set(
    batchRow ? Array.from(batchRow.querySelectorAll<HTMLInputElement>('input')) : []
  );

  const allInputs = Array.from(table.querySelectorAll<HTMLInputElement>('input'))
    .filter((inp) => !batchInputSet.has(inp) && inp.type !== 'file');

  // Group inputs into variant rows: each variant has [price, stock, sku, (GTIN)]
  // Price inputs are identifiable by having a parent with class "price-input"
  const variants: VariantRowInputs[] = [];
  let current: VariantRowInputs | null = null;

  for (const inp of allInputs) {
    const isPrice = !!inp.closest('.price-input');

    if (isPrice) {
      // Start a new variant row
      current = { price: inp, stock: null, sku: null };
      variants.push(current);
    } else if (current) {
      // Non-price input following a price input
      if (!current.stock) {
        current.stock = inp;
      } else if (!current.sku) {
        current.sku = inp;
      }
      // Subsequent inputs (GTIN etc.) are ignored
    }
  }

  return variants;
}

async function fillModels(draft: AiProductDraftV2, reporter: FillReporter): Promise<void> {
  const models = draft.shopee.modelList;
  if (!models?.length) {
    // No variations — fill standalone price/stock instead
    reporter.skip('modelList', 'no model list in AI draft');
    await fillStandalonePrice(draft, reporter);
    return;
  }

  await sleep(500); // Ensure spec table is rendered

  // Strategy 1: If all models have the same price, use batch apply (most reliable)
  const allSamePrice = models.every((m) => m.price === models[0].price);
  const batchRow = document.querySelector<HTMLElement>('.batch-edit-row');

  if (allSamePrice && batchRow) {
    console.log(`[fb2shopee] Using batch apply: price=${models[0].price}, stock=99`);
    const batchPriceInput = batchRow.querySelector<HTMLInputElement>('.price-input input');
    const batchStockInput = Array.from(batchRow.querySelectorAll<HTMLInputElement>('input'))
      .find((inp) => inp.placeholder === '商品數量');

    if (batchPriceInput) {
      setNativeValueCharByChar(batchPriceInput, String(models[0].price));
      await sleep(150);
    }
    if (batchStockInput) {
      setNativeValueCharByChar(batchStockInput, '99');
      await sleep(150);
    }

    // Click "全部套用" button
    const applyBtn = batchRow.querySelector<HTMLElement>('.batch-apply-button');
    if (applyBtn) {
      await sleep(200);
      applyBtn.click();
      await sleep(500);
      console.log('[fb2shopee] Batch apply clicked');
      reporter.success('modelList');
      reporter.success('stock');
      return;
    }
  }

  // Strategy 2: Fill individual variant rows
  const variantRows = findVariantRowInputs();
  console.log(`[fb2shopee] Found ${variantRows.length} variant rows for ${models.length} models`);

  if (!variantRows.length) {
    // Fallback: try the batch row even for different prices (set first model's price)
    if (batchRow && models[0]?.price) {
      const batchPriceInput = batchRow.querySelector<HTMLInputElement>('.price-input input');
      const batchStockInput = Array.from(batchRow.querySelectorAll<HTMLInputElement>('input'))
        .find((inp) => inp.placeholder === '商品數量');

      if (batchPriceInput) {
        setNativeValueCharByChar(batchPriceInput, String(models[0].price));
        await sleep(150);
      }
      if (batchStockInput) {
        setNativeValueCharByChar(batchStockInput, '99');
        await sleep(150);
      }

      const applyBtn = batchRow.querySelector<HTMLElement>('.batch-apply-button');
      if (applyBtn) {
        await sleep(200);
        applyBtn.click();
        await sleep(500);
        reporter.success('modelList');
        reporter.success('stock');
        return;
      }
    }

    reporter.fail('modelList', 'no variant rows found in spec table');
    return;
  }

  // Match models to variant rows by index (they should correspond 1:1)
  let successCount = 0;
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const row = variantRows[i];
    if (!row) {
      reporter.warn(`variant row ${i} not found for model: ${model.variationValues?.join('/') || '-'}`);
      continue;
    }

    // Fill price
    if (row.price && model.price > 0) {
      setNativeValueCharByChar(row.price, String(model.price));
      await sleep(100);
      successCount += 1;
    }

    // Fill stock — default to 99
    const stockVal = (model.stock !== null && model.stock !== undefined) ? model.stock : 99;
    if (row.stock) {
      setNativeValueCharByChar(row.stock, String(stockVal));
      await sleep(100);
    }

    // Fill SKU if available
    if (row.sku && model.sku) {
      setNativeValueCharByChar(row.sku, model.sku);
      await sleep(100);
    }
  }

  if (successCount > 0) {
    reporter.success('modelList');
    reporter.success('stock');
  } else {
    reporter.fail('modelList', 'no model prices were set');
  }
}

// ---------------------------------------------------------------------------
// Fill: Variant images (per-option image in the spec section)
// ---------------------------------------------------------------------------

async function waitForVariantTable(maxAttempts = 6, delayMs = 800): Promise<HTMLElement | null> {
  const selectors = [
    '.variation-model-table-fixed-left .variation-model-table-body',
    '.variation-model-table .variation-model-table-body',
    '.variation-model-table-container .table-cell-wrapper'
  ];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const selector of selectors) {
      const el = document.querySelector<HTMLElement>(selector);
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

function findCellFileInput(cell: HTMLElement): HTMLInputElement | null {
  const inModal = (el: Element | null): boolean =>
    !!el?.closest('.eds-modal, .image-cropper-modal, .eds-modal__mask, .eds-modal__container');

  // Strategy A: Direct file input inside the cell
  const direct = Array.from(cell.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .find((inp) => !inModal(inp)) ?? null;
  if (direct) return direct;

  // Strategy B: Click upload button to reveal file input
  const uploadBtn = Array.from(cell.querySelectorAll<HTMLElement>(
    '.image-upload-button, .upload-button, [class*="upload"], .eds-button'
  )).find((btn) => !inModal(btn)) ?? null;
  if (uploadBtn) {
    uploadBtn.click();
    // Check again after click
    const revealed = Array.from(cell.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .find((inp) => !inModal(inp)) ?? null;
    if (revealed) return revealed;
  }

  return null;
}

function isInsideShopeeModal(el: Element | null): boolean {
  return !!el?.closest('.eds-modal, .image-cropper-modal, .eds-modal__mask, .eds-modal__container');
}

function getOptionRowValue(row: HTMLElement): string {
  const input = row.querySelector<HTMLInputElement>('input.eds-input__input, input[placeholder="輸入"], input');
  const inputVal = input?.value?.trim();
  if (inputVal) return inputVal;

  const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
  return text;
}

function findTier1OptionRows(): HTMLElement[] {
  const selectors = [
    '.variation-edit-item-content .variation-option-panel .option-container .options-item',
    '.variation-edit-item-content .variation-option-panel .option-container .virtual-options-item',
    '.variation-edit-item-content .variation-option-panel .options-item',
    '.variation-edit-item-content .variation-option-panel .virtual-options-item',
    '.variation-option-panel .option-container .options-item',
    '.variation-option-panel .option-container .virtual-options-item',
    '.variation-option-panel .options-item',
    '.variation-option-panel .virtual-options-item',
    '.option-container .options-item',
    '.option-container .virtual-options-item',
    '.options-item.drag-item',
    '.virtual-options-item'
  ];

  const set = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      set.add(row);
    }
  }

  // Fallback: derive row containers from visible option inputs.
  const optionInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('.variation-option-panel input[placeholder="輸入"], input[placeholder="輸入"]')
  ).filter((inp) => inp.offsetParent !== null && !isInsideShopeeModal(inp));
  for (const inp of optionInputs) {
    const row = inp.closest<HTMLElement>('.options-item, .virtual-options-item, .option-container > div');
    if (row) set.add(row);
  }

  return Array.from(set).filter((row) => !isInsideShopeeModal(row) && row.offsetParent !== null);
}

function findOptionRowFileInput(row: HTMLElement): HTMLInputElement | null {
  const direct = Array.from(
    row.querySelectorAll<HTMLInputElement>('.variation-image-manager input[type="file"], .shopee-image-manager input[type="file"], input[type="file"]')
  ).find((inp) => !isInsideShopeeModal(inp));
  if (direct) return direct;

  const uploadBtn = Array.from(
    row.querySelectorAll<HTMLElement>('.shopee-image-manager__upload, .image-upload-button, .upload-button, [class*="upload"], .eds-button')
  ).find((btn) => !isInsideShopeeModal(btn));
  if (uploadBtn) {
    uploadBtn.click();
    const revealed = Array.from(
      row.querySelectorAll<HTMLInputElement>('.variation-image-manager input[type="file"], .shopee-image-manager input[type="file"], input[type="file"]')
    ).find((inp) => !isInsideShopeeModal(inp));
    if (revealed) return revealed;
  }

  return null;
}

async function uploadVariantImageToInput(
  fileInput: HTMLInputElement,
  fb: FBPostPayload,
  sourceIndex: number,
  base64Item: FBImageBase64 | undefined,
  reporter: FillReporter,
  fieldName: string
): Promise<boolean> {
  if (base64Item) {
    return uploadSingleBase64(fileInput, base64Item, reporter, fieldName);
  }
  const url = fb.imageUrlsOrdered[sourceIndex];
  if (!url) return false;
  const before = fileInput.files?.length ?? 0;
  await uploadImagesFromUrls(fileInput, [url], reporter, fieldName);
  await sleep(120);
  const after = fileInput.files?.length ?? 0;
  return after > before || after > 0;
}

async function bindVariantImages(
  fb: FBPostPayload,
  draft: AiProductDraftV2,
  imageAssignment: ResolvedImages,
  reporter: FillReporter
): Promise<void> {
  if (!imageAssignment.variantImageMap.size) {
    if (draft.variantImageBindings.length === 0) {
      reporter.skip('variantImageBindings', 'no high-confidence bindings');
    }
    // Report pending bindings
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
  const tier1Options = draft.shopee.tierVariationList?.[0]?.options ?? [];

  // Strategy 0: Bind directly on option rows (where image upload actually lives).
  const optionRowsAll = findTier1OptionRows();
  const optionRows = optionRowsAll.filter((row) => {
    const val = getOptionRowValue(row);
    if (val && val.length <= 40) return true;
    if (row.classList.contains('virtual-options-item')) return false;
    return !!row.querySelector('.shopee-image-manager__image, .variation-image-manager, .shopee-image-manager');
  });
  console.log(`[fb2shopee] found ${optionRows.length} tier option rows for variant images`);

  // Wait for the variant table to appear (may take time after spec options are filled)
  const tableBody = await waitForVariantTable();

  const cellWrappers = tableBody
    ? Array.from(tableBody.querySelectorAll<HTMLElement>('.table-cell-wrapper'))
      .filter((cell) => !isInsideShopeeModal(cell) && cell.offsetParent !== null)
    : [];

  // If rows are fewer than expected, broaden selection and merge unique cells.
  if (cellWrappers.length < imageAssignment.variantImageMap.size) {
    const fallbackCells = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.variation-model-table-fixed-left .table-cell-wrapper, .variation-model-table-container .table-cell-wrapper'
      )
    ).filter((cell) => !isInsideShopeeModal(cell) && cell.offsetParent !== null);
    if (fallbackCells.length) {
      const seen = new Set(cellWrappers);
      for (const cell of fallbackCells) {
        if (!seen.has(cell)) {
          cellWrappers.push(cell);
          seen.add(cell);
        }
      }
      console.log(`[fb2shopee] merged fallback selector, total ${cellWrappers.length} cell wrappers`);
    }
  }

  console.log(`[fb2shopee] found ${cellWrappers.length} cell wrappers for variant images`);
  if (cellWrappers.length < imageAssignment.variantImageMap.size) {
    reporter.warn(
      `variant rows (${cellWrappers.length}) < bindings (${imageAssignment.variantImageMap.size}); check tier options input`
    );
  }

  for (const [optionName, sourceIndex] of imageAssignment.variantImageMap) {
    const base64Item = fb.imageBase64List?.find((b) => b.sourceIndex === sourceIndex);
    let uploaded = false;

    console.log(`[fb2shopee] binding variant image: "${optionName}" -> image[${sourceIndex}] (base64: ${!!base64Item})`);

    // Strategy 1: option row by text / position
    const optionIndex = tier1Options.indexOf(optionName);
    const rowByName = optionRows.find((row) => normalizeText(getOptionRowValue(row)) === normalizeText(optionName));
    const rowByPosition = optionIndex >= 0 ? (optionRows[optionIndex] ?? null) : null;
    const targetRow = rowByName ?? rowByPosition;
    if (targetRow) {
      const fileInput = findOptionRowFileInput(targetRow);
      if (fileInput) {
        uploaded = await uploadVariantImageToInput(
          fileInput, fb, sourceIndex, base64Item, reporter, `variantImage:${optionName}`
        );
        console.log(
          `[fb2shopee] strategy 1 (option row) for "${optionName}": ${uploaded ? 'OK' : 'FAIL'}`
        );
      } else {
        console.log(`[fb2shopee] strategy 1 for "${optionName}": option-row fileInput=false base64=${!!base64Item}`);
      }
    }

    // Strategy 2: Match by position in table wrappers (fallback)
    if (!uploaded && optionIndex >= 0 && optionIndex < cellWrappers.length) {
      const cell = cellWrappers[optionIndex];
      const fileInput = findCellFileInput(cell);
      if (fileInput) {
        uploaded = await uploadVariantImageToInput(
          fileInput, fb, sourceIndex, base64Item, reporter, `variantImage:${optionName}`
        );
        console.log(
          `[fb2shopee] strategy 2 (table position) for "${optionName}": ${uploaded ? 'OK' : 'FAIL'}`
        );
      } else {
        console.log(`[fb2shopee] strategy 2 for "${optionName}": fileInput=false base64=${!!base64Item}`);
      }
    }

    // Strategy 3: Find by text near file input
    if (!uploaded) {
      const optionElements = findElementsContainingText(optionName)
        .filter((el) => !isInsideShopeeModal(el) && el.offsetParent !== null);
      for (const optionEl of optionElements) {
        const container = optionEl.closest<HTMLElement>(
          '.table-cell-wrapper, [class*="variation"], [class*="model"], div'
        ) ?? optionEl;

        const fileInput = findCellFileInput(container);
        if (!fileInput) continue;

        uploaded = await uploadVariantImageToInput(
          fileInput, fb, sourceIndex, base64Item, reporter, `variantImage:${optionName}`
        );
        if (uploaded) {
          console.log(`[fb2shopee] strategy 3 (text match) for "${optionName}": OK`);
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
    reporter.success('variantImageBindings');
    console.log(`[fb2shopee] variant image binding complete: ${successCount}/${imageAssignment.variantImageMap.size} uploaded`);
  }
}

// ---------------------------------------------------------------------------
// Fill: Shipping
// ---------------------------------------------------------------------------

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
    const dims = [
      { keyword: '長', value: shipping.dimension.length },
      { keyword: '寬', value: shipping.dimension.width },
      { keyword: '高', value: shipping.dimension.height }
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
      reporter.success('shipping.dimension');
    } else {
      reporter.fail('shipping.dimension', 'one or more dimension fields missing');
    }
  } else {
    reporter.skip('shipping.dimension', 'no package dimension provided');
  }

  if (shipping.preOrderDaysToShip !== undefined) {
    // Shopee has radio buttons for "較長備貨" (否/是), then a days input
    const preOrderClicked = await clickByText(['是'], findFieldContainerByKeywords(['較長備貨', '備貨']) ?? undefined);
    if (preOrderClicked) {
      await sleep(200);
      const daysField = findFieldContainerByKeywords(['備貨天數', '出貨天數', '天']);
      const daysInput = findInputInContainer(daysField);
      if (daysInput && (daysInput instanceof HTMLInputElement || daysInput instanceof HTMLTextAreaElement)) {
        setNativeValue(daysInput, String(shipping.preOrderDaysToShip));
        reporter.success('shipping.preOrderDaysToShip');
      } else {
        reporter.fail('shipping.preOrderDaysToShip', 'days input not found after enabling pre-order');
      }
    } else {
      reporter.fail('shipping.preOrderDaysToShip', 'pre-order toggle not found');
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

      // Shopee uses toggle switches for logistics — look for nearby switch/checkbox
      const container = target.closest<HTMLElement>('div, label, li, section') ?? target;
      const toggle = container.querySelector<HTMLElement>(
        '[class*="switch"], [class*="toggle"], input[type="checkbox"], [role="switch"]'
      );

      if (toggle) {
        const isOn = toggle.classList.contains('is-checked') ||
          toggle.getAttribute('aria-checked') === 'true' ||
          (toggle instanceof HTMLInputElement && toggle.checked);
        if (!isOn) {
          toggle.click();
          await sleep(200);
        }
        matched += 1;
      } else {
        // Fallback: click the label/container
        target.click();
        matched += 1;
        await sleep(100);
      }
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

// ---------------------------------------------------------------------------
// Main apply draft orchestrator
// ---------------------------------------------------------------------------

async function reattachBase64FromStorage(fb: FBPostPayload): Promise<FBPostPayload> {
  if (fb.imageBase64List?.length) {
    return fb; // Already has base64
  }
  try {
    const stored = await chrome.storage.local.get('lastFbBase64Images');
    const base64List = stored.lastFbBase64Images;
    if (Array.isArray(base64List) && base64List.length > 0) {
      return { ...fb, imageBase64List: base64List as FBImageBase64[] };
    }
  } catch {
    // Storage read failed — will proceed without base64 images
  }
  return fb;
}

async function applyDraft(payload: { fb: FBPostPayload; draft: AiProductDraftV2 }): Promise<FillReportV2> {
  if (!isNewProductPage()) {
    throw new Error('Current page is not Shopee new product page');
  }

  const reporter = new FillReporter();
  // Re-attach base64 images from chrome.storage.local
  // (they are stripped from the message payload to avoid exceeding Chrome's message size limits)
  const fb = await reattachBase64FromStorage(payload.fb);
  const { draft } = payload;

  console.log('[fb2shopee] applyDraft started', {
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

  // Resolve which images go where (main vs variant)
  const imageAssignment = resolveImageAssignment(fb, draft);

  // Step 1: Fill category FIRST (unlocks other fields like attributes, sales, shipping)
  try {
    console.log('[fb2shopee] Step 1: Filling category', draft.shopee.categoryPath);
    await fillCategoryPath(draft.shopee.categoryPath, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 1 error:', e);
    reporter.fail('categoryPath', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
    // Ensure modal is closed even on exception
    try { await closeCategoryModal(); } catch { /* ignore */ }
  }
  // ALWAYS continue filling other fields, even if category failed.
  // Some fields (images, name, description) don't require category.
  // If category was partially selected, price/stock fields may still be available.

  // Step 2: Fill basic info (images, name, description)
  try {
    console.log('[fb2shopee] Step 2: Filling basic info');
    await fillBasicInfo(fb, draft, imageAssignment, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 2 error:', e);
    reporter.fail('basicInfo', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Step 3: Fill attributes (品牌, 產地, 材質, etc.)
  try {
    console.log('[fb2shopee] Step 3: Filling attributes');
    await fillAttributes(draft, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 3 error:', e);
    reporter.fail('attributes', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Step 4: Fill tier variations (adds spec options)
  try {
    console.log('[fb2shopee] Step 4: Filling tier variations');
    await fillTierVariations(draft, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 4 error:', e);
    reporter.fail('tierVariationList', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Step 5: Fill model prices (or standalone price if no variations)
  try {
    console.log('[fb2shopee] Step 5: Filling models/price');
    await fillModels(draft, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 5 error:', e);
    reporter.fail('modelList', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Step 6: Bind variant images (per-option images)
  try {
    console.log('[fb2shopee] Step 6: Binding variant images');
    await bindVariantImages(fb, draft, imageAssignment, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 6 error:', e);
    reporter.fail('variantImageBindings', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Step 7: Fill shipping
  try {
    console.log('[fb2shopee] Step 7: Filling shipping');
    await fillShipping(draft, reporter);
  } catch (e) {
    console.error('[fb2shopee] Step 7 error:', e);
    reporter.fail('shipping', `exception: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  reporter.skip('publish', 'publish action is intentionally disabled by design');

  lastFillReport = reporter.toJSON();
  console.log('[fb2shopee] applyDraft finished', lastFillReport);
  return lastFillReport;
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

// Guard against duplicate listener registration.
// When both manifest content_scripts AND chrome.scripting.executeScript inject this file,
// multiple listeners would be registered. The first listener returns `true` (async),
// but Chrome only delivers the sendResponse callback to ONE listener.
// Other listeners' channels get closed, causing the "message channel closed" error.
const SHOPEE_LISTENER_KEY = '__fb2shopee_shopee_listener__';
if (!(window as unknown as Record<string, unknown>)[SHOPEE_LISTENER_KEY]) {
  (window as unknown as Record<string, unknown>)[SHOPEE_LISTENER_KEY] = true;
  console.log('[fb2shopee] Registering Shopee content script message listener');

  chrome.runtime.onMessage.addListener((message: AnyRuntimeRequest, _sender, sendResponse) => {
    // Only handle messages we know about
    const knownTypes: string[] = [MSG.collect_shopee_schema, MSG.apply_shopee_draft, MSG.get_fill_report];
    if (!knownTypes.includes((message as { type?: string }).type ?? '')) {
      return false; // Not our message — don't hold the channel open
    }

    // Safety: track whether sendResponse has been called to avoid "message channel closed" errors
    let responded = false;
    const safeRespond = (data: Record<string, unknown>): void => {
      if (responded) return;
      responded = true;
      try {
        sendResponse(data);
      } catch (e) {
        console.error('[fb2shopee] sendResponse failed (channel likely closed):', e);
      }
    };

    void (async () => {
      try {
        if (message.type === MSG.collect_shopee_schema) {
          if (!isNewProductPage()) {
            throw new Error('Please open Shopee new product page first');
          }
          const payload = collectSchemaSnapshot();
          safeRespond({ ok: true, payload });
          return;
        }

        if (message.type === MSG.apply_shopee_draft) {
          console.log('[fb2shopee] Received apply_shopee_draft message');
          const payload = await applyDraft(message.payload);
          safeRespond({ ok: true, payload });
          return;
        }

        if (message.type === MSG.get_fill_report) {
          safeRespond({ ok: true, payload: lastFillReport ?? undefined });
          return;
        }
      } catch (error) {
        console.error('[fb2shopee] Message handler error:', error);
        safeRespond({ ok: false, error: pickErrorMessage(error) });
      }
    })();

    return true;
  });
} else {
  console.log('[fb2shopee] Shopee content script listener already registered, skipping');
}
