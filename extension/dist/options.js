"use strict";
(() => {
  // src/shared/constants.ts
  var DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
  var SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1e3;

  // src/shared/storage.ts
  var STORAGE_KEYS = {
    openAiSettings: "openAiSettings",
    lastSchema: "lastSchema",
    lastReport: "lastReport",
    lastFbPayload: "lastFbPayload",
    lastAiDraft: "lastAiDraft",
    lastPipelineDebug: "lastPipelineDebug"
  };
  async function getOpenAiSettings() {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.openAiSettings);
    const value = raw[STORAGE_KEYS.openAiSettings];
    return value ?? null;
  }
  async function setOpenAiSettings(settings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.openAiSettings]: settings });
  }
  async function clearOpenAiKey() {
    const current = await getOpenAiSettings();
    if (!current) {
      return;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.openAiSettings]: { ...current, apiKey: "" }
    });
  }

  // src/options/index.ts
  var apiKeyInput = document.getElementById("apiKey");
  var modelInput = document.getElementById("model");
  var saveBtn = document.getElementById("save");
  var clearBtn = document.getElementById("clear");
  var statusEl = document.getElementById("status");
  function setStatus(text) {
    statusEl.textContent = text;
  }
  function setBusy(busy) {
    saveBtn.disabled = busy;
    clearBtn.disabled = busy;
  }
  async function loadSettings() {
    setBusy(true);
    try {
      const settings = await getOpenAiSettings();
      apiKeyInput.value = settings?.apiKey || "";
      modelInput.value = settings?.model || DEFAULT_OPENAI_MODEL;
      if (settings?.apiKey) {
        setStatus("Loaded existing key and model.");
      } else {
        setStatus("No API key found. Please enter your OpenAI key.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load settings";
      setStatus(`Error: ${message}`);
    } finally {
      setBusy(false);
    }
  }
  async function saveSettings() {
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim() || DEFAULT_OPENAI_MODEL;
    if (!apiKey) {
      setStatus("API key is required.");
      apiKeyInput.focus();
      return;
    }
    setBusy(true);
    try {
      await setOpenAiSettings({ apiKey, model });
      setStatus("Settings saved.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save settings";
      setStatus(`Error: ${message}`);
    } finally {
      setBusy(false);
    }
  }
  async function clearKey() {
    setBusy(true);
    try {
      await clearOpenAiKey();
      apiKeyInput.value = "";
      if (!modelInput.value.trim()) {
        modelInput.value = DEFAULT_OPENAI_MODEL;
      }
      setStatus("API key cleared.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear key";
      setStatus(`Error: ${message}`);
    } finally {
      setBusy(false);
    }
  }
  saveBtn.addEventListener("click", () => {
    void saveSettings();
  });
  clearBtn.addEventListener("click", () => {
    void clearKey();
  });
  void loadSettings();
})();
//# sourceMappingURL=options.js.map
