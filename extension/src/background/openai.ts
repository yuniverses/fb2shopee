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
const OPENAI_TIMEOUT_MS = 90000;
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Timed out while fetching: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
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
    'You are an e-commerce listing assistant for Shopee TW.',
    'Return only valid JSON matching the target schema.',
    'Rules:',
    '1. Keep title <= 60 Chinese characters and include brand, origin, core function, use scenario, and store identity when possible.',
    '2. Preserve image order from sourceIndex.',
    '3. Infer variation dimensions and model combinations from post text + image OCR + visual cues.',
    '4. Produce variantImageBindings for tier1 option only (one image per tier1 option).',
    '5. If confidence < 0.78, do not bind and emit pendingVariantImageBindings with reason low_confidence.',
    '6. stock must always be null.',
    '7. categoryPath must be concrete and directly usable.',
    '8. source MUST be an object that mirrors the input fb payload, not a string label.',
    '9. For optional fields, omit them when unknown. Never output null for optional string/number fields.',
    '10. If uncertain, add warnings with explicit uncertainty.'
  ].join('\n');
}

function createUserPrompt(fb: FBPostPayload, schema: ShopeeSchemaSnapshot): string {
  const payload = {
    fb,
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
  onProgress?: ProgressCallback
): Promise<{ draft: AiProductDraftV2; warnings: string[] }> {
  const model = settings.model?.trim() || DEFAULT_OPENAI_MODEL;
  const images = await fetchInputImages(fb.imageUrlsOrdered, onProgress);
  if (!images.length) {
    throw new Error('No valid FB images were resolved for AI input');
  }

  const imageInputs = images.map((image) => ({
    type: 'input_image',
    image_url: `data:${image.mimeType};base64,${image.base64}`
  }));

  const body = {
    model,
    temperature: 0.2,
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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await onProgress?.(`Sending OpenAI request attempt ${attempt}/3`);
      const response = await fetchWithTimeout(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        },
        OPENAI_TIMEOUT_MS
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      await onProgress?.('OpenAI response received, validating JSON');
      const json = (await response.json()) as unknown;
      const text = extractResponseText(json);
      const parsed = parseAiDraft(parseModelJson(text), fb);
      const normalized = normalizeAiDraft(parsed, schema.constraints);
      await onProgress?.('AI draft validated');
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
