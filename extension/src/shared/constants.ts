export const SHOPEE_NEW_PRODUCT_URL =
  'https://seller.shopee.tw/portal/product/new?from=sidebar';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.2-2025-12-11';

export const SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const VARIANT_IMAGE_CONFIDENCE_THRESHOLD = 0.70;

export const SHARED_FIELD_KEYS = {
  name: 'name',
  description: 'description',
  categoryPath: 'categoryPath',
  images: 'images',
  longImages: 'longImages',
  promotionImages: 'promotionImages',
  tierVariationList: 'tierVariationList',
  modelList: 'modelList',
  logisticsChannels: 'logisticsChannels'
} as const;
