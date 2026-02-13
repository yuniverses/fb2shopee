export type RegionCode = 'tw';

export type ShopeeFieldSection =
  | 'basic'
  | 'category'
  | 'spec'
  | 'sales'
  | 'shipping'
  | 'other';

export interface FBImageBase64 {
  base64: string;
  mimeType: string;
  sourceIndex: number;
}

export interface FBPostPayload {
  postUrl: string;
  postText: string;
  imageUrlsOrdered: string[];
  /** Pre-fetched base64 images (fetched in FB page context where cookies are available). */
  imageBase64List?: FBImageBase64[];
  capturedAtISO: string;
}

export interface ShopeeSchemaField {
  key: string;
  section: ShopeeFieldSection;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  options?: string[];
}

export interface ShopeeConstraints {
  imageNumMin?: number;
  imageNumMax?: number;
  priceMin?: number;
  priceMax?: number;
  stockMin?: number;
  stockMax?: number;
  dtsMin?: number;
  dtsMax?: number;
  inStockDts?: number;
  videoDurationMin?: number;
  videoDurationMax?: number;
  videoSizeLimit?: number;
}

export interface ShopeeSchemaSnapshot {
  version: 'v1';
  region: RegionCode;
  capturedAtISO: string;
  fields: ShopeeSchemaField[];
  constraints: ShopeeConstraints;
}

export interface VariantImageBinding {
  tier1Option: string;
  imageSourceIndex: number;
  confidence: number;
}

export interface PendingVariantImageBinding {
  tier1Option: string;
  reason: 'low_confidence' | 'not_found' | 'conflict' | 'invalid_option' | 'unknown';
}

export interface AiTierVariation {
  name: string;
  options: string[];
}

export interface AiModel {
  variationValues?: string[];
  sku?: string;
  price: number;
  stock: null;
  gtinCode?: string;
}

export interface AiShippingDraft {
  weight?: {
    value: number;
    unit: 'KG' | 'G';
  };
  dimension?: {
    length: number;
    width: number;
    height: number;
  };
  preOrderDaysToShip?: number;
  logisticsChannels?: string[];
}

export interface AiShopeeDraft {
  title: string;
  description: string;
  categoryPath: string[];
  images: Array<{ sourceIndex: number }>;
  brand?: string;
  attributes?: Record<string, string | string[]>;
  tierVariationList?: AiTierVariation[];
  modelList?: AiModel[];
  shipping?: AiShippingDraft;
}

export interface AiProductDraftV2 {
  source: FBPostPayload;
  shopee: AiShopeeDraft;
  warnings: string[];
  variantImageBindings: VariantImageBinding[];
  pendingVariantImageBindings: PendingVariantImageBinding[];
}

export interface FillReportV2 {
  successFields: string[];
  failedFields: string[];
  skippedFields: string[];
  warnings: string[];
  pendingActions: string[];
  durationMs: number;
}

export type PipelineDebugLevel = 'info' | 'error';

export interface PipelineDebugEvent {
  atISO: string;
  stage: string;
  level: PipelineDebugLevel;
  message: string;
}

export interface PipelineDebugState {
  runId: string;
  startedAtISO: string;
  endedAtISO?: string;
  currentStage: string;
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  events: PipelineDebugEvent[];
}

export interface PipelineResult {
  fb: FBPostPayload;
  schema: ShopeeSchemaSnapshot;
  draft: AiProductDraftV2;
  report: FillReportV2;
}

export interface OpenAiSettings {
  apiKey: string;
  model: string;
}
