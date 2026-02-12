import { describe, expect, it } from 'vitest';
import type { AiProductDraftV2 } from '../src/shared/contracts';
import { normalizeAiDraft, parseAiDraft } from '../src/shared/schema';

function createDraft(): AiProductDraftV2 {
  return {
    source: {
      postUrl: 'https://www.facebook.com/groups/demo/posts/123',
      postText: '測試貼文',
      imageUrlsOrdered: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
      capturedAtISO: new Date().toISOString()
    },
    shopee: {
      title: '品牌 產地 核心功能 適用場景 店鋪名',
      description: '商品描述',
      categoryPath: ['居家生活', '收納整理'],
      images: [{ sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 0 }],
      tierVariationList: [{ name: '顏色', options: ['紅', '藍'] }],
      modelList: [
        { variationValues: ['紅'], price: 0, stock: null, sku: 'RED' },
        { variationValues: ['藍'], price: 9999999, stock: null, sku: 'BLUE' }
      ]
    },
    warnings: [],
    variantImageBindings: [
      { tier1Option: '紅', imageSourceIndex: 0, confidence: 0.8 },
      { tier1Option: '紅', imageSourceIndex: 1, confidence: 0.9 },
      { tier1Option: '藍', imageSourceIndex: 1, confidence: 0.6 }
    ],
    pendingVariantImageBindings: []
  };
}

describe('parseAiDraft', () => {
  it('parses valid draft', () => {
    const input = createDraft();
    const output = parseAiDraft(input);
    expect(output.shopee.title).toContain('品牌');
  });
});

describe('normalizeAiDraft', () => {
  it('clamps model prices and keeps stock null', () => {
    const draft = createDraft();
    const normalized = normalizeAiDraft(draft, {
      priceMin: 10,
      priceMax: 1000,
      imageNumMax: 2
    });

    expect(normalized.draft.shopee.images).toHaveLength(2);
    expect(normalized.draft.shopee.modelList?.[0]?.price).toBe(10);
    expect(normalized.draft.shopee.modelList?.[1]?.price).toBe(1000);
    expect(normalized.draft.shopee.modelList?.every((item) => item.stock === null)).toBe(true);
    expect(normalized.warnings.some((w) => w.includes('clamped'))).toBe(true);
  });

  it('keeps only highest-confidence binding per tier and moves low confidence to pending', () => {
    const draft = createDraft();
    const normalized = normalizeAiDraft(draft, {});

    expect(normalized.draft.variantImageBindings).toEqual([
      {
        tier1Option: '紅',
        imageSourceIndex: 1,
        confidence: 0.9
      }
    ]);

    expect(
      normalized.draft.pendingVariantImageBindings.some(
        (item) => item.tier1Option === '藍' && item.reason === 'low_confidence'
      )
    ).toBe(true);
  });
});
