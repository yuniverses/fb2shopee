export const SHOPEE_NEW_PRODUCT_URL =
  'https://seller.shopee.tw/portal/product/new?from=sidebar';

export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

export const SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
