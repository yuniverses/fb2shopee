import type {
  AiProductDraftV2,
  FBPostPayload,
  FillReportV2,
  PipelineDebugState,
  PipelineResult,
  ShopeeSchemaSnapshot
} from './contracts';

export const MSG = {
  collect_fb_post: 'collect_fb_post',
  collect_shopee_schema: 'collect_shopee_schema',
  generate_ai_draft: 'generate_ai_draft',
  apply_shopee_draft: 'apply_shopee_draft',
  get_fill_report: 'get_fill_report',
  get_pipeline_debug: 'get_pipeline_debug',
  run_pipeline: 'run_pipeline',
  open_shopee_tab: 'open_shopee_tab'
} as const;

export type MessageType = keyof typeof MSG;

export interface CollectFbPostRequest {
  type: typeof MSG.collect_fb_post;
}

export interface CollectFbPostResponse {
  ok: boolean;
  payload?: FBPostPayload;
  error?: string;
}

export interface CollectShopeeSchemaRequest {
  type: typeof MSG.collect_shopee_schema;
}

export interface CollectShopeeSchemaResponse {
  ok: boolean;
  payload?: ShopeeSchemaSnapshot;
  error?: string;
}

export interface GenerateAiDraftRequest {
  type: typeof MSG.generate_ai_draft;
  payload: {
    fb: FBPostPayload;
    schema: ShopeeSchemaSnapshot;
  };
}

export interface GenerateAiDraftResponse {
  ok: boolean;
  payload?: AiProductDraftV2;
  error?: string;
}

export interface ApplyShopeeDraftRequest {
  type: typeof MSG.apply_shopee_draft;
  payload: {
    fb: FBPostPayload;
    draft: AiProductDraftV2;
  };
}

export interface ApplyShopeeDraftResponse {
  ok: boolean;
  payload?: FillReportV2;
  error?: string;
}

export interface GetFillReportRequest {
  type: typeof MSG.get_fill_report;
}

export interface GetFillReportResponse {
  ok: boolean;
  payload?: FillReportV2;
  error?: string;
}

export interface GetPipelineDebugRequest {
  type: typeof MSG.get_pipeline_debug;
}

export interface GetPipelineDebugResponse {
  ok: boolean;
  payload?: PipelineDebugState;
  error?: string;
}

export interface RunPipelineRequest {
  type: typeof MSG.run_pipeline;
}

export interface RunPipelineResponse {
  ok: boolean;
  payload?: PipelineResult;
  error?: string;
}

export interface OpenShopeeTabRequest {
  type: typeof MSG.open_shopee_tab;
}

export interface OpenShopeeTabResponse {
  ok: boolean;
  payload?: {
    tabId: number;
    url: string;
  };
  error?: string;
}

export type AnyRuntimeRequest =
  | CollectFbPostRequest
  | CollectShopeeSchemaRequest
  | GenerateAiDraftRequest
  | ApplyShopeeDraftRequest
  | GetFillReportRequest
  | GetPipelineDebugRequest
  | RunPipelineRequest
  | OpenShopeeTabRequest;

export type AnyRuntimeResponse =
  | CollectFbPostResponse
  | CollectShopeeSchemaResponse
  | GenerateAiDraftResponse
  | ApplyShopeeDraftResponse
  | GetFillReportResponse
  | GetPipelineDebugResponse
  | RunPipelineResponse
  | OpenShopeeTabResponse;
