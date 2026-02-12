import { DEFAULT_OPENAI_MODEL, SCHEMA_MAX_AGE_MS, SHOPEE_NEW_PRODUCT_URL } from '@shared/constants';
import type {
  AiProductDraftV2,
  FBPostPayload,
  FillReportV2,
  PipelineDebugState,
  PipelineResult,
  ShopeeSchemaSnapshot
} from '@shared/contracts';
import { MSG, type AnyRuntimeRequest, type AnyRuntimeResponse } from '@shared/messages';
import {
  clearOpenAiKey,
  getLastAiDraft,
  getLastFbPayload,
  getLastPipelineDebug,
  getLastSchema,
  getLastReport,
  getOpenAiSettings,
  setLastAiDraft,
  setLastFbPayload,
  setLastPipelineDebug,
  setLastReport,
  setLastSchema,
  setOpenAiSettings
} from '@shared/storage';
import {
  nowIso,
  pickErrorMessage,
  queryActiveTab,
  sendTabMessage,
  waitForTabComplete
} from '@shared/runtime';
import { generateAiDraft } from './openai';

function isShopeeNewProductUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname === 'seller.shopee.tw' && parsed.pathname.startsWith('/portal/product/new');
  } catch {
    return false;
  }
}

async function ensureShopeeTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: ['https://seller.shopee.tw/*'] });
  const existing = tabs.find((tab) => isShopeeNewProductUrl(tab.url)) ?? tabs[0];

  if (existing?.id) {
    const needsNavigate = !isShopeeNewProductUrl(existing.url);
    const updated = await chrome.tabs.update(existing.id, {
      active: true,
      ...(needsNavigate ? { url: SHOPEE_NEW_PRODUCT_URL } : {})
    });
    if (!updated?.id) {
      throw new Error('Failed to activate Shopee tab');
    }
    await waitForTabComplete(existing.id);
    return updated;
  }

  const tab = await chrome.tabs.create({
    url: SHOPEE_NEW_PRODUCT_URL,
    active: true
  });

  if (!tab.id) {
    throw new Error('Failed to create Shopee tab');
  }

  await waitForTabComplete(tab.id);
  return tab;
}

function isFacebookGroupUrl(url: string | undefined): boolean {
  return Boolean(url && url.startsWith('https://www.facebook.com/groups/'));
}

async function collectFbFromActiveTab(): Promise<FBPostPayload> {
  const activeTab = await queryActiveTab();
  if (!isFacebookGroupUrl(activeTab.url)) {
    throw new Error('Active tab is not an FB group page');
  }

  const response = await sendTabMessageWithAutoInject<
    { ok: boolean; payload?: FBPostPayload; error?: string }
  >(
    activeTab.id!,
    { type: MSG.collect_fb_post },
    'content-facebook.js'
  );

  if (!response.ok || !response.payload) {
    throw new Error(response.error || 'Failed to collect FB post');
  }

  await setLastFbPayload(response.payload);
  return response.payload;
}

async function collectShopeeSchemaFromTab(tabId: number): Promise<ShopeeSchemaSnapshot> {
  const cached = await getLastSchema();
  const cachedAge = cached ? Date.now() - Date.parse(cached.capturedAtISO) : Number.POSITIVE_INFINITY;
  if (cached && Number.isFinite(cachedAge) && cachedAge < SCHEMA_MAX_AGE_MS && cached.fields.length > 0) {
    return cached;
  }

  const response = await sendTabMessageWithAutoInject<
    { ok: boolean; payload?: ShopeeSchemaSnapshot; error?: string }
  >(
    tabId,
    { type: MSG.collect_shopee_schema },
    'content-shopee.js'
  );

  if (!response.ok || !response.payload) {
    throw new Error(response.error || 'Failed to collect Shopee schema');
  }

  await setLastSchema(response.payload);
  return response.payload;
}

async function applyDraftToShopeeTab(
  tabId: number,
  fb: FBPostPayload,
  draft: AiProductDraftV2
): Promise<FillReportV2> {
  const response = await sendTabMessageWithAutoInject<{ ok: boolean; payload?: FillReportV2; error?: string }>(
    tabId,
    {
      type: MSG.apply_shopee_draft,
      payload: { fb, draft }
    },
    'content-shopee.js'
  );

  if (!response.ok || !response.payload) {
    throw new Error(response.error || 'Failed to apply draft on Shopee page');
  }

  await setLastReport(response.payload);
  return response.payload;
}

function isMissingReceiverError(error: unknown): boolean {
  const message = pickErrorMessage(error);
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

async function sendTabMessageWithAutoInject<T>(
  tabId: number,
  message: unknown,
  contentScriptFile: 'content-facebook.js' | 'content-shopee.js'
): Promise<T> {
  try {
    return await sendTabMessage<T>(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [contentScriptFile]
    });

    return sendTabMessage<T>(tabId, message);
  }
}

function createInitialDebugState(): PipelineDebugState {
  return {
    runId: `${Date.now()}`,
    startedAtISO: nowIso(),
    currentStage: 'init',
    ok: false,
    events: []
  };
}

async function appendDebug(
  debug: PipelineDebugState,
  stage: string,
  message: string,
  level: 'info' | 'error' = 'info'
): Promise<void> {
  debug.currentStage = stage;
  debug.events.push({
    atISO: nowIso(),
    stage,
    level,
    message
  });
  await setLastPipelineDebug(debug);
}

async function finalizeDebug(debug: PipelineDebugState, ok: boolean, error?: string): Promise<void> {
  debug.ok = ok;
  debug.error = error;
  debug.endedAtISO = nowIso();
  await setLastPipelineDebug(debug);
}

async function runPipeline(): Promise<PipelineResult> {
  const debug = createInitialDebugState();
  await appendDebug(debug, 'init', 'Pipeline started');

  try {
    await appendDebug(debug, MSG.collect_fb_post, 'Collecting FB post from active tab');
    const settings = await getOpenAiSettings();
    if (!settings?.apiKey) {
      throw new Error('OpenAI API key not set. Please open extension options to configure.');
    }

    const fb = await collectFbFromActiveTab();
    await appendDebug(
      debug,
      MSG.collect_fb_post,
      `FB collected: ${fb.imageUrlsOrdered.length} image(s), text length ${fb.postText.length}`
    );

    await appendDebug(debug, MSG.open_shopee_tab, 'Opening/activating Shopee new product tab');
    const shopeeTab = await ensureShopeeTab();
    await waitForTabComplete(shopeeTab.id!);

    await appendDebug(debug, MSG.collect_shopee_schema, 'Collecting Shopee schema snapshot');
    const schema = await collectShopeeSchemaFromTab(shopeeTab.id!);
    await appendDebug(
      debug,
      MSG.collect_shopee_schema,
      `Schema ready: ${schema.fields.length} field(s), version ${schema.version}`
    );

    await appendDebug(debug, MSG.generate_ai_draft, 'Calling OpenAI to generate listing draft');
    const ai = await generateAiDraft(
      {
        apiKey: settings.apiKey,
        model: settings.model || DEFAULT_OPENAI_MODEL
      },
      fb,
      schema,
      async (message) => {
        await appendDebug(debug, MSG.generate_ai_draft, message);
      }
    );

    const draftWithWarnings: AiProductDraftV2 = {
      ...ai.draft,
      warnings: [...(ai.draft.warnings || []), ...ai.warnings]
    };

    await setLastAiDraft(draftWithWarnings);
    await appendDebug(
      debug,
      MSG.generate_ai_draft,
      `AI draft ready: ${draftWithWarnings.shopee.images.length} image refs, ${draftWithWarnings.shopee.modelList?.length || 0} model(s)`
    );

    await appendDebug(debug, MSG.apply_shopee_draft, 'Applying draft into Shopee form');
    const report = await applyDraftToShopeeTab(shopeeTab.id!, fb, draftWithWarnings);
    await appendDebug(
      debug,
      MSG.apply_shopee_draft,
      `Autofill finished: ${report.successFields.length} success, ${report.failedFields.length} failed`
    );

    await appendDebug(debug, 'completed', 'Pipeline completed');
    await finalizeDebug(debug, true);

    return {
      fb,
      schema,
      draft: draftWithWarnings,
      report
    };
  } catch (error) {
    const message = pickErrorMessage(error);
    await appendDebug(debug, 'failed', message, 'error');
    await finalizeDebug(debug, false, message);
    throw error;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getOpenAiSettings();
  if (!settings) {
    await setOpenAiSettings({
      apiKey: '',
      model: DEFAULT_OPENAI_MODEL
    });
  }
});

chrome.runtime.onMessage.addListener((message: AnyRuntimeRequest, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message.type === MSG.collect_fb_post) {
        const payload = await collectFbFromActiveTab();
        sendResponse({ ok: true, payload } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.collect_shopee_schema) {
        const shopeeTab = await ensureShopeeTab();
        const payload = await collectShopeeSchemaFromTab(shopeeTab.id!);
        sendResponse({ ok: true, payload } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.generate_ai_draft) {
        const settings = await getOpenAiSettings();
        if (!settings?.apiKey) {
          throw new Error('OpenAI API key not configured');
        }

        const payload = await generateAiDraft(settings, message.payload.fb, message.payload.schema);
        const draftWithWarnings: AiProductDraftV2 = {
          ...payload.draft,
          warnings: [...(payload.draft.warnings || []), ...payload.warnings]
        };
        await setLastAiDraft(draftWithWarnings);
        sendResponse({ ok: true, payload: draftWithWarnings } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.apply_shopee_draft) {
        const shopeeTab = await ensureShopeeTab();
        const payload = await applyDraftToShopeeTab(
          shopeeTab.id!,
          message.payload.fb,
          message.payload.draft
        );
        sendResponse({ ok: true, payload } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.get_fill_report) {
        const payload = await getLastReport();
        sendResponse({ ok: true, payload: payload ?? undefined } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.get_pipeline_debug) {
        const payload = await getLastPipelineDebug();
        sendResponse({ ok: true, payload: payload ?? undefined } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.open_shopee_tab) {
        const tab = await ensureShopeeTab();
        sendResponse({
          ok: true,
          payload: {
            tabId: tab.id!,
            url: tab.url || SHOPEE_NEW_PRODUCT_URL
          }
        } satisfies AnyRuntimeResponse);
        return;
      }

      if (message.type === MSG.run_pipeline) {
        const payload = await runPipeline();
        sendResponse({ ok: true, payload } satisfies AnyRuntimeResponse);
        return;
      }

      throw new Error(`Unsupported message type: ${(message as { type?: string }).type ?? 'unknown'}`);
    } catch (error) {
      sendResponse({
        ok: false,
        error: pickErrorMessage(error)
      } satisfies AnyRuntimeResponse);
    }
  })();

  return true;
});

// Keep exported for tests and easier introspection.
export const __background = {
  ensureShopeeTab,
  collectFbFromActiveTab,
  runPipeline,
  clearOpenAiKey,
  getLastAiDraft,
  getLastFbPayload,
  getLastPipelineDebug
};
