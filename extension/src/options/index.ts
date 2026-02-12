import { DEFAULT_OPENAI_MODEL } from '@shared/constants';
import { clearOpenAiKey, getOpenAiSettings, setOpenAiSettings } from '@shared/storage';

const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setBusy(busy: boolean): void {
  saveBtn.disabled = busy;
  clearBtn.disabled = busy;
}

async function loadSettings(): Promise<void> {
  setBusy(true);
  try {
    const settings = await getOpenAiSettings();
    apiKeyInput.value = settings?.apiKey || '';
    modelInput.value = settings?.model || DEFAULT_OPENAI_MODEL;

    if (settings?.apiKey) {
      setStatus('Loaded existing key and model.');
    } else {
      setStatus('No API key found. Please enter your OpenAI key.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load settings';
    setStatus(`Error: ${message}`);
  } finally {
    setBusy(false);
  }
}

async function saveSettings(): Promise<void> {
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_OPENAI_MODEL;

  if (!apiKey) {
    setStatus('API key is required.');
    apiKeyInput.focus();
    return;
  }

  setBusy(true);
  try {
    await setOpenAiSettings({ apiKey, model });
    setStatus('Settings saved.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save settings';
    setStatus(`Error: ${message}`);
  } finally {
    setBusy(false);
  }
}

async function clearKey(): Promise<void> {
  setBusy(true);
  try {
    await clearOpenAiKey();
    apiKeyInput.value = '';
    if (!modelInput.value.trim()) {
      modelInput.value = DEFAULT_OPENAI_MODEL;
    }
    setStatus('API key cleared.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clear key';
    setStatus(`Error: ${message}`);
  } finally {
    setBusy(false);
  }
}

saveBtn.addEventListener('click', () => {
  void saveSettings();
});

clearBtn.addEventListener('click', () => {
  void clearKey();
});

void loadSettings();
