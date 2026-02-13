import type {
  FBImageBase64,
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
  lastFbBase64Images: 'lastFbBase64Images',
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
  // Store base64 images separately to keep the main payload lightweight.
  // This also avoids message passing size limits.
  const typed = payload as { imageBase64List?: FBImageBase64[] } | undefined;
  const base64List = typed?.imageBase64List;

  // Strip base64 from the main payload to avoid bloat in storage reads
  if (typed && Array.isArray(base64List)) {
    const { imageBase64List: _, ...withoutBase64 } = typed;
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastFbPayload]: withoutBase64,
      [STORAGE_KEYS.lastFbBase64Images]: base64List
    });
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS.lastFbPayload]: payload });
  }
}

export async function getLastFbPayload<T>(): Promise<T | null> {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.lastFbPayload, STORAGE_KEYS.lastFbBase64Images]);
  const payload = raw[STORAGE_KEYS.lastFbPayload] as T | undefined;
  if (!payload) return null;

  // Re-attach base64 images if available
  const base64 = raw[STORAGE_KEYS.lastFbBase64Images] as FBImageBase64[] | undefined;
  if (base64?.length) {
    (payload as Record<string, unknown>).imageBase64List = base64;
  }

  return payload;
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
