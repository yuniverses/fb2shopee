import type {
  CancelPipelineResponse,
  CollectFbPostResponse,
  GetPipelineDebugResponse,
  OpenShopeeTabResponse,
  RunPipelineResponse
} from '@shared/messages';
import { MSG } from '@shared/messages';

const runBtn = document.getElementById('runPipeline') as HTMLButtonElement;
const collectBtn = document.getElementById('collectOnly') as HTMLButtonElement;
const openShopeeBtn = document.getElementById('openShopee') as HTMLButtonElement;
const openOptionsBtn = document.getElementById('openOptions') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const metaEl = document.getElementById('meta') as HTMLDivElement;
const imagePreviewEl = document.getElementById('imagePreview') as HTMLDivElement;
const imageCountEl = document.getElementById('imageCount') as HTMLSpanElement;
const imageGridEl = document.getElementById('imageGrid') as HTMLDivElement;
const debugEl = document.getElementById('debug') as HTMLDivElement;
const progressLabelEl = document.getElementById('progressLabel') as HTMLSpanElement;
const progressValueEl = document.getElementById('progressValue') as HTMLSpanElement;
const progressFillEl = document.getElementById('progressFill') as HTMLDivElement;
let debugPollTimer: number | null = null;
let pipelineRunning = false;

function renderImagePreview(urls: string[]): void {
  imageGridEl.innerHTML = '';
  if (!urls.length) {
    imagePreviewEl.classList.remove('visible');
    return;
  }
  imagePreviewEl.classList.add('visible');
  imageCountEl.textContent = `${urls.length} 張`;

  for (let i = 0; i < urls.length; i += 1) {
    const item = document.createElement('div');
    item.className = 'image-grid-item';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `${i + 1}`;
    item.appendChild(idx);

    const img = document.createElement('img');
    img.src = urls[i];
    img.loading = 'lazy';
    img.alt = `FB image ${i + 1}`;
    img.onerror = () => {
      img.remove();
      const fail = document.createElement('span');
      fail.className = 'fail';
      fail.textContent = `#${i + 1} failed`;
      item.appendChild(fail);
    };
    item.appendChild(img);
    imageGridEl.appendChild(item);
  }
}

function setBusy(busy: boolean): void {
  pipelineRunning = busy;
  if (busy) {
    // Run button becomes a stop button (red, stays enabled)
    runBtn.textContent = '\u23F9 \u505C\u6B62';
    runBtn.classList.add('stop');
    runBtn.disabled = false;
    // Disable other buttons
    for (const btn of [collectBtn, openShopeeBtn, openOptionsBtn]) {
      btn.disabled = true;
    }
  } else {
    // Restore run button
    runBtn.textContent = 'Run One-Click';
    runBtn.classList.remove('stop');
    runBtn.disabled = false;
    for (const btn of [collectBtn, openShopeeBtn, openOptionsBtn]) {
      btn.disabled = false;
    }
  }
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setMeta(text: string): void {
  metaEl.textContent = text;
}

function pickError(result: unknown, fallback = 'Request failed'): string {
  if (typeof result === 'object' && result && 'error' in result) {
    const error = (result as { error?: unknown }).error;
    if (typeof error === 'string' && error) {
      return error;
    }
  }
  return fallback;
}

async function sendMessage<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function stageToLabel(stage: string): string {
  switch (stage) {
    case 'init':
      return '初始化';
    case MSG.collect_fb_post:
      return '抓取 FB 貼文';
    case MSG.open_shopee_tab:
      return '切換 Shopee 頁面';
    case MSG.collect_shopee_schema:
      return '讀取 Shopee 欄位';
    case MSG.generate_ai_draft:
      return 'AI 生成文案與規格';
    case MSG.apply_shopee_draft:
      return '填寫 Shopee 表單';
    case 'completed':
      return '完成';
    case 'failed':
      return '失敗';
    case 'cancelled':
      return '已取消';
    default:
      return stage;
  }
}

function baseProgressByStage(stage: string): number {
  switch (stage) {
    case 'init':
      return 5;
    case MSG.collect_fb_post:
      return 20;
    case MSG.open_shopee_tab:
      return 35;
    case MSG.collect_shopee_schema:
      return 50;
    case MSG.generate_ai_draft:
      return 65;
    case MSG.apply_shopee_draft:
      return 88;
    case 'completed':
      return 100;
    default:
      return 8;
  }
}

function aiSubProgress(events: Array<{ stage: string; message: string }>): number {
  const aiEvents = events.filter((item) => item.stage === MSG.generate_ai_draft);
  const latest = aiEvents[aiEvents.length - 1];
  if (!latest) {
    return 65;
  }

  const prepare = latest.message.match(/Preparing images\s+(\d+)\/(\d+)/i);
  if (prepare?.[1] && prepare?.[2]) {
    const current = Number(prepare[1]);
    const total = Number(prepare[2]);
    if (total > 0) {
      return 66 + Math.round((current / total) * 10);
    }
  }

  const resolved = latest.message.match(/Resolved\s+(\d+)\/(\d+)\s+images/i);
  if (resolved) {
    return 77;
  }

  const attempt = latest.message.match(/attempt\s+(\d+)\/(\d+)/i);
  if (attempt?.[1] && attempt?.[2]) {
    const current = Number(attempt[1]);
    const total = Number(attempt[2]);
    if (total > 0) {
      return 78 + Math.round(((current - 1) / total) * 8);
    }
  }

  if (/response received/i.test(latest.message)) {
    return 88;
  }

  if (/validated/i.test(latest.message)) {
    return 92;
  }

  return 70;
}

function updateProgressUi(
  value: number,
  label: string,
  mode: 'idle' | 'running' | 'done' | 'error'
): void {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  progressLabelEl.textContent = label;
  progressValueEl.textContent = `${clamped}%`;
  progressFillEl.style.width = `${clamped}%`;
  progressFillEl.classList.remove('running', 'done', 'error');
  if (mode === 'running') {
    progressFillEl.classList.add('running');
  } else if (mode === 'done') {
    progressFillEl.classList.add('done');
  } else if (mode === 'error') {
    progressFillEl.classList.add('error');
  }
}

async function refreshDebugPanel(): Promise<void> {
  try {
    const result = await sendMessage<GetPipelineDebugResponse>({ type: MSG.get_pipeline_debug });
    if (!result.ok || !result.payload) {
      debugEl.textContent = 'No debug logs yet.';
      updateProgressUi(0, 'Waiting', 'idle');
      return;
    }

    const payload = result.payload;
    const statusLabel = !payload.endedAtISO
      ? 'RUNNING'
      : payload.cancelled
        ? 'CANCELLED'
        : payload.ok
          ? 'OK'
          : 'FAILED';
    const header = [
      `Run: ${payload.runId}`,
      `Stage: ${payload.currentStage}`,
      `Status: ${statusLabel}`,
      `Started: ${payload.startedAtISO}`,
      payload.endedAtISO ? `Ended: ${payload.endedAtISO}` : 'Ended: (running)',
      payload.error ? `Error: ${payload.error}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const recentEvents = payload.events
      .slice(-8)
      .map((item) => `[${item.level}] ${item.stage} @ ${item.atISO}\n${item.message}`)
      .join('\n\n');

    debugEl.textContent = `${header}\n\n${recentEvents || 'No events.'}`;

    const label = stageToLabel(payload.currentStage);
    const running = !payload.endedAtISO;
    let progress = baseProgressByStage(payload.currentStage);
    let mode: 'idle' | 'running' | 'done' | 'error' = 'idle';

    if (payload.currentStage === MSG.generate_ai_draft) {
      progress = aiSubProgress(payload.events);
    }

    if (running) {
      mode = 'running';
    } else if (payload.ok) {
      progress = 100;
      mode = 'done';
    } else {
      mode = 'error';
    }

    updateProgressUi(progress, label, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load debug panel';
    debugEl.textContent = `Debug panel error: ${message}`;
    updateProgressUi(0, 'Debug error', 'error');
  }
}

function startDebugPolling(): void {
  if (debugPollTimer !== null) {
    window.clearInterval(debugPollTimer);
  }
  debugPollTimer = window.setInterval(() => {
    void refreshDebugPanel();
  }, 1000);
}

function stopDebugPolling(): void {
  if (debugPollTimer !== null) {
    window.clearInterval(debugPollTimer);
    debugPollTimer = null;
  }
}

async function cancelPipeline(): Promise<void> {
  setStatus('Cancelling...');
  try {
    const result = await sendMessage<CancelPipelineResponse>({ type: MSG.cancel_pipeline });
    if (!result.ok) {
      setStatus('Cancel failed: ' + (result.error ?? 'unknown'));
    }
    // The runPipeline() promise will resolve/reject and handle cleanup
  } catch {
    setStatus('Cancel request failed');
  }
}

async function runPipeline(): Promise<void> {
  setBusy(true);
  setStatus('Running: FB collect → schema → AI draft → Shopee autofill...');
  setMeta('');
  updateProgressUi(5, '初始化', 'running');
  startDebugPolling();

  try {
    const result = await sendMessage<RunPipelineResponse>({ type: MSG.run_pipeline });
    if (!result.ok || !result.payload) {
      throw new Error(pickError(result, 'Pipeline execution failed'));
    }

    const { fb, draft, report } = result.payload;
    const pendingCount = report.pendingActions.length;

    setStatus(
      [
        `Done. Success fields: ${report.successFields.length}`,
        `Failed fields: ${report.failedFields.length}`,
        `Pending actions: ${pendingCount}`
      ].join('\n')
    );

    const metaParts = [
      `FB images: ${fb.imageUrlsOrdered.length}`,
      `Draft images: ${draft.shopee.images.length}`,
      `Category: ${draft.shopee.categoryPath.join(' > ')}`,
      `Duration: ${report.durationMs} ms`
    ];

    // Variant image binding stats (F2)
    const boundCount = draft.variantImageBindings.length;
    const pendingCount2 = draft.pendingVariantImageBindings.length;
    if (boundCount > 0 || pendingCount2 > 0) {
      metaParts.push(`Variant images: ${boundCount} bound, ${pendingCount2} pending`);
    }

    setMeta(metaParts.join(' | '));
    renderImagePreview(fb.imageUrlsOrdered);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pipeline execution failed';
    const isCancelled = message.includes('cancelled') || message.includes('Cancelled');
    setStatus(isCancelled ? 'Pipeline cancelled by user.' : `Error: ${message}`);
    setMeta('');
  } finally {
    stopDebugPolling();
    await refreshDebugPanel();
    setBusy(false);
  }
}

async function collectFbOnly(): Promise<void> {
  setBusy(true);
  setStatus('Collecting FB post from current tab...');
  setMeta('');

  try {
    const result = await sendMessage<CollectFbPostResponse>({ type: MSG.collect_fb_post });
    if (!result.ok || !result.payload) {
      throw new Error(pickError(result, 'Failed to collect FB post'));
    }

    setStatus('FB post collected. You can now run one-click import.');
    setMeta(`Images: ${result.payload.imageUrlsOrdered.length} | URL: ${result.payload.postUrl}`);
    renderImagePreview(result.payload.imageUrlsOrdered);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to collect FB post';
    setStatus(`Error: ${message}`);
    setMeta('');
  } finally {
    await refreshDebugPanel();
    setBusy(false);
  }
}

async function openShopeeTab(): Promise<void> {
  setBusy(true);
  setStatus('Opening Shopee new product page...');

  try {
    const result = await sendMessage<OpenShopeeTabResponse>({ type: MSG.open_shopee_tab });
    if (!result.ok || !result.payload) {
      throw new Error(pickError(result, 'Failed to open Shopee tab'));
    }

    setStatus('Shopee tab ready.');
    setMeta(`Tab ID: ${result.payload.tabId} | URL: ${result.payload.url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open Shopee tab';
    setStatus(`Error: ${message}`);
  } finally {
    await refreshDebugPanel();
    setBusy(false);
  }
}

function bindEvents(): void {
  runBtn.addEventListener('click', () => {
    if (pipelineRunning) {
      void cancelPipeline();
    } else {
      void runPipeline();
    }
  });

  collectBtn.addEventListener('click', () => {
    void collectFbOnly();
  });

  openShopeeBtn.addEventListener('click', () => {
    void openShopeeTab();
  });

  openOptionsBtn.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });
}

bindEvents();
void refreshDebugPanel();
