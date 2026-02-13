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

  // The content script stores base64 images directly in chrome.storage.local
  // (to avoid message passing size limits). Reattach them here.
  const fb = response.payload;
  if (!fb.imageBase64List?.length) {
    try {
      const stored = await chrome.storage.local.get('lastFbBase64Images');
      const base64List = stored.lastFbBase64Images;
      if (Array.isArray(base64List) && base64List.length > 0) {
        fb.imageBase64List = base64List;
      }
    } catch {
      // Storage read failed — will fall back to background image fetch
    }
  }

  await setLastFbPayload(fb);
  return fb;
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
  // CRITICAL: Strip imageBase64List from the message payload.
  // Base64 images can be 50-100+ MB and will exceed Chrome's message passing limits.
  // The Shopee content script reads base64 directly from chrome.storage.local instead.
  const { imageBase64List: _stripFb, ...fbWithoutBase64 } = fb;
  const { imageBase64List: _stripSource, ...sourceWithoutBase64 } = draft.source;
  const draftWithoutBase64: AiProductDraftV2 = {
    ...draft,
    source: { ...sourceWithoutBase64 } as FBPostPayload
  };

  const messagePayload = {
    type: MSG.apply_shopee_draft,
    payload: { fb: fbWithoutBase64 as FBPostPayload, draft: draftWithoutBase64 }
  };

  // Retry up to 2 times — the Shopee content script can lose context
  // (SPA navigation, page reload, etc.) during the long AI generation step.
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await sendTabMessageWithAutoInject<{ ok: boolean; payload?: FillReportV2; error?: string }>(
        tabId,
        messagePayload,
        'content-shopee.js'
      );

      if (!response.ok || !response.payload) {
        throw new Error(response.error || 'Failed to apply draft on Shopee page');
      }

      await setLastReport(response.payload);
      return response.payload;
    } catch (error) {
      lastError = pickErrorMessage(error);
      // If the channel closed or the receiver doesn't exist, re-inject and retry
      if (attempt < 2 && /message channel closed|Receiving end does not exist|Could not establish connection/i.test(lastError)) {
        // Force re-inject the content script
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-shopee.js']
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch {
          // Injection failed — tab may have navigated away
        }
        continue;
      }
      throw error;
    }
  }

  throw new Error(lastError || 'Failed to apply draft on Shopee page');
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

    // Wait for the injected script to execute and register its listener
    await new Promise((resolve) => setTimeout(resolve, 300));

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

// ---------------------------------------------------------------------------
// Pipeline cancellation support
// ---------------------------------------------------------------------------

let pipelineAbortController: AbortController | null = null;

class PipelineCancelledError extends Error {
  constructor() {
    super('Pipeline cancelled by user');
    this.name = 'PipelineCancelledError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PipelineCancelledError();
  }
}

/**
 * Keep the MV3 service worker alive during long-running operations.
 * Chrome kills idle service workers after ~30s.  We use multiple
 * complementary strategies:
 *  1. Periodic chrome.storage.session writes (counts as API activity)
 *  2. Periodic chrome.runtime.getPlatformInfo() calls (chrome API call = activity)
 *  3. Short interval (25s) to stay well within the 30s idle timeout
 */
function createKeepalive(): { stop: () => void } {
  const storageTimer = setInterval(() => {
    void chrome.storage.session?.set({ _keepalive: Date.now() }).catch(() => {});
  }, 25000);
  const apiTimer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  return {
    stop: () => {
      clearInterval(storageTimer);
      clearInterval(apiTimer);
    }
  };
}

async function runPipeline(): Promise<PipelineResult> {
  const debug = createInitialDebugState();
  const keepalive = createKeepalive();
  pipelineAbortController = new AbortController();
  const signal = pipelineAbortController.signal;
  await appendDebug(debug, 'init', 'Pipeline started');

  try {
    // Stage 1: Collect FB post
    throwIfAborted(signal);
    await appendDebug(debug, MSG.collect_fb_post, 'Collecting FB post from active tab');
    const settings = await getOpenAiSettings();
    if (!settings?.apiKey) {
      throw new Error('OpenAI API key not set. Please open extension options to configure.');
    }

    const fb = await collectFbFromActiveTab();
    throwIfAborted(signal);
    await appendDebug(
      debug,
      MSG.collect_fb_post,
      `FB collected: ${fb.imageUrlsOrdered.length} image(s), text length ${fb.postText.length}`
    );

    // Stage 2: Open/activate Shopee tab
    throwIfAborted(signal);
    await appendDebug(debug, MSG.open_shopee_tab, 'Opening/activating Shopee new product tab');
    const shopeeTab = await ensureShopeeTab();
    await waitForTabComplete(shopeeTab.id!);

    // Stage 3: Collect Shopee schema
    throwIfAborted(signal);
    await appendDebug(debug, MSG.collect_shopee_schema, 'Collecting Shopee schema snapshot');
    const schema = await collectShopeeSchemaFromTab(shopeeTab.id!);
    await appendDebug(
      debug,
      MSG.collect_shopee_schema,
      `Schema ready: ${schema.fields.length} field(s), version ${schema.version}`
    );

    // Stage 4: Generate AI draft (pass abort signal for mid-flight cancellation)
    throwIfAborted(signal);
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
      },
      signal
    );

    throwIfAborted(signal);
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

    // Stage 5: Apply draft to Shopee form
    throwIfAborted(signal);
    await appendDebug(debug, MSG.apply_shopee_draft, 'Applying draft into Shopee form');
    // Re-verify the Shopee tab is still ready (it might have changed during the AI call)
    await waitForTabComplete(shopeeTab.id!);
    const report = await applyDraftToShopeeTab(shopeeTab.id!, fb, draftWithWarnings);
    const reportDetails = [
      `success=[${report.successFields.join(',')}]`,
      report.failedFields.length ? `failed=[${report.failedFields.join(',')}]` : '',
      report.skippedFields.length ? `skipped=[${report.skippedFields.join(',')}]` : '',
      report.warnings.length ? `warnings: ${report.warnings.slice(0, 3).join('; ')}` : '',
      report.pendingActions.length ? `pending: ${report.pendingActions.slice(0, 3).join('; ')}` : ''
    ].filter(Boolean).join(' | ');
    await appendDebug(
      debug,
      MSG.apply_shopee_draft,
      `Autofill finished: ${report.successFields.length} success, ${report.failedFields.length} failed | ${reportDetails}`
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
    if (error instanceof PipelineCancelledError) {
      await appendDebug(debug, 'cancelled', 'Pipeline cancelled by user');
      debug.cancelled = true;
      await finalizeDebug(debug, false, 'Cancelled');
      throw error;
    }
    const message = pickErrorMessage(error);
    await appendDebug(debug, 'failed', message, 'error');
    await finalizeDebug(debug, false, message);
    throw error;
  } finally {
    pipelineAbortController = null;
    keepalive.stop();
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

      if (message.type === MSG.cancel_pipeline) {
        if (pipelineAbortController) {
          pipelineAbortController.abort();
          sendResponse({ ok: true } satisfies AnyRuntimeResponse);
        } else {
          sendResponse({ ok: false, error: 'No pipeline running' } satisfies AnyRuntimeResponse);
        }
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
