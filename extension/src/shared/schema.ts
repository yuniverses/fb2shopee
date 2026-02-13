import { z } from 'zod';
import type { AiProductDraftV2, FBPostPayload, ShopeeConstraints } from './contracts';
import { VARIANT_IMAGE_CONFIDENCE_THRESHOLD } from './constants';

const optionalString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => (typeof value === 'string' ? value : undefined));

const optionalPositiveInt = z
  .union([z.number().int().positive(), z.null(), z.undefined()])
  .transform((value) => (typeof value === 'number' ? value : undefined));

const tierSchema = z.object({
  name: z.string().min(1),
  options: z.array(z.string().min(1)).min(1)
});

const modelSchema = z.object({
  variationValues: z.array(z.string().min(1)).optional(),
  sku: optionalString,
  price: z.number().finite().nonnegative(),
  stock: z.null(),
  gtinCode: optionalString
});

const variantImageBindingSchema = z.object({
  tier1Option: z.string().min(1),
  imageSourceIndex: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1)
});

const pendingBindingSchema = z.object({
  tier1Option: z.string().min(1),
  reason: z.enum(['low_confidence', 'not_found', 'conflict', 'invalid_option', 'unknown'])
});

export const AiProductDraftV2Schema = z.object({
  source: z.object({
    postUrl: z.string().url(),
    postText: z.string(),
    imageUrlsOrdered: z.array(z.string().url()),
    imageBase64List: z
      .array(
        z.object({
          base64: z.string(),
          mimeType: z.string(),
          sourceIndex: z.number().int().nonnegative()
        })
      )
      .optional(),
    capturedAtISO: z.string()
  }),
  shopee: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    categoryPath: z.array(z.string().min(1)).min(1),
    images: z.array(z.object({ sourceIndex: z.number().int().nonnegative() })).min(1),
    brand: optionalString,
    attributes: z
      .union([z.record(z.string(), z.union([z.string(), z.array(z.string())])), z.null(), z.undefined()])
      .transform((value) => (value && typeof value === 'object' ? value : undefined)),
    tierVariationList: z.array(tierSchema).optional(),
    modelList: z.array(modelSchema).optional(),
    shipping: z
      .object({
        weight: z
          .object({
            value: z.number().positive(),
            unit: z.enum(['KG', 'G'])
          })
          .optional(),
        dimension: z
          .object({
            length: z.number().positive(),
            width: z.number().positive(),
            height: z.number().positive()
          })
          .optional(),
        preOrderDaysToShip: optionalPositiveInt,
        logisticsChannels: z.array(z.string().min(1)).optional()
      })
      .optional()
  }),
  warnings: z.array(z.string()),
  variantImageBindings: z.array(variantImageBindingSchema),
  pendingVariantImageBindings: z.array(pendingBindingSchema)
});

function sanitizeAiDraftInput(input: unknown, sourceFallback?: FBPostPayload): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const payload = structuredClone(input as Record<string, unknown>) as Record<string, unknown>;

  if (sourceFallback && (!payload.source || typeof payload.source !== 'object')) {
    payload.source = sourceFallback;
  }

  if (!Array.isArray(payload.warnings)) {
    payload.warnings = [];
  }
  if (!Array.isArray(payload.variantImageBindings)) {
    payload.variantImageBindings = [];
  }
  if (!Array.isArray(payload.pendingVariantImageBindings)) {
    payload.pendingVariantImageBindings = [];
  }

  return payload;
}

export function parseAiDraft(input: unknown, sourceFallback?: FBPostPayload): AiProductDraftV2 {
  return AiProductDraftV2Schema.parse(sanitizeAiDraftInput(input, sourceFallback));
}

export function normalizeAiDraft(
  draft: AiProductDraftV2,
  constraints: ShopeeConstraints
): { draft: AiProductDraftV2; warnings: string[] } {
  const warnings: string[] = [];
  const normalized: AiProductDraftV2 = structuredClone(draft);

  const maxImage = constraints.imageNumMax ?? 9;
  if (normalized.shopee.images.length > maxImage) {
    normalized.shopee.images = normalized.shopee.images.slice(0, maxImage);
    warnings.push(`images truncated to imageNumMax (${maxImage})`);
  }

  if (constraints.priceMin !== undefined || constraints.priceMax !== undefined) {
    const min = constraints.priceMin ?? 0;
    const max = constraints.priceMax ?? Number.POSITIVE_INFINITY;

    const clamp = (price: number): number => {
      if (price < min) {
        warnings.push(`price ${price} was below min ${min}; clamped`);
        return min;
      }
      if (price > max) {
        warnings.push(`price ${price} was above max ${max}; clamped`);
        return max;
      }
      return price;
    };

    if (normalized.shopee.modelList?.length) {
      normalized.shopee.modelList = normalized.shopee.modelList.map((model) => ({
        ...model,
        price: clamp(model.price),
        stock: null
      }));
    }
  }

  const uniqueBindings = new Map<string, { index: number; confidence: number }>();
  for (const item of normalized.variantImageBindings) {
    const existing = uniqueBindings.get(item.tier1Option);
    if (!existing || item.confidence > existing.confidence) {
      uniqueBindings.set(item.tier1Option, {
        index: item.imageSourceIndex,
        confidence: item.confidence
      });
    }
  }

  normalized.variantImageBindings = Array.from(uniqueBindings.entries()).map(([tier1Option, data]) => ({
    tier1Option,
    imageSourceIndex: data.index,
    confidence: data.confidence
  }));

  const lowConfidence = normalized.variantImageBindings.filter((x) => x.confidence < VARIANT_IMAGE_CONFIDENCE_THRESHOLD);
  if (lowConfidence.length) {
    for (const item of lowConfidence) {
      normalized.pendingVariantImageBindings.push({
        tier1Option: item.tier1Option,
        reason: 'low_confidence'
      });
    }
    normalized.variantImageBindings = normalized.variantImageBindings.filter((x) => x.confidence >= VARIANT_IMAGE_CONFIDENCE_THRESHOLD);
    warnings.push(`removed ${lowConfidence.length} low-confidence variant image bindings`);
  }

  return { draft: normalized, warnings };
}
