import type {
  FillReportV2,
  OpenAiSettings,
  PipelineDebugState,
  ShopeeSchemaSnapshot
} from './contracts';

const STORAGE_KEYS = {
  openAiSettings: 'openAiSettings',
  lastSchema: 'lastSchema',
  lastReport: 'lastReport',
  lastFbPayload: 'lastFbPayload',
  lastAiDraft: 'lastAiDraft',
  lastPipelineDebug: 'lastPipelineDebug'
} as const;

export async function getOpenAiSettings(): Promise<OpenAiSettings | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.openAiSettings);
  const value = raw[STORAGE_KEYS.openAiSettings] as OpenAiSettings | undefined;
  return value ?? null;
}

export async function setOpenAiSettings(settings: OpenAiSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.openAiSettings]: settings });
}

export async function clearOpenAiKey(): Promise<void> {
  const current = await getOpenAiSettings();
  if (!current) {
    return;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.openAiSettings]: { ...current, apiKey: '' }
  });
}

export async function setLastSchema(schema: ShopeeSchemaSnapshot): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastSchema]: schema });
}

export async function getLastSchema(): Promise<ShopeeSchemaSnapshot | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.lastSchema);
  return (raw[STORAGE_KEYS.lastSchema] as ShopeeSchemaSnapshot | undefined) ?? null;
}

export async function setLastReport(report: FillReportV2): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastReport]: report });
}

export async function getLastReport(): Promise<FillReportV2 | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.lastReport);
  return (raw[STORAGE_KEYS.lastReport] as FillReportV2 | undefined) ?? null;
}

export async function setLastFbPayload(payload: unknown): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastFbPayload]: payload });
}

export async function getLastFbPayload<T>(): Promise<T | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.lastFbPayload);
  return (raw[STORAGE_KEYS.lastFbPayload] as T | undefined) ?? null;
}

export async function setLastAiDraft(draft: unknown): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastAiDraft]: draft });
}

export async function getLastAiDraft<T>(): Promise<T | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.lastAiDraft);
  return (raw[STORAGE_KEYS.lastAiDraft] as T | undefined) ?? null;
}

export async function setLastPipelineDebug(debug: PipelineDebugState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastPipelineDebug]: debug });
}

export async function getLastPipelineDebug(): Promise<PipelineDebugState | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.lastPipelineDebug);
  return (raw[STORAGE_KEYS.lastPipelineDebug] as PipelineDebugState | undefined) ?? null;
}

export { STORAGE_KEYS };
