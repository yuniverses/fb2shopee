import { DEFAULT_OPENAI_MODEL } from '@shared/constants';
import type {
  AiProductDraftV2,
  FBPostPayload,
  OpenAiSettings,
  ShopeeSchemaSnapshot
} from '@shared/contracts';
import { normalizeAiDraft, parseAiDraft } from '@shared/schema';

interface OpenAiInputImage {
  url: string;
  mimeType: string;
  base64: string;
  sourceIndex: number;
}

const INPUT_IMAGE_FETCH_TIMEOUT_MS = 15000;
const OPENAI_TIMEOUT_MS = 180000; // 3 min — vision requests with multiple images are slow
type ProgressCallback = (message: string) => void | Promise<void>;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function resolveMimeType(contentType: string | null, fallbackUrl: string): string {
  if (contentType && contentType.includes('/')) {
    return contentType.split(';')[0]?.trim() ?? 'image/jpeg';
  }
  if (fallbackUrl.endsWith('.png')) {
    return 'image/png';
  }
  if (fallbackUrl.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractImageUrlFromHtml(html: string, baseUrl: string): string | null {
  const metaPatterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i
  ];

  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(new URL(match[1], baseUrl).toString());
    }
  }

  const jsonUri = html.match(/"image"\s*:\s*\{[^}]*"uri"\s*:\s*"([^"]+)"/i)?.[1];
  if (jsonUri) {
    return decodeHtmlEntities(jsonUri.replace(/\\u0025/g, '%').replace(/\\\//g, '/'));
  }

  return null;
}

function isImageResponse(response: Response, sourceUrl: string): boolean {
  const mime = response.headers.get('content-type') || '';
  if (mime.startsWith('image/')) {
    return true;
  }

  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(sourceUrl) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(response.url);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Abort our internal controller when the external signal fires
  if (externalSignal?.aborted) {
    controller.abort();
  }
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new Error('Pipeline cancelled');
      }
      throw new Error(`Timed out while fetching: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function fetchImagePayload(url: string): Promise<{ mimeType: string; base64: string; resolvedUrl: string } | null> {
  const first = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow'
    },
    INPUT_IMAGE_FETCH_TIMEOUT_MS
  );

  if (!first.ok) {
    return null;
  }

  if (isImageResponse(first, url)) {
    const mimeType = resolveMimeType(first.headers.get('content-type'), first.url || url);
    const arrayBuffer = await first.arrayBuffer();
    return {
      mimeType,
      base64: arrayBufferToBase64(arrayBuffer),
      resolvedUrl: first.url || url
    };
  }

  const html = await first.text();
  const nestedImageUrl = extractImageUrlFromHtml(html, first.url || url);
  if (!nestedImageUrl) {
    return null;
  }

  const second = await fetchWithTimeout(
    nestedImageUrl,
    {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow'
    },
    INPUT_IMAGE_FETCH_TIMEOUT_MS
  );

  if (!second.ok || !isImageResponse(second, nestedImageUrl)) {
    return null;
  }

  const mimeType = resolveMimeType(second.headers.get('content-type'), second.url || nestedImageUrl);
  const arrayBuffer = await second.arrayBuffer();
  return {
    mimeType,
    base64: arrayBufferToBase64(arrayBuffer),
    resolvedUrl: second.url || nestedImageUrl
  };
}

export async function fetchInputImages(
  urls: string[],
  onProgress?: ProgressCallback
): Promise<OpenAiInputImage[]> {
  let completed = 0;
  const tasks = urls.map(async (url, index) => {
    try {
      const payload = await fetchImagePayload(url);
      if (!payload) {
        return null;
      }
      return {
        url: payload.resolvedUrl,
        mimeType: payload.mimeType,
        base64: payload.base64,
        sourceIndex: index
      } satisfies OpenAiInputImage;
    } catch {
      return null;
    } finally {
      completed += 1;
      await onProgress?.(`Preparing images ${completed}/${urls.length}`);
    }
  });

  const settled = await Promise.all(tasks);
  const results = settled
    .filter((item): item is OpenAiInputImage => item !== null)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);

  await onProgress?.(`Resolved ${results.length}/${urls.length} images`);
  return results;
}

function createSystemPrompt(): string {
  return [
    'You are an e-commerce listing assistant for Shopee TW (台灣蝦皮賣場).',
    'Return only valid JSON matching the target schema.',
    '',
    '## Core Rules',
    '1. Title: ≤60 Chinese characters. Include brand, origin, core function, use scenario, store identity when possible.',
    '2. Description: Rich product description in Traditional Chinese. Include materials, dimensions, usage, care instructions.',
    '3. categoryPath: Use real Shopee TW category hierarchy (e.g. ["居家生活","居家裝飾","地毯、地墊"]). Must be concrete leaf category.',
    '4. stock must always be null (seller fills manually).',
    '5. source MUST mirror the input fb payload object.',
    '6. For optional fields, omit when unknown. Never output null for optional string/number fields.',
    '',
    '## Image Assignment (CRITICAL)',
    'You receive multiple product images. Your key task is to classify each image:',
    '',
    '- **Variant images**: Images showing a specific color/style/size variant. These go to variantImageBindings.',
    '- **Main images**: General product images (lifestyle shots, detail shots, packaging). These go to shopee.images.',
    '',
    'How to decide:',
    '- If an image clearly shows ONE specific variant (e.g., only the red version), bind it to that tier1 option.',
    '- If an image shows the product in general or multiple variants together, put it in shopee.images.',
    '- Each tier1 option should have AT MOST one bound image (the best/clearest one).',
    '- Remaining images that are not bound to variants should ALL be in shopee.images.',
    '',
    '7. variantImageBindings: one entry per tier1 option with {tier1Option, imageSourceIndex, confidence}.',
    '8. confidence: 0.0-1.0. Use ≥0.85 when you are certain, 0.5-0.84 when guessing. <0.5 → emit pendingVariantImageBindings instead.',
    '9. If confidence < 0.78 at normalization stage, binding is demoted to pending automatically.',
    '',
    '## Variant Image Matching Strategies (IMPORTANT)',
    'Each image is labeled [Image N] where N is the imageSourceIndex. Always use these exact indices in variantImageBindings.',
    '',
    'Common patterns in FB group posts to identify which image belongs to which variant:',
    '- Posts with items labeled A款/B款/C款, A/B/C, or 1號/2號/3號: Each label corresponds to one variant. Images appear in the SAME ORDER as the labels.',
    '- Posts listing colors (e.g., "紅色/藍色/黑色") followed by images: Images typically appear in the same order as color names.',
    '- If images contain visible text labels (printed on/near the item), use OCR text to match them to tier1 option names.',
    '- If a single image shows multiple items side-by-side (composite/collage), do NOT bind it to one variant — put it in shopee.images as a main image.',
    '- When the post says "顏色如圖" (colors as shown), each image likely represents one variant option in order.',
    '- If the number of individual product images matches the number of variants, map them 1:1 in order.',
    '',
    'Confidence guidelines for variantImageBindings:',
    '- 0.90-1.0: Image has visible text matching the option name, or post explicitly maps images to options.',
    '- 0.80-0.89: Strong positional correlation (first color → first image) or clear visual match (color matches).',
    '- 0.70-0.79: Reasonable guess based on image order and variant count alignment.',
    '- Below 0.70: Put in pendingVariantImageBindings with reason instead.',
    '',
    '## Variations & Models',
    '- Infer variation dimensions (顏色/Color, 尺寸/Size, 款式/Style) from post text + image OCR + visual cues.',
    '- tierVariationList: [{name: "顏色", options: ["紅色","藍色"]}] — use Traditional Chinese.',
    '- modelList: one entry per combination. price in TWD (NT$). stock: null.',
    '- If the post mentions a single price, apply it to all models.',
    '- If different variants have different prices, parse them from the text.',
    '',
    '## Pricing',
    '- Parse prices from the FB post text (look for NT$, 元, $, numbers near price keywords).',
    '- If no price found, set a reasonable default (e.g., 299) and add a warning.',
    '',
    '10. If uncertain about anything, add warnings with explicit uncertainty description.'
  ].join('\n');
}

function createUserPrompt(fb: FBPostPayload, schema: ShopeeSchemaSnapshot): string {
  // IMPORTANT: strip imageBase64List from the FB payload before serialization.
  // The base64 data is only used for input_image payloads, not the text prompt.
  // Including it would make the request body enormous (50-100+ MB).
  const { imageBase64List: _strip, ...fbWithoutBase64 } = fb;

  const payload = {
    fb: fbWithoutBase64,
    schema,
    outputShape: {
      source: {
        postUrl: 'string(url)',
        postText: 'string',
        imageUrlsOrdered: ['string(url)'],
        capturedAtISO: 'string(iso8601)'
      },
      shopee: {
        title: 'string',
        description: 'string',
        categoryPath: ['string'],
        images: [{ sourceIndex: 'number' }],
        brand: 'string | undefined',
        attributes: 'Record<string, string | string[]> | undefined',
        tierVariationList: [{ name: 'string', options: ['string'] }],
        modelList: [
          {
            variationValues: ['string'],
            sku: 'string | undefined',
            price: 'number',
            stock: null,
            gtinCode: 'string | undefined'
          }
        ],
        shipping: {
          weight: { value: 'number', unit: 'KG|G' },
          dimension: { length: 'number', width: 'number', height: 'number' },
          preOrderDaysToShip: 'number | undefined',
          logisticsChannels: ['string']
        }
      },
      warnings: ['string'],
      variantImageBindings: [{ tier1Option: 'string', imageSourceIndex: 'number', confidence: 'number' }],
      pendingVariantImageBindings: [
        { tier1Option: 'string', reason: 'low_confidence|not_found|conflict|invalid_option|unknown' }
      ]
    }
  };

  return JSON.stringify(payload);
}

function extractResponseText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') {
    return '';
  }

  const maybeAny = raw as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (maybeAny.output_text && typeof maybeAny.output_text === 'string') {
    return maybeAny.output_text;
  }

  if (Array.isArray(maybeAny.output)) {
    const parts: string[] = [];
    for (const out of maybeAny.output) {
      if (!Array.isArray(out.content)) {
        continue;
      }
      for (const piece of out.content) {
        if (typeof piece.text === 'string') {
          parts.push(piece.text);
        }
      }
    }
    return parts.join('\n').trim();
  }

  return '';
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence?.[1]) {
    return fence[1].trim();
  }
  return trimmed;
}

function parseModelJson(rawText: string): unknown {
  const clean = stripCodeFence(rawText);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(clean.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON');
  }
}

export async function generateAiDraft(
  settings: OpenAiSettings,
  fb: FBPostPayload,
  schema: ShopeeSchemaSnapshot,
  onProgress?: ProgressCallback,
  abortSignal?: AbortSignal
): Promise<{ draft: AiProductDraftV2; warnings: string[] }> {
  const model = settings.model?.trim() || DEFAULT_OPENAI_MODEL;

  // Prefer pre-fetched base64 from FB content script (has cookies).
  // Fall back to background fetch for any missing images.
  // NOTE: base64 may not arrive via message passing if payload is too large (Chrome limit).
  let images: OpenAiInputImage[];
  const hasBase64 = Array.isArray(fb.imageBase64List) && fb.imageBase64List.length > 0;
  if (hasBase64) {
    await onProgress?.(`Using ${fb.imageBase64List!.length} pre-fetched base64 images from FB`);
    images = fb.imageBase64List!.map((item) => ({
      url: fb.imageUrlsOrdered[item.sourceIndex] || '',
      mimeType: item.mimeType,
      base64: item.base64,
      sourceIndex: item.sourceIndex
    }));
  } else {
    await onProgress?.('No pre-fetched base64 available, fetching images from background');
    images = await fetchInputImages(fb.imageUrlsOrdered, onProgress);
  }

  if (!images.length) {
    throw new Error('No valid FB images were resolved for AI input');
  }

  // Cap images to avoid oversized payloads — Shopee allows max 9 main images,
  // so sending more than ~12 is wasteful and dramatically slows down the API call.
  const MAX_AI_IMAGES = 12;
  if (images.length > MAX_AI_IMAGES) {
    await onProgress?.(`Trimming images from ${images.length} to ${MAX_AI_IMAGES} for AI`);
    images = images.slice(0, MAX_AI_IMAGES);
  }

  // Build image inputs with [Image N] labels so AI can reference each image by index
  const imageInputs: Array<{ type: string; text?: string; image_url?: string }> = [];
  for (const image of images) {
    imageInputs.push({
      type: 'input_text',
      text: `[Image ${image.sourceIndex}]`
    });
    imageInputs.push({
      type: 'input_image',
      image_url: `data:${image.mimeType};base64,${image.base64}`
    });
  }

  // GPT-5.2 is a thinking model — use reasoning.effort to control thinking depth.
  // For product listing extraction, "low" is sufficient and keeps latency down.
  const isThinkingModel = /gpt-5|o[1-9]|o3/.test(model);
  const body: Record<string, unknown> = {
    model,
    ...(!isThinkingModel && { temperature: 0.2 }),
    ...(isThinkingModel && { reasoning: { effort: 'low' } }),
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: createSystemPrompt() }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: createUserPrompt(fb, schema) }, ...imageInputs]
      }
    ]
  };

  let lastError = '';
  const bodyJson = JSON.stringify(body);
  const bodySizeMB = (bodyJson.length / (1024 * 1024)).toFixed(1);
  await onProgress?.(`Request body size: ${bodySizeMB} MB (${images.length} images)`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Check abort before each attempt to avoid unnecessary retries
    if (abortSignal?.aborted) {
      throw new Error('Pipeline cancelled');
    }
    try {
      await onProgress?.(`Sending OpenAI request attempt ${attempt}/3 (model: ${model})`);
      const fetchStart = Date.now();
      const response = await fetchWithTimeout(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: bodyJson
        },
        OPENAI_TIMEOUT_MS,
        abortSignal
      );
      const fetchMs = Date.now() - fetchStart;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error (${response.status}) after ${fetchMs}ms: ${errorText.substring(0, 500)}`);
      }

      await onProgress?.(`OpenAI response received in ${fetchMs}ms, reading body`);
      const json = (await response.json()) as unknown;
      await onProgress?.('OpenAI body parsed, extracting text');
      const text = extractResponseText(json);
      if (!text) {
        throw new Error('OpenAI returned empty response text');
      }
      // Pass fb without base64 as source fallback — base64 doesn't belong in the AI draft
      const { imageBase64List: _stripFallback, ...fbSourceFallback } = fb;
      const parsed = parseAiDraft(parseModelJson(text), fbSourceFallback);
      const normalized = normalizeAiDraft(parsed, schema.constraints);
      await onProgress?.(`AI draft validated (${text.length} chars response)`);
      return {
        draft: normalized.draft,
        warnings: normalized.warnings
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown AI error';
      lastError = `attempt ${attempt} failed: ${message}`;
      await onProgress?.(`OpenAI attempt ${attempt} failed: ${message}`);
    }
  }

  throw new Error(lastError || 'AI draft generation failed after retries');
}
