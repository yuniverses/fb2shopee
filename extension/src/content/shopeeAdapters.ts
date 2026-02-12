import type { AiModel, FillReportV2 } from '@shared/contracts';

export class FillReporter {
  private readonly successFields = new Set<string>();
  private readonly failedFields = new Set<string>();
  private readonly skippedFields = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly pendingActions: string[] = [];
  private readonly startAt = Date.now();

  success(field: string): void {
    this.successFields.add(field);
  }

  fail(field: string, reason?: string): void {
    this.failedFields.add(field);
    if (reason) {
      this.warn(`[${field}] ${reason}`);
    }
  }

  skip(field: string, reason?: string): void {
    this.skippedFields.add(field);
    if (reason) {
      this.warn(`[${field}] skipped: ${reason}`);
    }
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  pending(action: string): void {
    this.pendingActions.push(action);
  }

  toJSON(): FillReportV2 {
    return {
      successFields: Array.from(this.successFields),
      failedFields: Array.from(this.failedFields),
      skippedFields: Array.from(this.skippedFields),
      warnings: this.warnings,
      pendingActions: this.pendingActions,
      durationMs: Date.now() - this.startAt
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

export function findElementsContainingText(text: string, root: ParentNode = document): HTMLElement[] {
  const target = normalizeText(text);
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('div,span,label,p,button,a'));
  return nodes.filter((node) => {
    const value = normalizeText(node.textContent || '');
    return value.includes(target);
  });
}

export function findFieldContainerByKeywords(keywords: string[]): HTMLElement | null {
  for (const keyword of keywords) {
    const candidates = findElementsContainingText(keyword);
    for (const node of candidates) {
      const container = node.closest<HTMLElement>(
        '[class*="field"], [class*="form-item"], [class*="product"], [class*="item"], [data-field], li, section'
      );
      if (container) {
        return container;
      }
    }
  }
  return null;
}

export function dispatchInputEvents(element: HTMLElement): void {
  const events = ['input', 'change', 'blur'];
  for (const eventName of events) {
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  }
}

export function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement;
  const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }
  dispatchInputEvents(element);
}

export function findInputInContainer(container: HTMLElement | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!container) {
    return null;
  }

  const selector =
    'input:not([type="hidden"]):not([type="file"]):not([readonly]), textarea:not([readonly]), [contenteditable="true"]';
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (input) {
    return input;
  }

  return null;
}

export function setContentEditableText(element: HTMLElement, value: string): void {
  element.focus();
  element.textContent = value;
  dispatchInputEvents(element);
}

export async function clickByText(textCandidates: string[], root: ParentNode = document): Promise<boolean> {
  const clickableSelector = 'button, [role="button"], a, div, span';

  for (const text of textCandidates) {
    const targetText = normalizeText(text);
    const elements = Array.from(root.querySelectorAll<HTMLElement>(clickableSelector));
    const found = elements.find((el) => normalizeText(el.textContent || '').includes(targetText));
    if (found) {
      found.click();
      await sleep(120);
      return true;
    }
  }

  return false;
}

export async function selectDropdownOption(optionText: string): Promise<boolean> {
  const optionNodes = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"], li, .eds-select-option, .shopee-selector-item')
  );

  const target = optionNodes.find((node) => normalizeText(node.textContent || '').includes(normalizeText(optionText)));
  if (!target) {
    return false;
  }

  target.click();
  await sleep(160);
  return true;
}

export function findFileInputByContext(contextKeywords: string[]): HTMLInputElement | null {
  const container = findFieldContainerByKeywords(contextKeywords);
  const scopedInput = container?.querySelector<HTMLInputElement>('input[type="file"]');
  if (scopedInput) {
    return scopedInput;
  }

  return document.querySelector<HTMLInputElement>('input[type="file"]');
}

async function fetchImageAsFile(url: string, index: number): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`image fetch failed: ${response.status}`);
  }

  const blob = await response.blob();
  const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
  return new File([blob], `fb-image-${index + 1}.${ext}`, { type: blob.type || 'image/jpeg' });
}

export async function uploadImagesFromUrls(
  input: HTMLInputElement,
  urls: string[],
  reporter: FillReporter,
  fieldName = 'images'
): Promise<void> {
  if (!urls.length) {
    reporter.skip(fieldName, 'no image urls');
    return;
  }

  const files: File[] = [];
  for (let i = 0; i < urls.length; i += 1) {
    try {
      const file = await fetchImageAsFile(urls[i], i);
      files.push(file);
    } catch (error) {
      reporter.warn(`image ${i + 1} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  if (!files.length) {
    reporter.fail(fieldName, 'all image fetch attempts failed');
    return;
  }

  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }

  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);
  reporter.success(fieldName);
}

export function findModelRow(model: AiModel): HTMLElement | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('tr, [class*="model-row"], [class*="variation-row"]'));
  if (!model.variationValues?.length) {
    return rows[0] || null;
  }

  const normalizedTargets = model.variationValues.map((x) => normalizeText(x));
  return (
    rows.find((row) => {
      const rowText = normalizeText(row.textContent || '');
      return normalizedTargets.every((target) => rowText.includes(target));
    }) || null
  );
}

export function fillPriceInputInRow(row: HTMLElement, price: number): boolean {
  const candidates = Array.from(
    row.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"]')
  ).filter((input) => {
    const p = normalizeText(input.placeholder || '');
    return p.includes('價格') || p.includes('price') || p.includes('售價');
  });

  const target = candidates[0] || row.querySelector<HTMLInputElement>('input[type="text"], input[type="number"]');
  if (!target) {
    return false;
  }

  setNativeValue(target, String(price));
  return true;
}

export function fillSkuInputInRow(row: HTMLElement, sku: string): boolean {
  const candidates = Array.from(
    row.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="number"]')
  ).filter((input) => {
    const p = normalizeText(input.placeholder || '');
    return p.includes('sku') || p.includes('型號') || p.includes('賣家');
  });

  const target = candidates[0];
  if (!target) {
    return false;
  }

  setNativeValue(target, sku);
  return true;
}

export function uniqueStringArray(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}
