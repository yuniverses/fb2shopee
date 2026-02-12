"use strict";
(() => {
  // src/shared/messages.ts
  var MSG = {
    collect_fb_post: "collect_fb_post",
    collect_shopee_schema: "collect_shopee_schema",
    generate_ai_draft: "generate_ai_draft",
    apply_shopee_draft: "apply_shopee_draft",
    get_fill_report: "get_fill_report",
    get_pipeline_debug: "get_pipeline_debug",
    run_pipeline: "run_pipeline",
    open_shopee_tab: "open_shopee_tab"
  };

  // src/popup/index.ts
  var runBtn = document.getElementById("runPipeline");
  var collectBtn = document.getElementById("collectOnly");
  var openShopeeBtn = document.getElementById("openShopee");
  var openOptionsBtn = document.getElementById("openOptions");
  var statusEl = document.getElementById("status");
  var metaEl = document.getElementById("meta");
  var imagePreviewEl = document.getElementById("imagePreview");
  var imageCountEl = document.getElementById("imageCount");
  var imageGridEl = document.getElementById("imageGrid");
  var debugEl = document.getElementById("debug");
  var progressLabelEl = document.getElementById("progressLabel");
  var progressValueEl = document.getElementById("progressValue");
  var progressFillEl = document.getElementById("progressFill");
  var debugPollTimer = null;
  function renderImagePreview(urls) {
    imageGridEl.innerHTML = "";
    if (!urls.length) {
      imagePreviewEl.classList.remove("visible");
      return;
    }
    imagePreviewEl.classList.add("visible");
    imageCountEl.textContent = `${urls.length} \u5F35`;
    for (let i = 0; i < urls.length; i += 1) {
      const item = document.createElement("div");
      item.className = "image-grid-item";
      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = `${i + 1}`;
      item.appendChild(idx);
      const img = document.createElement("img");
      img.src = urls[i];
      img.loading = "lazy";
      img.alt = `FB image ${i + 1}`;
      img.onerror = () => {
        img.remove();
        const fail = document.createElement("span");
        fail.className = "fail";
        fail.textContent = `#${i + 1} failed`;
        item.appendChild(fail);
      };
      item.appendChild(img);
      imageGridEl.appendChild(item);
    }
  }
  function setBusy(busy) {
    for (const btn of [runBtn, collectBtn, openShopeeBtn, openOptionsBtn]) {
      btn.disabled = busy;
    }
  }
  function setStatus(text) {
    statusEl.textContent = text;
  }
  function setMeta(text) {
    metaEl.textContent = text;
  }
  function pickError(result, fallback = "Request failed") {
    if (typeof result === "object" && result && "error" in result) {
      const error = result.error;
      if (typeof error === "string" && error) {
        return error;
      }
    }
    return fallback;
  }
  async function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }
  function stageToLabel(stage) {
    switch (stage) {
      case "init":
        return "\u521D\u59CB\u5316";
      case MSG.collect_fb_post:
        return "\u6293\u53D6 FB \u8CBC\u6587";
      case MSG.open_shopee_tab:
        return "\u5207\u63DB Shopee \u9801\u9762";
      case MSG.collect_shopee_schema:
        return "\u8B80\u53D6 Shopee \u6B04\u4F4D";
      case MSG.generate_ai_draft:
        return "AI \u751F\u6210\u6587\u6848\u8207\u898F\u683C";
      case MSG.apply_shopee_draft:
        return "\u586B\u5BEB Shopee \u8868\u55AE";
      case "completed":
        return "\u5B8C\u6210";
      case "failed":
        return "\u5931\u6557";
      default:
        return stage;
    }
  }
  function baseProgressByStage(stage) {
    switch (stage) {
      case "init":
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
      case "completed":
        return 100;
      default:
        return 8;
    }
  }
  function aiSubProgress(events) {
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
        return 66 + Math.round(current / total * 10);
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
        return 78 + Math.round((current - 1) / total * 8);
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
  function updateProgressUi(value, label, mode) {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    progressLabelEl.textContent = label;
    progressValueEl.textContent = `${clamped}%`;
    progressFillEl.style.width = `${clamped}%`;
    progressFillEl.classList.remove("running", "done", "error");
    if (mode === "running") {
      progressFillEl.classList.add("running");
    } else if (mode === "done") {
      progressFillEl.classList.add("done");
    } else if (mode === "error") {
      progressFillEl.classList.add("error");
    }
  }
  async function refreshDebugPanel() {
    try {
      const result = await sendMessage({ type: MSG.get_pipeline_debug });
      if (!result.ok || !result.payload) {
        debugEl.textContent = "No debug logs yet.";
        updateProgressUi(0, "Waiting", "idle");
        return;
      }
      const payload = result.payload;
      const statusLabel = !payload.endedAtISO ? "RUNNING" : payload.ok ? "OK" : "FAILED";
      const header = [
        `Run: ${payload.runId}`,
        `Stage: ${payload.currentStage}`,
        `Status: ${statusLabel}`,
        `Started: ${payload.startedAtISO}`,
        payload.endedAtISO ? `Ended: ${payload.endedAtISO}` : "Ended: (running)",
        payload.error ? `Error: ${payload.error}` : ""
      ].filter(Boolean).join("\n");
      const recentEvents = payload.events.slice(-8).map((item) => `[${item.level}] ${item.stage} @ ${item.atISO}
${item.message}`).join("\n\n");
      debugEl.textContent = `${header}

${recentEvents || "No events."}`;
      const label = stageToLabel(payload.currentStage);
      const running = !payload.endedAtISO;
      let progress = baseProgressByStage(payload.currentStage);
      let mode = "idle";
      if (payload.currentStage === MSG.generate_ai_draft) {
        progress = aiSubProgress(payload.events);
      }
      if (running) {
        mode = "running";
      } else if (payload.ok) {
        progress = 100;
        mode = "done";
      } else {
        mode = "error";
      }
      updateProgressUi(progress, label, mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load debug panel";
      debugEl.textContent = `Debug panel error: ${message}`;
      updateProgressUi(0, "Debug error", "error");
    }
  }
  function startDebugPolling() {
    if (debugPollTimer !== null) {
      window.clearInterval(debugPollTimer);
    }
    debugPollTimer = window.setInterval(() => {
      void refreshDebugPanel();
    }, 1e3);
  }
  function stopDebugPolling() {
    if (debugPollTimer !== null) {
      window.clearInterval(debugPollTimer);
      debugPollTimer = null;
    }
  }
  async function runPipeline() {
    setBusy(true);
    setStatus("Running: FB collect \u2192 schema \u2192 AI draft \u2192 Shopee autofill...");
    setMeta("");
    updateProgressUi(5, "\u521D\u59CB\u5316", "running");
    startDebugPolling();
    try {
      const result = await sendMessage({ type: MSG.run_pipeline });
      if (!result.ok || !result.payload) {
        throw new Error(pickError(result, "Pipeline execution failed"));
      }
      const { fb, draft, report } = result.payload;
      const pendingCount = report.pendingActions.length;
      setStatus(
        [
          `Done. Success fields: ${report.successFields.length}`,
          `Failed fields: ${report.failedFields.length}`,
          `Pending actions: ${pendingCount}`
        ].join("\n")
      );
      setMeta(
        [
          `FB images: ${fb.imageUrlsOrdered.length}`,
          `Draft images: ${draft.shopee.images.length}`,
          `Category: ${draft.shopee.categoryPath.join(" > ")}`,
          `Duration: ${report.durationMs} ms`
        ].join(" | ")
      );
      renderImagePreview(fb.imageUrlsOrdered);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pipeline execution failed";
      setStatus(`Error: ${message}`);
      setMeta("");
    } finally {
      stopDebugPolling();
      await refreshDebugPanel();
      setBusy(false);
    }
  }
  async function collectFbOnly() {
    setBusy(true);
    setStatus("Collecting FB post from current tab...");
    setMeta("");
    try {
      const result = await sendMessage({ type: MSG.collect_fb_post });
      if (!result.ok || !result.payload) {
        throw new Error(pickError(result, "Failed to collect FB post"));
      }
      setStatus("FB post collected. You can now run one-click import.");
      setMeta(`Images: ${result.payload.imageUrlsOrdered.length} | URL: ${result.payload.postUrl}`);
      renderImagePreview(result.payload.imageUrlsOrdered);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to collect FB post";
      setStatus(`Error: ${message}`);
      setMeta("");
    } finally {
      await refreshDebugPanel();
      setBusy(false);
    }
  }
  async function openShopeeTab() {
    setBusy(true);
    setStatus("Opening Shopee new product page...");
    try {
      const result = await sendMessage({ type: MSG.open_shopee_tab });
      if (!result.ok || !result.payload) {
        throw new Error(pickError(result, "Failed to open Shopee tab"));
      }
      setStatus("Shopee tab ready.");
      setMeta(`Tab ID: ${result.payload.tabId} | URL: ${result.payload.url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open Shopee tab";
      setStatus(`Error: ${message}`);
    } finally {
      await refreshDebugPanel();
      setBusy(false);
    }
  }
  function bindEvents() {
    runBtn.addEventListener("click", () => {
      void runPipeline();
    });
    collectBtn.addEventListener("click", () => {
      void collectFbOnly();
    });
    openShopeeBtn.addEventListener("click", () => {
      void openShopeeTab();
    });
    openOptionsBtn.addEventListener("click", () => {
      void chrome.runtime.openOptionsPage();
    });
  }
  bindEvents();
  void refreshDebugPanel();
})();
//# sourceMappingURL=popup.js.map
