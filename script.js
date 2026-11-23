/* =============================================================
   ROLEPLAY CHAT APP — script.js
   All logic: IndexedDB, API calls, UI rendering, event handling
   ============================================================= */

'use strict';

// ─────────────────────────────────────────────
// MAINTENANCE MODE
// To enable: set MAINTENANCE to true and set MAINTENANCE_SINCE to
// new Date().toISOString() — then push to GitHub.
// To disable: set MAINTENANCE back to false and push again.
// ─────────────────────────────────────────────
const MAINTENANCE       = false;
const MAINTENANCE_SINCE = null; // e.g. '2026-03-14T18:00:00Z'

const isLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';

if (MAINTENANCE) {
  document.getElementById('maintenance-screen').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const since = MAINTENANCE_SINCE ? new Date(MAINTENANCE_SINCE) : new Date();
  const timerEl = document.getElementById('maintenance-timer');

  function updateTimer() {
    const diff = Math.floor((Date.now() - since) / 1000);
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    timerEl.textContent = `${h}:${m}:${s}`;
  }
  updateTimer();
  setInterval(updateTimer, 1000);

  // Stop the rest of the app from loading
  throw new Error('Maintenance mode active.');
}

// ─────────────────────────────────────────────
// INDEXEDDB
// ─────────────────────────────────────────────
const DB_NAME    = 'roleplay-app';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('characters')) {
        d.createObjectStore('characters', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('chats')) {
        d.createObjectStore('chats', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'id' });
      }
    };

    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbWrite(stores, write) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    let failure;
    const abort = error => {
      failure = error;
      tx.abort();
    };

    tx.oncomplete = () => {
      if (tx.objectStoreNames.contains('characters') || tx.objectStoreNames.contains('chats')) {
        scheduleLocalSnapshot();
      }
      resolve();
    };
    tx.onabort = () => reject(failure || tx.error || new Error('The database write was canceled.'));
    try {
      write(tx, abort);
    } catch (error) {
      abort(error);
    }
  });
}

function dbPut(store, value) {
  return dbWrite(store, tx => tx.objectStore(store).put(value));
}

async function createChatIfMissing(character) {
  let chat;
  await dbWrite(['characters', 'chats'], (tx, abort) => {
    const store = tx.objectStore('chats');
    const existing = store.get(character.id);
    existing.onsuccess = () => {
      chat = existing.result;
      if (chat) return;
      const saved = tx.objectStore('characters').get(character.id);
      saved.onsuccess = () => {
        if (!saved.result) {
          abort(new Error('This character is no longer available.'));
          return;
        }
        const opening = saved.result.openingMessage;
        chat = {
          id: character.id,
          messages: opening ? [{ role: 'assistant', content: opening, timestamp: Date.now() }] : [],
        };
        store.add(chat);
      };
    };
  });
  return chat;
}

async function persistChatMessages(chat, messages) {
  await dbWrite('chats', (tx, abort) => {
    const store = tx.objectStore('chats');
    const request = store.get(chat.id);
    request.onsuccess = () => {
      const saved = request.result;
      if (!saved || JSON.stringify(saved.messages) !== JSON.stringify(chat.messages)) {
        abort(new Error('This chat changed in another tab. Reopen it before trying again.'));
        return;
      }
      store.put({ ...saved, messages });
    };
  });

  chat.messages = messages;
  chatCounts?.set(chat.id, messages.filter(msg => msg.role === 'assistant').length);
  updateCharacterCounts();
}

// ─────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────
let characters   = [];   // all characters from DB
let settings     = {};   // API key, model, temperature, persona
let currentChar  = null; // character object currently in chat
let currentChat  = null; // { id, messages: [] }
let busyChat = null;
let deletingCharacterId = null;
let streamingRow = null;
let chatNavigation = 0;
const chatDrafts = new Map();
let editMsgIndex = null; // index of message being edited
let profileCharId   = null;  // char shown in profile modal
let profileUsePersona = true;
let profileTrigger = null;
let chatUsePersona  = true;  // whether to inject user persona into system prompt

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

// Replace {{char}} / {{user}} placeholders with actual names
function fillPlaceholders(text, character = currentChar, userName = settings.persona?.name || 'User') {
  if (!text) return text;
  const charName = character?.name || 'Character';
  return text.replace(/\{\{(char|user)\}\}/gi, (_, role) => role.toLowerCase() === 'char' ? charName : userName);
}

// Render message text into an element, embedding any image URLs as <img> tags
function renderMessageContent(text, el) {
  el.innerHTML = '';
  const userName = chatUsePersona ? settings.persona?.name || 'User' : 'User';
  const filled = fillPlaceholders(text, currentChar, userName) || '';
  // Match markdown images ![alt](url) OR bare image URLs
  const imgRe = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:[?#]\S*)?/gi;
  let last = 0, match;
  while ((match = imgRe.exec(filled)) !== null) {
    if (match.index > last) appendWithDialogue(el, filled.slice(last, match.index));
    const url = match[2] || match[0];
    const img = document.createElement('img');
    img.src = url;
    img.alt = match[1] || '';
    img.className = 'msg-inline-img';
    img.onerror = () => img.style.display = 'none';
    el.appendChild(img);
    last = match.index + match[0].length;
  }
  if (last < filled.length) appendWithDialogue(el, filled.slice(last));
}

// Append text to element, bolding any quoted dialogue ("...")
function appendWithDialogue(el, text) {
  const dialogueRe = /"([^"]+)"/g;
  let last = 0, match;
  while ((match = dialogueRe.exec(text)) !== null) {
    if (match.index > last) el.appendChild(document.createTextNode(text.slice(last, match.index)));
    const bold = document.createElement('strong');
    bold.textContent = `\u201C${match[1]}\u201D`;
    el.appendChild(bold);
    last = match.index + match[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Resize + compress any image (File or URL blob) to max 256x256 JPEG before storing
function compressImageToBase64(source) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 256;
      let w = img.naturalWidth  || MAX;
      let h = img.naturalHeight || MAX;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(null);
    if (source instanceof File) {
      const reader = new FileReader();
      reader.onload = (e) => { img.src = e.target.result; };
      reader.readAsDataURL(source);
    } else {
      img.src = source;
    }
  });
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
let toastContainer = null;

function toast(msg, type = '', duration = 3000) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// Turn raw API/network errors into something a human can act on.
function friendlyError(err) {
  const raw = (err && err.message ? err.message : String(err)) || '';
  const m = raw.toLowerCase();
  if (err?.name === 'AbortError' || m.includes('abort'))
    return 'The connection to the AI provider was interrupted before a reply arrived. Try again; if it repeats, note whether it happens immediately or after about 60 seconds.';
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed') || m.includes('cors'))
    return 'Network error — check your internet connection and try again.';
  if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid key') || m.includes('api key not valid'))
    return 'API key rejected — double-check your key in Settings.';
  if (m.includes('403') || m.includes('forbidden') || m.includes('location') || m.includes('permission'))
    return 'Blocked by the provider (key restriction or region). Check your provider/account settings.';
  if (m.includes('429') || m.includes('rate') || m.includes('quota') || m.includes('too many'))
    return 'Rate limited. Wait a moment and try again.';
  if (m.includes('no endpoints') || m.includes('404') || m.includes('not found') || m.includes('does not exist'))
    return "That model isn't available on your key — pick a different model in Settings.";
  if (m.includes('too large') || m.includes('context length') || m.includes('maximum context') || m.includes('413'))
    return 'The chat got too long for this model — clear or shorten it, then try again.';
  if (m.includes('500') || m.includes('502') || m.includes('503') || m.includes('overloaded') || m.includes('unavailable'))
    return 'The AI provider is having a moment (server error). Try again shortly.';
  return raw || 'Something went wrong.';
}

// ─────────────────────────────────────────────
// CONFIRM DIALOG
// ─────────────────────────────────────────────
function confirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('confirm-backdrop');
    const msg      = document.getElementById('confirm-message');
    const ok       = document.getElementById('btn-confirm-ok');
    const cancel   = document.getElementById('btn-confirm-cancel');

    if (backdrop.classList.contains('open')) {
      resolve(false);
      return;
    }

    const trigger = document.activeElement;
    msg.textContent = message;
    backdrop.classList.add('open');
    cancel.focus({ preventScroll: true });

    function cleanup(result) {
      backdrop.classList.remove('open');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      trigger?.focus({ preventScroll: true });
      resolve(result);
    }

    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

// ─────────────────────────────────────────────
// SCREEN NAVIGATION
// ─────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => {
    const active = screen.id === id;
    screen.classList.toggle('active', active);
    screen.inert = !active;
  });
}

// ─────────────────────────────────────────────
// SETTINGS PANEL
// ─────────────────────────────────────────────
let settingsTrigger = null;
let formProvider = 'deepseek';
let formApiKeys = {};
let formAvatar = null;

function openSettings() {
  const panel = document.getElementById('settings-panel');
  if (panel.classList.contains('open')) return;
  settingsTrigger = document.activeElement;
  populateSettingsForm();
  panel.classList.add('open');
  document.getElementById('settings-overlay').classList.add('visible');
  document.querySelector('.screen.active').inert = true;
  document.getElementById('btn-close-settings').focus({ preventScroll: true });
}

function closeSettings() {
  const panel = document.getElementById('settings-panel');
  if (!panel.classList.contains('open')) return;
  if (autoSaveTimer !== null) void saveSettings({ silent: true });
  panel.classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('visible');
  document.querySelector('.screen.active').inert = false;
  settingsTrigger?.focus({ preventScroll: true });
  settingsTrigger = null;
}

// Provider configs
const PROVIDERS = {
  groq:       { label: 'Groq API Key (free, no card)', placeholder: 'gsk_…', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
  google:     { label: 'Google AI Studio Key', placeholder: 'AIza… (free, no card)', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  deepseek:   { label: 'DeepSeek API Key', placeholder: 'sk-…',     endpoint: 'https://api.deepseek.com/v1/chat/completions' },
  openrouter: { label: 'OpenRouter API Key', placeholder: 'sk-or-…', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
};

const PROVIDER_MODELS = {
  groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  google:     ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'],
  deepseek:   ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['google/gemini-2.0-flash-exp:free', 'google/gemini-2.0-flash-001', 'anthropic/claude-3.5-haiku', 'openai/gpt-4o-mini', 'deepseek/deepseek-chat-v3-0324', 'deepseek/deepseek-r1'],
};

function getDefaultModel(provider = settings.provider || 'deepseek') {
  return PROVIDER_MODELS[provider]?.[0] || PROVIDER_MODELS.deepseek[0];
}

// Friendly labels for the model dropdown
const MODEL_LABELS = {
  'llama-3.3-70b-versatile':         'Llama 3.3 70B — FREE (smart, best for RP) ⭐',
  'llama-3.1-8b-instant':            'Llama 3.1 8B — FREE (fastest, lighter)',
  'gemini-2.0-flash-lite':           'Gemini 2.0 Flash-Lite — FREE (highest limit) ⭐',
  'gemini-2.0-flash':                'Gemini 2.0 Flash — FREE (best for RP)',
  'gemini-2.5-flash':                'Gemini 2.5 Flash — FREE (newest, lower limit)',
  'deepseek-flash':                  'DeepSeek Flash — latest',
  'deepseek-chat':                   'deepseek-chat (V3, cheap)',
  'deepseek-reasoner':               'deepseek-reasoner (R1)',
  'google/gemini-2.0-flash-exp:free':'Gemini 2.0 Flash — FREE (best for RP) ⭐',
  'google/gemini-2.0-flash-001':     'Gemini 2.0 Flash (paid, needs credits)',
  'anthropic/claude-3.5-haiku':      'Claude 3.5 Haiku (smarter, pricier)',
  'openai/gpt-4o-mini':              'GPT-4o mini',
  'deepseek/deepseek-chat-v3-0324':  'DeepSeek V3',
  'deepseek/deepseek-r1':            'DeepSeek R1',
};

function getEndpoint(provider = settings.provider || 'deepseek') {
  return PROVIDERS[provider]?.endpoint || PROVIDERS.deepseek.endpoint;
}

let warmedAPIOrigin = null;
function warmupAPIConnection() {
  const origin = new URL(getEndpoint()).origin;
  if (origin === warmedAPIOrigin) return;
  document.querySelector('link[data-api-preconnect]')?.remove();
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  link.crossOrigin = 'anonymous';
  link.dataset.apiPreconnect = 'true';
  document.head.appendChild(link);
  warmedAPIOrigin = origin;
}

function updateProviderUI(provider) {
  const cfg         = PROVIDERS[provider] || PROVIDERS.deepseek;
  const modelSelect = document.getElementById('model-select');
  const models      = PROVIDER_MODELS[provider] || PROVIDER_MODELS.deepseek;
  const current     = modelSelect.value;

  // Rebuild model options for this provider
  modelSelect.innerHTML = models.map(m => `<option value="${m}">${MODEL_LABELS[m] || m}</option>`).join('')
    + `<option value="custom">Custom…</option>`;

  // Restore selection if still valid
  if (models.includes(current)) modelSelect.value = current;

  document.getElementById('api-key-label').textContent = cfg.label;
  document.getElementById('api-key').placeholder       = cfg.placeholder;

  // Vision key only needed on DeepSeek (no vision); Google/OpenRouter chat
  // keys already power the avatar filter, so hide it for them.
  const visionGroup = document.getElementById('vision-key-group');
  if (visionGroup) visionGroup.style.display = (provider === 'deepseek') ? '' : 'none';
}

function populateSettingsForm() {
  const provider = settings.provider || 'deepseek';
  formProvider = provider;
  formApiKeys = { ...settings.apiKeys };
  formAvatar = settings.persona?.avatar || null;
  document.getElementById('provider-select').value     = provider;
  document.getElementById('api-key').value             = settings.apiKey      || '';
  document.getElementById('vision-key').value          = settings.visionKey   || '';
  document.getElementById('temperature').value         = settings.temperature ?? 0.6;
  document.getElementById('temp-display').textContent  = settings.temperature ?? 0.6;
  document.getElementById('persona-name').value        = settings.persona?.name        || '';
  document.getElementById('persona-desc').value        = settings.persona?.description || '';
  document.getElementById('ooc-enabled').checked       = settings.oocEnabled ?? true;

  updateProviderUI(provider);

  const modelSelect = document.getElementById('model-select');
  const customGroup = document.getElementById('custom-model-group');
  const customInput = document.getElementById('custom-model');
  const storedModel = settings.model || getDefaultModel(provider);
  const knownModels = Array.from(modelSelect.options).map(o => o.value).filter(v => v !== 'custom');

  if (knownModels.includes(storedModel)) {
    modelSelect.value = storedModel;
    customGroup.style.display = 'none';
  } else {
    modelSelect.value = 'custom';
    customInput.value = storedModel;
    customGroup.style.display = '';
  }

  const prev = document.getElementById('user-avatar-preview');
  renderAvatarPreview(prev, settings.persona?.avatar, settings.persona?.name);

  const chatBgBlur = settings.chatBg?.blur ?? 4;
  document.getElementById('chat-bg-blur').value = chatBgBlur;
  document.getElementById('chat-bg-blur-display').textContent = `${chatBgBlur}px`;
  updateChatBgThumb();
  applyChatBg();
}

async function saveSettings({ silent = false, close = false } = {}) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  const modelSelect = document.getElementById('model-select');
  const model = modelSelect.value === 'custom'
    ? document.getElementById('custom-model').value.trim()
    : modelSelect.value;

  if (!model) { if (!silent) toast('Please enter a model ID.', 'error'); return; }

  const curProvider = document.getElementById('provider-select').value;
  const curKey      = document.getElementById('api-key').value.trim();
  // Remember a key per provider so switching providers never loses one
  formApiKeys[curProvider] = curKey;

  const previousPersona = settings.persona;
  settings = {
    ...settings,
    id:          'app',
    provider:    curProvider,
    apiKey:      curKey,
    apiKeys:     { ...formApiKeys },
    visionKey:   document.getElementById('vision-key').value.trim(),
    model,
    temperature: parseFloat(document.getElementById('temperature').value),
    oocEnabled:  document.getElementById('ooc-enabled').checked,
    persona: {
      name:        document.getElementById('persona-name').value.trim(),
      description: document.getElementById('persona-desc').value.trim(),
      avatar:      formAvatar,
    },
    chatBg: settings.chatBg || null,
  };

  if (settings.apiKey) warmupAPIConnection();
  if (currentChat && (previousPersona?.name !== settings.persona.name ||
      previousPersona?.avatar !== settings.persona.avatar)) {
    updateMessagePersona();
  }

  const snapshot = settings;
  try {
    await dbPut('settings', snapshot);
    if (close && settings === snapshot && autoSaveTimer === null) closeSettings();
    if (!silent) toast('Settings saved.', 'success');
  } catch (err) {
    toast('Could not save settings to storage. Please try saving again.', 'error');
  }
}

// Debounced auto-save — fires 800ms after the user stops typing
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveSettings({ silent: true }), 800);
}

// ─────────────────────────────────────────────
// HOME SCREEN — CHARACTER LIST
// ─────────────────────────────────────────────
let chatCounts = null;

async function loadCharacters() {
  characters = await dbGetAll('characters');
  renderCharacterGrid();
  if (!characters.length) {
    chatCounts = new Map();
    return;
  }

  const loadCounts = async () => {
    try {
      const chats = await dbGetAll('chats');
      chatCounts = new Map(chats.map(chat => [
        chat.id, (chat.messages || []).filter(msg => msg.role === 'assistant').length,
      ]));
      updateCharacterCounts();
    } catch (err) {
      console.error('Unable to load chat counts.', err);
    }
  };
  if (window.requestIdleCallback) window.requestIdleCallback(loadCounts, { timeout: 1500 });
  else setTimeout(loadCounts, 250);
}

function characterCountText(charId) {
  if (!chatCounts) return 'Loading…';
  const count = chatCounts.get(charId) || 0;
  return count === 0 ? 'No messages yet' : `${count} message${count === 1 ? '' : 's'}`;
}

function updateCharacterCounts() {
  document.querySelectorAll('.char-row-count[data-char-id]').forEach(el => {
    el.textContent = characterCountText(el.dataset.charId);
  });
}

// ── Swipe-to-delete for char rows ─────────────────────────────────────────────
let _openSwipeRow = null;
const SWIPE_REVEAL = 88; // px to reveal delete button

function snapRow(row, x) {
  row.style.transition = 'transform 0.22s ease';
  row.style.transform  = x ? `translateX(${x}px)` : '';
  _openSwipeRow = x ? row : (_openSwipeRow === row ? null : _openSwipeRow);
  row.parentElement.querySelector('.char-row-del').tabIndex = x ? 0 : -1;
}

function addSwipe(wrap, row) {
  let startX = 0, startY = 0, dx = 0, tracking = false;

  wrap.addEventListener('touchstart', (e) => {
    if (_openSwipeRow && _openSwipeRow !== row) { snapRow(_openSwipeRow, 0); }
    startX   = e.touches[0].clientX;
    startY   = e.touches[0].clientY;
    dx       = 0;
    tracking = true;
    row.style.transition = 'none';
  }, { passive: true });

  wrap.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) > Math.abs(dx) + 4) {
      tracking = false;
      snapRow(row, _openSwipeRow === row ? -SWIPE_REVEAL : 0);
      return;
    }
    const clamped = Math.max(-SWIPE_REVEAL, Math.min(0, dx));
    row.style.transform = `translateX(${clamped}px)`;
  }, { passive: true });

  wrap.addEventListener('touchend', () => {
    if (!tracking) return;
    tracking = false;
    snapRow(row, dx < -SWIPE_REVEAL / 2 ? -SWIPE_REVEAL : 0);
  });
  wrap.addEventListener('touchcancel', () => {
    tracking = false;
    snapRow(row, _openSwipeRow === row ? -SWIPE_REVEAL : 0);
  });
}

function openCharSheet() {
  document.getElementById('char-sheet').classList.add('open');
  document.getElementById('char-sheet-backdrop').classList.add('open');
  document.getElementById('btn-open-chars').setAttribute('aria-expanded', 'true');
  document.getElementById('btn-close-chars').focus({ preventScroll: true });
}
function closeCharSheet({ restoreFocus = true } = {}) {
  if (!document.getElementById('char-sheet').classList.contains('open')) return;
  if (_openSwipeRow) { snapRow(_openSwipeRow, 0); _openSwipeRow = null; }
  document.getElementById('char-sheet').classList.remove('open');
  document.getElementById('char-sheet-backdrop').classList.remove('open');
  document.getElementById('btn-open-chars').setAttribute('aria-expanded', 'false');
  if (restoreFocus && mobileQuery.matches) {
    document.getElementById('btn-open-chars').focus({ preventScroll: true });
  }
}

function placeCharacterSearch() {
  const tool = document.querySelector('.search-wrap');
  if (mobileQuery.matches) {
    document.getElementById('char-sheet-list').before(tool);
  } else {
    document.querySelector('.home-toolbar').prepend(tool);
    closeCharSheet({ restoreFocus: false });
  }
}

function renderCharacterGrid() {
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  const list = characters.filter(char => char.name.toLowerCase().includes(query));
  const sheetList = document.getElementById('char-sheet-list');
  const cardGrid  = document.getElementById('character-grid');
  const empty     = document.getElementById('empty-state');

  _openSwipeRow = null;
  sheetList.innerHTML = '';
  cardGrid.innerHTML  = '';

  if (list.length === 0) {
    cardGrid.classList.remove('is-list');
    empty.querySelector('p').textContent = query ? 'No matching characters.' : 'No characters yet. Create one to get started.';
    empty.style.display = '';
    const message = document.createElement('p');
    message.className = 'char-sheet-empty';
    message.textContent = empty.querySelector('p').textContent;
    sheetList.appendChild(message);
    return;
  }
  empty.style.display = 'none';
  cardGrid.classList.remove('is-list');

  list.forEach(char => {
    // ── Mobile sheet row ──────────────────────────
    const row = document.createElement('div');
    row.className = 'char-row';
    row.dataset.id = char.id;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'char-row-avatar';
    renderAvatarPreview(avatarEl, char.avatar, char.name);

    const infoEl = document.createElement('div');
    infoEl.className = 'char-row-info';

    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'char-row-name';
    nameEl.textContent = char.name;

    const countEl = document.createElement('div');
    countEl.className = 'char-row-count';
    countEl.dataset.charId = char.id;
    countEl.textContent = characterCountText(char.id);

    infoEl.appendChild(nameEl);
    infoEl.appendChild(countEl);

    const continueBtn = document.createElement('button');
    continueBtn.className = 'char-row-continue';
    continueBtn.textContent = 'Continue';

    nameEl.addEventListener('click', (e) => { e.stopPropagation(); openCharProfile(char.id); });
    continueBtn.addEventListener('click', (e) => { e.stopPropagation(); openChat(char.id); });

    row.appendChild(avatarEl);
    row.appendChild(infoEl);
    row.appendChild(continueBtn);

    const wrap = document.createElement('div');
    wrap.className = 'char-row-wrap';

    const delBtn = document.createElement('button');
    delBtn.className = 'char-row-del';
    delBtn.tabIndex = -1;
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg><span>Delete Character</span>`;
    function handleDelete(e) {
      e.stopPropagation();
      e.preventDefault();
      deleteCharacter(char.id);
    }
    delBtn.addEventListener('click', handleDelete);
    let _delTouchMoved = false;
    delBtn.addEventListener('touchstart', (e) => { _delTouchMoved = false; e.stopPropagation(); }, { passive: true });
    delBtn.addEventListener('touchmove',  ()  => { _delTouchMoved = true; }, { passive: true });
    delBtn.addEventListener('touchend',   (e) => { if (!_delTouchMoved) { e.preventDefault(); handleDelete(e); } }, { passive: false });

    wrap.appendChild(delBtn);
    wrap.appendChild(row);
    addSwipe(wrap, row);
    sheetList.appendChild(wrap);

    // ── Desktop card ──────────────────────────────
    const card = document.createElement('div');
    card.className = 'character-card';
    card.dataset.id = char.id;

    const cardAvatar = document.createElement('div');
    cardAvatar.className = 'card-avatar';
    renderAvatarPreview(cardAvatar, char.avatar, char.name);

    const cardName = document.createElement('button');
    cardName.type = 'button';
    cardName.className = 'card-name';
    cardName.textContent = char.name;

    const editBtn = document.createElement('button');
    editBtn.className = 'card-edit-btn';
    editBtn.title = 'Edit character';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openCharModal(char.id); });

    const profileBtn = document.createElement('button');
    profileBtn.className = 'card-profile-btn';
    profileBtn.title = 'View profile';
    profileBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
    profileBtn.addEventListener('click', (e) => { e.stopPropagation(); openCharProfile(char.id); });

    card.appendChild(editBtn);
    card.appendChild(profileBtn);
    card.appendChild(cardAvatar);
    card.appendChild(cardName);
    card.addEventListener('click', () => openChat(char.id));
    cardGrid.appendChild(card);
  });
}

// ─────────────────────────────────────────────
// CHARACTER MODAL (create / edit)
// ─────────────────────────────────────────────
let charAvatarData = null; // base64 or null for current edit
let pendingJaiTags = [];   // tags from J.AI import, stored until save
let editingCharId  = null;

function openCharModal(charId = null) {
  const backdrop  = document.getElementById('char-modal-backdrop');
  const title     = document.getElementById('char-modal-title');
  const deleteBtn = document.getElementById('btn-delete-character');

  editingCharId  = charId;
  charAvatarData = null;
  pendingJaiTags = [];

  if (charId) {
    const char = characters.find(c => c.id === charId);
    if (!char) return;
    title.textContent = 'Edit Character';
    deleteBtn.style.display = '';
    document.getElementById('btn-back-char-modal').style.display = 'none';
    document.getElementById('char-name').value         = char.name;
    document.getElementById('char-personality').value  = char.personality;
    document.getElementById('char-opening').value      = char.openingMessage || '';
    loadSpotifyField(char.spotifyUrl || '');
    charAvatarData = char.avatar || null;
  } else {
    title.textContent = 'New Character';
    deleteBtn.style.display = 'none';
    document.getElementById('btn-back-char-modal').style.display = '';
    document.getElementById('char-name').value         = '';
    document.getElementById('char-personality').value  = '';
    document.getElementById('char-opening').value      = '';
    loadSpotifyField('');
    charAvatarData = null;
  }

  document.getElementById('chub-source-link').style.display = 'none';

  const prev = document.getElementById('char-avatar-preview');
  renderAvatarPreview(prev, charAvatarData, document.getElementById('char-name').value);

  restoreCharDraft();
  backdrop.classList.add('open');
}

function closeCharModal() {
  document.getElementById('char-modal-backdrop').classList.remove('open');
  editingCharId  = null;
  charAvatarData = null;
  clearCharDraft();
}

// ── Character form draft (survives refresh) ───────────────────────────────────
function saveCharDraft() {
  try {
    sessionStorage.setItem('charDraft', JSON.stringify({
      editingCharId,
      name:        document.getElementById('char-name').value,
      personality: document.getElementById('char-personality').value,
      opening:     document.getElementById('char-opening').value,
      spotify:     document.getElementById('char-spotify').value,
      avatar:      charAvatarData,
    }));
  } catch { /* quota exceeded — skip avatar */ }
}

function clearCharDraft() {
  sessionStorage.removeItem('charDraft');
}

function restoreCharDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem('charDraft'));
    if (!draft || draft.editingCharId !== editingCharId) return;
    if (draft.name        != null) document.getElementById('char-name').value        = draft.name;
    if (draft.personality != null) document.getElementById('char-personality').value = draft.personality;
    if (draft.opening     != null) document.getElementById('char-opening').value     = draft.opening;
    if (draft.spotify)     loadSpotifyField(draft.spotify);
    if (draft.avatar)      {
      charAvatarData = draft.avatar;
      renderAvatarPreview(document.getElementById('char-avatar-preview'), charAvatarData, draft.name || '');
    }
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────
// SPOTIFY SONG SEARCH
// ─────────────────────────────────────────────
let spotifySearchTimer = null;

function loadSpotifyField(url) {
  document.getElementById('char-spotify').value = url || '';
  const searchInput = document.getElementById('char-spotify-search');
  const selected    = document.getElementById('spotify-selected');
  const results     = document.getElementById('spotify-results');
  results.innerHTML = '';
  if (url) {
    searchInput.style.display = 'none';
    document.getElementById('spotify-sel-art').style.display = 'none';
    document.getElementById('spotify-sel-text').textContent = '♫ Spotify link saved';
    selected.style.display = 'flex';
  } else {
    searchInput.style.display = '';
    searchInput.value = '';
    selected.style.display = 'none';
  }
}

function setSpotifySelection(spotifyUrl, label, artUrl) {
  document.getElementById('char-spotify').value = spotifyUrl;
  const searchInput = document.getElementById('char-spotify-search');
  const results     = document.getElementById('spotify-results');
  const artEl       = document.getElementById('spotify-sel-art');
  const textEl      = document.getElementById('spotify-sel-text');
  results.innerHTML = '';
  searchInput.style.display = 'none';
  if (artUrl) { artEl.src = artUrl; artEl.style.display = ''; }
  else { artEl.style.display = 'none'; }
  textEl.textContent = label;
  document.getElementById('spotify-selected').style.display = 'flex';
}

async function searchSongItunes(query) {
  const results = document.getElementById('spotify-results');
  results.innerHTML = '<div class="spotify-result-msg">Searching…</div>';
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=6`;
    const fetchUrl  = WORKER_BASE ? `${WORKER_BASE}?url=${encodeURIComponent(itunesUrl)}` : itunesUrl;
    const res  = await fetch(fetchUrl);
    const data = await res.json();
    const tracks = data.results || [];
    if (!tracks.length) {
      results.innerHTML = '<div class="spotify-result-msg">No results — try a different name, or paste a Spotify link.</div>';
      return;
    }
    results.innerHTML = '';
    tracks.forEach(track => {
      const row = document.createElement('div');
      row.className = 'spotify-result-row';
      row.innerHTML = `
        <img src="${track.artworkUrl60}" alt="" />
        <div class="spotify-result-info">
          <div class="spotify-result-track">${escapeHtml(track.trackName)}</div>
          <div class="spotify-result-artist">${escapeHtml(track.artistName)}</div>
        </div>`;
      row.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        const label = `${track.trackName} — ${track.artistName}`;
        // trackViewUrl is already an Apple Music link — use it immediately
        if (track.trackViewUrl) {
          setSpotifySelection(track.trackViewUrl, label, track.artworkUrl60);
          return;
        }
        results.innerHTML = '<div class="spotify-result-msg">Couldn\'t find a playable link — paste one above.</div>';
      });
      results.appendChild(row);
    });
  } catch {
    results.innerHTML = '<div class="spotify-result-msg">Search failed — paste a Spotify link instead.</div>';
  }
}

async function saveCharacter() {
  const name         = document.getElementById('char-name').value.trim();
  const personality  = document.getElementById('char-personality').value.trim();
  const openingMsg   = document.getElementById('char-opening').value.trim();

  if (!name)        { toast('Character needs a name.', 'error');             return; }
  if (!personality) { toast('Personality / system prompt is required.', 'error'); return; }

  const isNew = !editingCharId;

  const spotifyUrl = document.getElementById('char-spotify').value.trim();
  const char = {
    id:             editingCharId || generateId(),
    name,
    avatar:         charAvatarData,
    personality,
    openingMessage: openingMsg,
    spotifyUrl:     spotifyUrl || null,
    tags:           pendingJaiTags.length ? pendingJaiTags : undefined,
  };
  pendingJaiTags = [];

  await dbPut('characters', char);

  const idx = characters.findIndex(c => c.id === char.id);
  if (idx >= 0) characters[idx] = char;
  else          characters.push(char);

  clearCharDraft();
  closeCharModal();
  renderCharacterGrid();

  if (isNew) {
    openCharProfile(char.id);
  } else {
    toast('Character updated.', 'success');
    // If we edited the currently open character, refresh header + message avatars
    if (currentChar && currentChar.id === char.id) {
      currentChar = char;
      updateChatHeader();
      renderMessages();
    }
  }
}

async function deleteCharacter(charId) {
  if (deletingCharacterId || busyChat?.id === charId) {
    toast('Wait for the current chat operation to finish.', 'error');
    return;
  }

  const ok = await confirm('Delete this character? Their chat history will also be deleted.');
  if (!ok || deletingCharacterId || busyChat?.id === charId) return;

  deletingCharacterId = charId;
  try {
    await dbWrite(['characters', 'chats'], tx => {
      tx.objectStore('characters').delete(charId);
      tx.objectStore('chats').delete(charId);
    });
  } catch (err) {
    toast('Could not delete the character. Please try again.', 'error');
    return;
  } finally {
    deletingCharacterId = null;
  }

  characters = characters.filter(char => char.id !== charId);
  chatCounts?.delete(charId);
  chatDrafts.delete(charId);
  if (editingCharId === charId) closeCharModal();
  if (profileCharId === charId) closeCharProfile();
  if (currentChar?.id === charId) {
    leaveChat();
    history.back();
  }

  renderCharacterGrid();
  toast('Character deleted.', 'success');
}

// ─────────────────────────────────────────────
// CHARACTER PROFILE MODAL
// ─────────────────────────────────────────────
function openCharProfile(charId) {
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  profileCharId  = charId;
  profileTrigger = document.activeElement;
  profileUsePersona = true; // reset to default on each profile open

  // Avatar
  renderAvatarPreview(document.getElementById('profile-avatar-large'), char.avatar, char.name);

  // Name
  document.getElementById('profile-char-name').textContent = char.name;

  // Opening message
  const openingEl = document.getElementById('profile-opening');
  if (char.openingMessage) {
    openingEl.textContent = '"' + fillPlaceholders(char.openingMessage, char) + '"';
    openingEl.style.display = '';
  } else {
    openingEl.style.display = 'none';
  }

  // Personality preview
  const p = char.personality;
  const pFilled = fillPlaceholders(p, char) || '';
  document.getElementById('profile-personality-preview').textContent =
    pFilled.length > 220 ? pFilled.slice(0, 220) + '…' : pFilled;

  // Persona picker
  const hasPersona = !!(settings.persona?.name || settings.persona?.description);
  document.getElementById('persona-picker-wrap').style.display = hasPersona ? '' : 'none';
  document.getElementById('persona-picker').classList.remove('open');
  updatePersonaLabel();

  document.getElementById('char-profile-backdrop').classList.add('open');
  document.getElementById('btn-profile-chat').focus({ preventScroll: true });
}

function closeCharProfile() {
  document.getElementById('char-profile-backdrop').classList.remove('open');
  document.getElementById('persona-picker').classList.remove('open');
  profileCharId = null;
  profileTrigger?.focus({ preventScroll: true });
  profileTrigger = null;
}

function updatePersonaLabel() {
  const label = document.getElementById('persona-label');
  const useBtn = document.getElementById('persona-opt-use');
  const noneBtn = document.getElementById('persona-opt-none');
  const toggleBtn = document.getElementById('btn-toggle-persona');

  if (profileUsePersona) {
    const personaName = settings.persona?.name;
    label.textContent = personaName ? `as ${personaName}` : 'using my persona';
    useBtn.classList.add('selected');
    noneBtn.classList.remove('selected');
    toggleBtn.classList.add('active');
  } else {
    label.textContent = 'no persona';
    useBtn.classList.remove('selected');
    noneBtn.classList.add('selected');
    toggleBtn.classList.remove('active');
  }
}

// ─────────────────────────────────────────────
// AVATAR HELPERS
// ─────────────────────────────────────────────
function renderAvatarPreview(el, avatarData, name, alt = name || 'Avatar') {
  if (!avatarData) {
    el.textContent = initials(name);
    return;
  }
  const img = document.createElement('img');
  img.src = avatarData;
  img.alt = alt;
  el.replaceChildren(img);
}

// ─────────────────────────────────────────────
// CHAT BACKGROUND
// ─────────────────────────────────────────────
function applyChatBg() {
  const layer = document.getElementById('chat-bg-layer');
  if (!layer) return;
  const bg = settings.chatBg;
  if (bg?.data) {
    layer.style.backgroundImage = `url(${bg.data})`;
    layer.style.opacity = '1';
    layer.style.filter = `blur(${bg.blur ?? 4}px)`;
  } else {
    layer.style.backgroundImage = '';
    layer.style.opacity = '0';
    layer.style.filter = '';
  }
}

function updateChatBgThumb() {
  const el = document.getElementById('chat-bg-thumb');
  if (!el) return;
  const bg = settings.chatBg;
  if (bg?.data) {
    el.style.backgroundImage = `url(${bg.data})`;
  } else {
    el.style.backgroundImage = '';
  }
}

// ─────────────────────────────────────────────
// CHAT — OPEN / LOAD
// ─────────────────────────────────────────────
function leaveChat({ restoreList = false } = {}) {
  chatNavigation++;
  const previousId = currentChat?.id;
  closeSettings();
  closeEditMessage();
  closeCharProfile();
  const input = document.getElementById('message-input');
  if (currentChat) chatDrafts.set(currentChat.id, input.value);
  currentChar = null;
  currentChat = null;
  sessionStorage.removeItem('activeChat');
  setupMusicPlayer(null);
  document.getElementById('messages-container').replaceChildren();
  showScreen('home-screen');
  if (restoreList && previousId && mobileQuery.matches) {
    openCharSheet();
  } else if (restoreList && previousId) {
    const card = document.querySelector(`.character-card[data-id="${CSS.escape(previousId)}"] .card-name`);
    (card || document.getElementById('search-input')).focus({ preventScroll: true });
  }
}

async function openChat(charId, usePersona = true, { fromHistory = false } = {}) {
  const char = characters.find(candidate => candidate.id === charId);
  if (!char || deletingCharacterId === charId) {
    if (fromHistory) {
      leaveChat();
      history.replaceState({ screen: 'home' }, '');
    }
    return;
  }

  const navigation = ++chatNavigation;
  let chat;
  try {
    chat = busyChat?.id === charId ? busyChat : await dbGet('chats', charId);
    if (navigation !== chatNavigation) return;
    if (!chat) chat = await createChatIfMissing(char);
  } catch (err) {
    if (navigation !== chatNavigation) return;
    toast('Could not open this chat. Please try again.', 'error');
    if (fromHistory) {
      leaveChat();
      history.replaceState({ screen: 'home' }, '');
    }
    return;
  }

  if (navigation !== chatNavigation || !characters.some(candidate => candidate.id === charId)) return;
  closeSettings();
  closeCharProfile();
  closeCharSheet({ restoreFocus: false });
  const input = document.getElementById('message-input');
  if (currentChat) chatDrafts.set(currentChat.id, input.value);
  chatUsePersona = usePersona;
  currentChar = char;
  currentChat = chat;
  chatCounts?.set(chat.id, chat.messages.filter(msg => msg.role === 'assistant').length);
  updateCharacterCounts();

  if (!fromHistory) history.pushState({ screen: 'chat', charId, usePersona }, '');
  sessionStorage.removeItem('activeChat');
  updateChatHeader();
  showScreen('chat-screen');
  input.value = chatDrafts.get(charId) || '';
  resizeTextarea(input);
  renderMessages();
  updateChatControls();
  scrollToBottom();
  document.getElementById('btn-back').focus({ preventScroll: true });
  setupMusicPlayer(char.spotifyUrl);
}

function toMusicEmbed(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    const onDomain = domain => h === domain || h.endsWith('.' + domain);
    // Spotify
    if (onDomain('spotify.com')) {
      const path = u.pathname.replace(/^\//, '');
      return { type: 'iframe', src: `https://open.spotify.com/embed/${path}?utm_source=oembed` };
    }
    // Apple Music
    if (h === 'music.apple.com') {
      const src = `https://embed.music.apple.com${u.pathname}${u.search}`;
      return { type: 'iframe', src };
    }
    // YouTube / YouTube Music
    if (onDomain('youtube.com') || h === 'youtu.be') {
      const vid = u.searchParams.get('v') || u.pathname.split('/').pop();
      if (vid) return { type: 'iframe', src: `https://www.youtube.com/embed/${vid}?autoplay=0` };
    }
    // Deezer
    if (onDomain('deezer.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return { type: 'iframe', src: `https://widget.deezer.com/widget/dark/${parts[0]}/${parts[1]}` };
    }
    // Tidal
    if (onDomain('tidal.com')) {
      return { type: 'iframe', src: `https://embed.tidal.com${u.pathname}` };
    }
    return null;
  } catch { return null; }
}

function setupMusicPlayer(musicUrl) {
  const btn      = document.getElementById('btn-music');
  const player   = document.getElementById('music-player');
  const iframe   = document.getElementById('spotify-iframe');
  const openLink = document.getElementById('music-open-link');

  // Reset
  player.style.display     = 'none';
  btn.style.display        = 'none';
  iframe.removeAttribute('src');
  iframe.style.display     = 'none';
  openLink.style.display   = 'none';
  const old = player.querySelector('audio');
  if (old) old.remove();

  if (!musicUrl) return;
  let url;
  try { url = new URL(musicUrl); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;

  const embed = toMusicEmbed(url.href);
  openLink.href = url.href;
  openLink.style.display = 'flex';

  if (embed?.type === 'iframe') {
    iframe.style.display = '';
    iframe.src = embed.src;
  }

  btn.style.display = '';
}

function toggleMusicPlayer() {
  const player = document.getElementById('music-player');
  player.style.display = player.style.display === 'none' ? '' : 'none';
}

function updateChatHeader() {
  const nameEl   = document.getElementById('chat-header-name');
  const avatarEl = document.getElementById('chat-header-avatar');
  nameEl.textContent = currentChar.name;
  const { name, avatar } = currentChar;
  renderAvatarPreview(avatarEl, avatar, name);
  avatarEl.style.cursor = avatar ? 'pointer' : '';
  avatarEl.onclick = avatar ? () => showAvatarOverlay(avatar, name) : null;
}

function showAvatarOverlay(src, name) {
  const ov = document.createElement('div');
  ov.className = 'avatar-overlay';
  renderAvatarPreview(ov, src, name);
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}

// ─────────────────────────────────────────────
// CHAT — RENDER MESSAGES
// ─────────────────────────────────────────────
function renderMessages() {
  const container = document.getElementById('messages-container');
  const rows = document.createDocumentFragment();
  currentChat?.messages.forEach((msg, index) => rows.appendChild(createMessageEl(msg, index)));
  if (busyChat === currentChat && streamingRow) rows.appendChild(streamingRow);
  container.replaceChildren(rows);
}

function updateMessagePersona() {
  const container = document.getElementById('messages-container');
  const follow = isNearChatBottom(container);
  currentChat.messages.forEach((message, index) => {
    const row = container.children[index];
    if (!row) return;
    renderMessageContent(message.content, row.querySelector('.msg-bubble'));
    if (message.role === 'user') {
      renderAvatarPreview(row.querySelector('.msg-avatar'), settings.persona.avatar, settings.persona.name || 'Y', 'You');
    }
  });
  if (follow) scrollToBottom();
}

function createMessageEl(msg, index) {
  const isUser  = msg.role === 'user';
  const isLast  = index === currentChat.messages.length - 1;
  const isLastAI = !isUser && isLast;

  const row = document.createElement('div');
  row.className = `message-row ${isUser ? 'user' : 'char'}`;
  row.dataset.index = index;

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  if (isUser) {
    renderAvatarPreview(avatar, settings.persona?.avatar, settings.persona?.name || 'Y', 'You');
  } else {
    const { avatar: image, name } = currentChar;
    renderAvatarPreview(avatar, image, name);
    if (image) {
      avatar.style.cursor = 'pointer';
      avatar.addEventListener('click', () => showAvatarOverlay(image, name));
    }
  }

  // Bubble wrap
  const wrap   = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  renderMessageContent(msg.content, bubble);

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = msg.timestamp ? formatTime(msg.timestamp) : '';

  // Actions
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  // Delete button — all messages
  const delBtn = makeActionBtn('Delete', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`, 'danger');
  delBtn.addEventListener('click', () => deleteMessage(index));
  actions.appendChild(delBtn);

  if (isUser) {
    // Edit button — user messages only
    const editBtn = makeActionBtn('Edit', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`);
    editBtn.addEventListener('click', () => openEditMessage(index));
    actions.appendChild(editBtn);
    if (isLast) {
      const retryBtn = makeActionBtn('Retry reply', '', 'msg-response-action');
      retryBtn.addEventListener('click', retryChatReply);
      actions.appendChild(retryBtn);
    }
  }

  if (isLastAI) {
    // Regenerate — last AI message only
    const regenBtn = makeActionBtn('Regenerate', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`);
    regenBtn.classList.add('msg-response-action');
    regenBtn.addEventListener('click', () => {
      if (regenBtn.dataset.armed) { regenerateLastAI(); return; }
      regenBtn.dataset.armed = '1';
      regenBtn.classList.add('armed');
      const origHTML = regenBtn.innerHTML;
      regenBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>Sure?</span>`;
      setTimeout(() => { delete regenBtn.dataset.armed; regenBtn.classList.remove('armed'); regenBtn.innerHTML = origHTML; }, 2500);
    });
    actions.appendChild(regenBtn);
  }

  wrap.appendChild(bubble);
  wrap.appendChild(timeEl);
  wrap.appendChild(actions);

  row.appendChild(avatar);
  row.appendChild(wrap);

  return row;
}

function makeActionBtn(label, iconSvg, extraClass = '') {
  const btn = document.createElement('button');
  btn.className = `msg-action-btn ${extraClass}`;
  btn.title = label;
  btn.innerHTML = iconSvg + `<span>${label}</span>`;
  return btn;
}

function scrollToBottom() {
  const container = document.getElementById('messages-container');
  container.scrollTop = container.scrollHeight;
}

function isNearChatBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
}

// ─────────────────────────────────────────────
// CHAT — SEND MESSAGE
// ─────────────────────────────────────────────
function canRequestChatReply({ showSettings = true } = {}) {
  if (busyChat || !currentChat || deletingCharacterId === currentChat.id) return false;
  if (settings.apiKey) return true;
  toast('Add your API key in Settings first.', 'error');
  if (showSettings) openSettings();
  return false;
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const draft = input.value;
  const content = draft.trim();
  if (!content || !canRequestChatReply()) return;

  const chat = currentChat;
  const character = currentChar;
  const usePersona = chatUsePersona;
  busyChat = chat;
  updateChatControls();
  input.value = '';
  resizeTextarea(input);

  const userMsg = { role: 'user', content, timestamp: Date.now() };
  try {
    await persistChatMessages(chat, [...chat.messages, userMsg]);
  } catch (err) {
    const currentDraft = currentChat === chat ? input.value : chatDrafts.get(chat.id);
    const restoredDraft = [draft, currentDraft].filter(Boolean).join('\n\n');
    if (currentChat === chat) {
      input.value = restoredDraft;
      resizeTextarea(input);
    } else {
      chatDrafts.set(chat.id, restoredDraft);
    }
    busyChat = null;
    updateChatControls();
    showChatWriteError(err);
    return;
  }

  if (currentChat === chat) {
    const container = document.getElementById('messages-container');
    container.querySelector('.msg-response-action')?.remove();
    container.appendChild(createMessageEl(userMsg, chat.messages.length - 1));
    scrollToBottom();
  }

  await streamAIResponse(chat, character, usePersona);
}

function showChatWriteError(err) {
  const message = err.message?.startsWith('This chat changed')
    ? err.message
    : 'Could not save the chat. Please try again.';
  toast(message, 'error', 6000);
}

function safeProviderErrorMessage(value, apiKey = '') {
  if (typeof value !== 'string') return '';
  const secret = typeof apiKey === 'string' ? apiKey.trim() : '';
  const message = secret ? value.split(secret).join('[redacted]') : value;
  return message.trim().slice(0, 300);
}

function parseChatStreamLine(line, apiKey) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true };

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }

  if (event.error) {
    const message = safeProviderErrorMessage(
      typeof event.error === 'string' ? event.error : event.error.message,
      apiKey
    );
    throw new Error(message || 'The AI provider returned an error in its response stream.');
  }
  const choice = event.choices?.[0];
  return { content: choice?.delta?.content, finished: !!choice?.finish_reason };
}

const FIRST_CHAT_CONTENT_TIMEOUT_MS = 60000;
const CHAT_STREAM_IDLE_TIMEOUT_MS = 45000;

function createChatStreamDeadline(controller) {
  let timeoutError = null;
  let firstContentTimer = null;
  let idleTimer = null;
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(timeoutError || new Error('The AI request was aborted.'));
    }, { once: true });
  });
  const abortWithError = message => {
    if (controller.signal.aborted) return;
    timeoutError = new Error(message);
    controller.abort();
  };

  firstContentTimer = setTimeout(() => {
    abortWithError('No reply text arrived from the AI provider within 60 seconds. The stream may be stuck; check the provider status or try again.');
  }, FIRST_CHAT_CONTENT_TIMEOUT_MS);

  return {
    aborted,
    receivedFirstContent() {
      clearTimeout(firstContentTimer);
      firstContentTimer = null;
    },
    startIdleTimeout() {
      this.clearIdleTimeout();
      idleTimer = setTimeout(() => {
        abortWithError('The AI response stream stopped sending data for 45 seconds. Try again or check the provider status.');
      }, CHAT_STREAM_IDLE_TIMEOUT_MS);
    },
    clearIdleTimeout() {
      clearTimeout(idleTimer);
      idleTimer = null;
    },
    cleanup() {
      clearTimeout(firstContentTimer);
      this.clearIdleTimeout();
    },
  };
}

// ─────────────────────────────────────────────
// CHAT — STREAM AI RESPONSE
// ─────────────────────────────────────────────
async function streamAIResponse(chat, character, usePersona, historyMessages = chat.messages) {
  if (!chat || (busyChat && busyChat !== chat)) return;
  busyChat = chat;
  updateChatControls();

  const container = document.getElementById('messages-container');

  // Typing indicator row (bouncing pink hearts)
  const typingRow = document.createElement('div');
  typingRow.className = 'message-row char';
  const typingAvatar = document.createElement('div');
  typingAvatar.className = 'msg-avatar';
  renderAvatarPreview(typingAvatar, character.avatar, character.name);
  const typingWrap   = document.createElement('div');
  typingWrap.className = 'msg-bubble-wrap';
  const typingBubble = document.createElement('div');
  typingBubble.className = 'msg-bubble typing-bubble';
  typingBubble.innerHTML = '<span>♥</span><span>♥</span><span>♥</span>';
  typingWrap.appendChild(typingBubble);
  typingRow.appendChild(typingAvatar);
  typingRow.appendChild(typingWrap);
  streamingRow = typingRow;
  if (currentChat === chat) {
    container.appendChild(typingRow);
    if (isNearChatBottom(container)) scrollToBottom();
  }

  let previewTimer = null;
  let latestPreview = '';
  const queuePreview = text => {
    latestPreview = text;
    if (previewTimer) return;
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const followOutput = currentChat === chat && isNearChatBottom(container);
      typingBubble.classList.remove('typing-bubble');
      typingBubble.textContent = latestPreview;
      if (followOutput) scrollToBottom();
    }, 50);
  };

  const provider = settings.provider || 'deepseek';
  const model = settings.model || getDefaultModel(provider);
  const temp = settings.temperature ?? 0.6;
  const apiKey = settings.apiKey;
  const maxTokens = provider === 'groq' ? 500 : undefined;

  let saving = false;
  try {
    const messages = buildAPIMessages({ messages: historyMessages }, character, usePersona);
    const body = { model, temperature: temp, stream: true, messages };
    if (maxTokens) body.max_tokens = maxTokens;
    const controller = new AbortController();
    let reader = null;
    let receivedContent = false;
    let streamDone = false;
    const deadline = createChatStreamDeadline(controller);
    let accumulated = '';
    try {
      const response = await Promise.race([fetch(getEndpoint(provider), {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer':  window.location.href,
          'X-Title':       'Roleplay Chat',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }), deadline.aborted]);
      if (!response.ok) {
        const err = await Promise.race([response.json().catch(() => ({})), deadline.aborted]);
        const providerMessage = safeProviderErrorMessage(err?.error?.message || err?.message, apiKey);
        const msg = response.status === 429
          ? 'Rate limited. Wait a moment and try again.'
          : `HTTP ${response.status}${providerMessage ? ` — ${providerMessage}` : ''}`;
        const error = new Error(msg);
        error.status = response.status;
        error.providerMessage = providerMessage;
        throw error;
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';           // holds an incomplete line across chunk reads

      const handleLine = (line) => {
        const event = parseChatStreamLine(line, apiKey);
        if (!event) return;
        if (event.done || event.finished) streamDone = true;
        if (typeof event.content === 'string' && event.content) {
          accumulated += event.content;
          if (!receivedContent) {
            receivedContent = true;
            deadline.receivedFirstContent();
          }
          queuePreview(accumulated);
        }
      };

      while (!streamDone) {
        try {
          const read = reader.read();
          if (receivedContent) deadline.startIdleTimeout();
          const result = await Promise.race([read, deadline.aborted]);
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();    // keep the last, possibly-incomplete line
          for (const line of lines) { handleLine(line); if (streamDone) break; }
        } finally {
          deadline.clearIdleTimeout();
        }
      }
      buffer += decoder.decode();
      if (buffer && !streamDone) handleLine(buffer); // flush any trailing complete line
      if (!accumulated.trim()) throw new Error('The AI provider ended the response without any reply text.');
      if (!streamDone) throw new Error('The AI connection closed before the reply finished. Please retry.');
    } finally {
      deadline.cleanup();
      if (reader) {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch {}
      }
    }

    const replaceHistory = historyMessages !== chat.messages;
    const reply = { role: 'assistant', content: accumulated, timestamp: Date.now() };
    saving = true;
    await persistChatMessages(chat, [...historyMessages, reply]);

    if (currentChat === chat) {
      const followOutput = isNearChatBottom(container);
      if (replaceHistory) {
        streamingRow = null;
        renderMessages();
      } else {
        container.querySelector('.msg-response-action')?.remove();
        typingRow.replaceWith(createMessageEl(reply, chat.messages.length - 1));
      }
      if (followOutput) scrollToBottom();
    }
    return true;

  } catch (err) {
    if (saving) {
      showChatWriteError(err);
      return false;
    }
    console.error('AI response failed', {
      provider,
      model,
      status: err.status || null,
      detail: safeProviderErrorMessage(err.providerMessage || err.message, apiKey),
    });
    toast(friendlyError(err), 'error', 6000);
    return false;
  } finally {
    clearTimeout(previewTimer);
    typingRow.remove();
    streamingRow = null;
    busyChat = null;
    updateChatControls();
  }
}

function buildAPIMessages(chat, character, usePersona) {
  const persona = usePersona ? settings.persona : null;
  const userName = persona?.name || 'User';
  const resolveNames = text => fillPlaceholders(text, character, userName) || '';
  let systemContent = [
    `Write the roleplay as ${character.name}, using the character card for voice, motives, and relationships.`,
    'Respond to the user’s latest turn and carry forward established events, decisions, and unresolved goals. Let the character take initiative when it fits their motives and circumstances.',
    'Base the character’s reactions on what they could have observed, learned, or reasonably inferred. Private narration from the user can inform the writing without becoming character knowledge.',
    'Leave the user’s new dialogue, actions, thoughts, and decisions to them. Use concrete details and let the scene and character’s voice guide the pace and length of the reply.',
    `Character card:\n${resolveNames(character.personality)}`,
  ].join('\n\n');

  if (persona?.name || persona?.description) {
    const userInfo = [persona.name, persona.description].filter(Boolean).join('\n');
    systemContent += `\n\nUser persona:\n${userInfo}`;
  }

  if (settings.oocEnabled ?? true) {
    systemContent += '\n\nTreat [OOC: ...] or (OOC: ...) at the start of a user message or on its own line as a writer’s note. Answer it directly starting with [OOC]: and pause the scene until the next in-character turn.';
  }

  const all = chat.messages;
  const limit = settings.provider === 'groq' ? 2400 : 12000;
  // Allow for message framing and use the expanded text when estimating the input.
  const estimateTokens = content => Math.ceil(content.length / 4) + 4;
  const historyBudget = limit - estimateTokens(systemContent);
  const recentHistory = budget => {
    const recent = [];
    let remaining = budget;
    for (let i = all.length - 1; i >= 0; i--) {
      const content = resolveNames(all[i].content);
      const cost = estimateTokens(content);
      // The latest turn is the user's current input, even when it exceeds the estimate.
      if (recent.length && cost > remaining) break;
      recent.push({ role: all[i].role, content });
      remaining -= cost;
    }
    return recent.reverse();
  };

  let recent = recentHistory(historyBudget);
  const omitted = all.length - recent.length;
  if (omitted > 0 && historyBudget > 0) {
    const heading = '\n\nEarlier scene context (some intervening turns were omitted):';
    const excerpts = all.slice(0, Math.min(omitted, 2)).map(message => {
      const content = resolveNames(message.content);
      const excerpt = content.length > 720 ? content.slice(0, 720).trimEnd() + '…' : content;
      const speaker = message.role === 'assistant' ? character.name : userName;
      return `\n${speaker}: ${excerpt}`;
    });
    const earlier = heading + excerpts.join('');
    const contextBudget = historyBudget - estimateTokens(earlier);
    const latestCost = estimateTokens(recent.at(-1).content);
    if (contextBudget >= latestCost) {
      systemContent += earlier;
      recent = recentHistory(contextBudget);
    }
  }

  return [{ role: 'system', content: systemContent }, ...recent];
}

function updateChatControls() {
  document.getElementById('send-btn').disabled = !!busyChat;
  document.getElementById('btn-clear-chat').disabled = !!busyChat;
  const status = document.getElementById('chat-status');
  status.textContent = busyChat && busyChat !== currentChat ? 'Reply in progress in another chat' : '';
  status.hidden = !status.textContent;
  document.getElementById('messages-container').classList.toggle('chat-busy', !!busyChat);
}

// ─────────────────────────────────────────────
// CHAT — MESSAGE ACTIONS
// ─────────────────────────────────────────────
async function saveChatHistory(chat, messages) {
  busyChat = chat;
  updateChatControls();
  try {
    await persistChatMessages(chat, messages);
    if (currentChat === chat) {
      renderMessages();
      scrollToBottom();
    }
    return true;
  } catch (err) {
    showChatWriteError(err);
    return false;
  } finally {
    busyChat = null;
    updateChatControls();
  }
}

async function deleteMessage(index) {
  if (busyChat || !currentChat || deletingCharacterId === currentChat.id) return;
  const chat = currentChat;
  const ok = await confirm('Delete this message and all messages after it?');
  if (!ok || busyChat || currentChat !== chat || deletingCharacterId === chat.id) return;

  await saveChatHistory(chat, chat.messages.slice(0, index));
}

function openEditMessage(index) {
  if (busyChat || !currentChat) return;
  editMsgIndex = index;
  const msg = currentChat.messages[index];
  document.getElementById('edit-msg-input').value = msg.content;
  document.getElementById('edit-msg-backdrop').classList.add('open');
}

function closeEditMessage() {
  document.getElementById('edit-msg-backdrop').classList.remove('open');
  editMsgIndex = null;
}

async function saveEditMessage() {
  if (editMsgIndex === null || !canRequestChatReply({ showSettings: false })) return;
  const input = document.getElementById('edit-msg-input');
  const newContent = input.value.trim();
  if (!newContent) { toast('Message cannot be empty.', 'error'); return; }

  const chat = currentChat;
  const index = editMsgIndex;
  const edited = { ...chat.messages[index], content: newContent, timestamp: Date.now() };
  const historyMessages = [...chat.messages.slice(0, index), edited];
  closeEditMessage();

  const saved = await streamAIResponse(chat, currentChar, chatUsePersona, historyMessages);
  if (!saved && currentChat === chat && editMsgIndex === null &&
      !document.getElementById('settings-panel').classList.contains('open')) {
    openEditMessage(index);
    input.value = newContent;
  }
}

async function regenerateLastAI() {
  if (!canRequestChatReply() || currentChat.messages.at(-1)?.role !== 'assistant') return;
  const historyMessages = currentChat.messages.slice(0, -1);
  await streamAIResponse(currentChat, currentChar, chatUsePersona, historyMessages);
}

async function retryChatReply() {
  if (!canRequestChatReply() || currentChat.messages.at(-1)?.role !== 'user') return;
  await streamAIResponse(currentChat, currentChar, chatUsePersona);
}

async function clearChat() {
  if (busyChat || !currentChat || deletingCharacterId === currentChat.id) return;
  const chat = currentChat;
  const ok = await confirm('Clear all messages in this chat?');
  if (!ok || busyChat || currentChat !== chat || deletingCharacterId === chat.id) return;

  const opening = currentChar.openingMessage;
  const messages = opening ? [{ role: 'assistant', content: opening, timestamp: Date.now() }] : [];
  if (await saveChatHistory(chat, messages)) toast('Chat cleared.', 'success');
}

// ─────────────────────────────────────────────
// TEXTAREA AUTO-RESIZE
// ─────────────────────────────────────────────
function resizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

// ─────────────────────────────────────────────
// DATA — EXPORT / IMPORT
// ─────────────────────────────────────────────
async function exportData() {
  const chars = await dbGetAll('characters');
  const chats = await dbGetAll('chats');
  const s     = await dbGet('settings', 'app');

  const hiddenBots    = JSON.parse(localStorage.getItem('hidden-discover') || '[]');
  const discoverState = JSON.parse(localStorage.getItem('discover-state')  || 'null');

  const data = { characters: chars, chats, settings: s, hiddenBots, discoverState, exportedAt: new Date().toISOString() };
  const json = JSON.stringify(data, null, 2);
  const filename = `roleplay-backup-${Date.now()}.json`;

  // Mobile browsers (Opera GX, iOS) ignore the download attribute and just
  // open the file in a tab. Prefer the native share sheet there so it can
  // actually be saved to Files.
  try {
    const file = new File([json], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Roleplay backup' });
      localStorage.setItem('rp-last-backup', Date.now().toString());
      toast('Backup ready — choose "Save to Files".', 'success');
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user closed the share sheet
    // any other failure — fall through to the download method
  }

  // Desktop fallback: classic download link
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  localStorage.setItem('rp-last-backup', Date.now().toString());
  toast('Data exported.', 'success');
}

function storeBackupRecords({ characters, chats = [], settings: importedSettings }) {
  const stores = ['characters', 'chats'];
  if (importedSettings) stores.push('settings');
  return dbWrite(stores, tx => {
    const characterStore = tx.objectStore('characters');
    const chatStore = tx.objectStore('chats');
    characters.forEach(char => characterStore.put(char));
    chats.forEach(chat => chatStore.put(chat));
    if (importedSettings) tx.objectStore('settings').put(importedSettings);
  });
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data?.characters) || !Array.isArray(data.chats ?? []) ||
        data.characters.some(char => !char?.id || typeof char.name !== 'string') ||
        (data.chats ?? []).some(chat => !chat?.id || !Array.isArray(chat.messages) ||
          chat.messages.some(msg => !['user', 'assistant'].includes(msg?.role) || typeof msg.content !== 'string')) ||
        (data.settings && data.settings.id !== 'app')) {
      throw new Error('Invalid backup file.');
    }

    const ok = await confirm('Import will replace matching characters, chats, and settings from this backup. Continue?');
    if (!ok) return;
    if (busyChat || deletingCharacterId) {
      toast('Wait for the current chat operation to finish before importing.', 'error');
      return;
    }

    if (autoSaveTimer !== null) await saveSettings({ silent: true });
    await storeBackupRecords({ ...data, chats: data.chats ?? [] });
    if (data.settings) settings = data.settings;

    await loadCharacters();
    populateSettingsForm();
    if (currentChat) {
      const settingsOpen = document.getElementById('settings-panel').classList.contains('open');
      if (settingsOpen) closeSettings();
      await openChat(currentChat.id, chatUsePersona, { fromHistory: true });
      if (settingsOpen) openSettings();
    }
    try {
      if (Array.isArray(data.hiddenBots)) localStorage.setItem('hidden-discover', JSON.stringify(data.hiddenBots));
      if (data.discoverState) localStorage.setItem('discover-state', JSON.stringify(data.discoverState));
    } catch (err) {
      toast('Chats and characters imported. Discover preferences could not be saved.', 'error');
      return;
    }
    toast('Data imported successfully.', 'success');
  } catch (err) {
    toast('Import failed: ' + (err.message || 'Could not save the backup.'), 'error', 6000);
  }
}

// ─────────────────────────────────────────────
// INIT — WIRE UP ALL EVENTS
// ─────────────────────────────────────────────
async function migrateAvatars() {
  try {
    const chars = await dbGetAll('characters');
    for (const char of chars) {
      if (!char.avatar || char.avatar.length <= 40000) continue;
      const compressed = await compressImageToBase64(char.avatar);
      if (!compressed || compressed.length >= char.avatar.length) continue;

      await dbWrite('characters', tx => {
        const store = tx.objectStore('characters');
        const request = store.get(char.id);
        request.onsuccess = () => {
          const latest = request.result;
          if (latest?.avatar === char.avatar) store.put({ ...latest, avatar: compressed });
        };
      });
    }

    const saved = await dbGet('settings', 'app');
    const avatar = saved?.persona?.avatar;
    const background = saved?.chatBg?.data;
    const newAvatar = avatar?.length > 40000 ? await compressImageToBase64(avatar) : null;
    const newBackground = background?.length > 40000 ? await compressImageToBase64(background) : null;
    if (!newAvatar && !newBackground) return;

    await dbWrite('settings', tx => {
      const store = tx.objectStore('settings');
      const request = store.get('app');
      request.onsuccess = () => {
        const latest = request.result;
        if (!latest) return;
        let changed = false;
        if (newAvatar && newAvatar.length < avatar.length && latest.persona?.avatar === avatar) {
          latest.persona.avatar = newAvatar;
          changed = true;
        }
        if (newBackground && newBackground.length < background.length && latest.chatBg?.data === background) {
          latest.chatBg.data = newBackground;
          changed = true;
        }
        if (changed) store.put(latest);
      };
    });
  } catch { /* migration is best-effort */ }
}

// ─────────────────────────────────────────────
// DATA SAFETY — prevent the silent IndexedDB eviction that caused data loss
// ─────────────────────────────────────────────

// Ask the browser to mark our storage persistent so it won't be evicted
// under storage pressure (the thing that wiped the old characters).
async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted?.()) return; // already persistent
    await navigator.storage.persist();
  } catch { /* not supported — best effort */ }
}

// Warn before the browser starts evicting, not after.
async function checkStorageHealth() {
  try {
    if (!navigator.storage?.estimate) return;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && usage / quota > 0.85) {
      toast('⚠️ Storage almost full — export a backup soon so nothing gets lost.', 'error', 9000);
    }
  } catch {}
}

// Rolling text-only snapshot in localStorage as a last-ditch recovery if the
// IndexedDB is cleared. Avatars/images are stripped to stay within limits.
let _snapshotTimer = null;
let _snapshotIdleId = null;
function scheduleLocalSnapshot() {
  clearTimeout(_snapshotTimer);
  if (_snapshotIdleId !== null) {
    window.cancelIdleCallback?.(_snapshotIdleId);
    _snapshotIdleId = null;
  }
  _snapshotTimer = setTimeout(() => {
    _snapshotTimer = null;
    if (window.requestIdleCallback) {
      _snapshotIdleId = window.requestIdleCallback(() => {
        _snapshotIdleId = null;
        void saveLocalSnapshot();
      }, { timeout: 30000 });
    } else {
      _snapshotTimer = setTimeout(() => {
        _snapshotTimer = null;
        void saveLocalSnapshot();
      }, 10000);
    }
  }, 3000);
}
async function saveLocalSnapshot() {
  try {
    if (!db) return;
    const chars = (await dbGetAll('characters')).map(c => ({ ...c, avatar: null }));
    const chats = await dbGetAll('chats');
    const snapshot = JSON.stringify({
      characters: chars,
      chats: chats.map(c => ({ ...c, messages: (c.messages || []).slice(-30) })),
      savedAt: Date.now(),
      trimmed: true,
    });
    localStorage.setItem('rp-snapshot', snapshot);
  } catch { /* serialization issue — skip */ }
}

// On startup, if the DB looks empty but a snapshot exists, offer to restore.
async function checkRecovery() {
  try {
    if (characters.length > 0) return;
    const raw = localStorage.getItem('rp-snapshot');
    if (!raw) return;
    const snap = JSON.parse(raw);
    const hasData = snap?.characters?.length || snap?.chats?.length;
    if (!hasData) return;
    const when = new Date(snap.savedAt).toLocaleString();
    const ok = await confirm(`Your characters are empty, but a local backup from ${when} was found. Restore it?\n\n(Text is recovered; avatars may need re-adding.)`);
    if (!ok) return;
    await storeBackupRecords({ characters: snap.characters || [], chats: snap.chats || [] });
    await loadCharacters();
    toast('Recovered from local snapshot. Export a full backup now to be safe.', 'success', 7000);
  } catch {}
}

// Gentle reminder to export a real (file) backup if it's been a while.
function backupReminder() {
  try {
    const last = parseInt(localStorage.getItem('rp-last-backup') || '0', 10);
    if (!last || (Date.now() - last) / 86400000 > 3) {
      toast('💾 Tip: tap the ↑ export button now and then to keep a safe backup.', '', 6000);
    }
  } catch {}
}

async function init() {
  db       = await openDB();
  void requestPersistentStorage();
  settings = (await dbGet('settings', 'app')) || { id: 'app' };
  if (settings.apiKey) warmupAPIConnection();

  await loadCharacters();
  await checkRecovery();

  applyChatBg();

  // Run avatar compression migration in background after UI is ready
  setTimeout(migrateAvatars, 2000);
  setTimeout(checkStorageHealth, 3000);
  setTimeout(backupReminder, 4500);

  placeCharacterSearch();
  const savedChat = (() => {
    try { return JSON.parse(sessionStorage.getItem('activeChat')); } catch { return null; }
  })();
  showScreen('home-screen');
  if (history.state?.screen === 'chat') {
    const historyChat = history.state.charId ? history.state : savedChat;
    if (historyChat?.charId && !history.state.charId) {
      history.replaceState({ ...historyChat, screen: 'chat' }, '');
    }
    await openChat(historyChat?.charId, historyChat?.usePersona ?? true, { fromHistory: true });
  } else {
    history.replaceState({ screen: 'home' }, '');
    if (savedChat?.charId) await openChat(savedChat.charId, savedChat.usePersona ?? true);
    sessionStorage.removeItem('activeChat');
  }

  // ── Settings panel ──────────────────────────
  document.getElementById('btn-open-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);
  document.getElementById('btn-save-settings').addEventListener('click', () => saveSettings({ close: true }));

  // Auto-save whenever any settings field changes
  ['api-key', 'vision-key', 'persona-name', 'persona-desc', 'custom-model'].forEach(id => {
    document.getElementById(id).addEventListener('input', scheduleAutoSave);
  });
  document.getElementById('model-select').addEventListener('change', scheduleAutoSave);
  document.getElementById('temperature').addEventListener('change', scheduleAutoSave);
  document.getElementById('ooc-enabled').addEventListener('change', scheduleAutoSave);

  document.getElementById('temperature').addEventListener('input', (e) => {
    document.getElementById('temp-display').textContent = parseFloat(e.target.value).toFixed(2);
  });

  document.getElementById('provider-select').addEventListener('change', (e) => {
    const newProvider = e.target.value;
    // Stash the key currently in the box under the OLD provider, then load
    // the remembered key for the NEW provider so nothing gets overwritten.
    const keyField = document.getElementById('api-key');
    formApiKeys[formProvider] = keyField.value.trim();
    keyField.value = formApiKeys[newProvider] || '';
    formProvider = newProvider;
    updateProviderUI(newProvider);
    document.getElementById('custom-model-group').style.display = 'none';
    scheduleAutoSave();
  });

  document.getElementById('model-select').addEventListener('change', (e) => {
    document.getElementById('custom-model-group').style.display =
      e.target.value === 'custom' ? '' : 'none';
  });

  // User avatar upload
  document.getElementById('btn-upload-user-avatar').addEventListener('click', () => {
    document.getElementById('user-avatar-file').click();
  });
  document.getElementById('user-avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const b64 = await compressImageToBase64(file);
    if (!b64) {
      toast('Could not read that avatar image.', 'error');
      return;
    }
    formAvatar = b64;
    renderAvatarPreview(document.getElementById('user-avatar-preview'), b64, settings.persona?.name);
    scheduleAutoSave();
  });

  // Chat background upload
  document.getElementById('btn-upload-chat-bg').addEventListener('click', () => {
    document.getElementById('chat-bg-file').click();
  });
  document.getElementById('chat-bg-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const b64 = await readFileAsBase64(file);
    if (!settings.chatBg) settings.chatBg = {};
    settings.chatBg.data = b64;
    updateChatBgThumb();
    applyChatBg();
    scheduleAutoSave();
    e.target.value = '';
  });
  document.getElementById('btn-clear-chat-bg').addEventListener('click', () => {
    if (settings.chatBg) settings.chatBg.data = null;
    updateChatBgThumb();
    applyChatBg();
    scheduleAutoSave();
  });
  document.getElementById('chat-bg-blur').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('chat-bg-blur-display').textContent = `${val}px`;
    if (!settings.chatBg) settings.chatBg = {};
    settings.chatBg.blur = val;
    applyChatBg();
    scheduleAutoSave();
  });

  // Export / Import (settings panel + header shortcuts)
  document.getElementById('btn-export-chars').addEventListener('click', exportData);
  document.getElementById('import-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) { importData(file); e.target.value = ''; }
  });

  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) { importData(file); e.target.value = ''; }
  });

  document.getElementById('btn-export-hidden').addEventListener('click', () => {
    const hidden       = JSON.parse(localStorage.getItem('hidden-discover') || '[]');
    const discoverState = JSON.parse(localStorage.getItem('discover-state') || 'null');
    const blob = new Blob([JSON.stringify({ hiddenBots: hidden, discoverState }, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `hidden-list-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Hidden list exported.', 'success');
  });
  document.getElementById('import-hidden-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    file.text().then(text => {
      try {
        const data = JSON.parse(text);
        if (!Array.isArray(data.hiddenBots)) throw new Error('Invalid hidden list file.');
        const existing = new Set(JSON.parse(localStorage.getItem('hidden-discover') || '[]'));
        data.hiddenBots.forEach(id => existing.add(id));
        localStorage.setItem('hidden-discover', JSON.stringify([...existing]));
        if (data.discoverState) localStorage.setItem('discover-state', JSON.stringify(data.discoverState));
        toast(`Hidden list imported — ${data.hiddenBots.length} bots merged.`, 'success');
        loadDailyDiscovery();
      } catch (err) { toast('Import failed: ' + friendlyError(err), 'error', 6000); }
    });
  });

  // ── Character modal ──────────────────────────
  document.getElementById('btn-new-character').addEventListener('click', () => {
    document.getElementById('new-char-choice-backdrop').classList.add('open');
  });
  document.getElementById('new-char-choice-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });
  document.getElementById('choice-manual').addEventListener('click', () => {
    document.getElementById('new-char-choice-backdrop').classList.remove('open');
    openCharModal();
  });
  document.getElementById('choice-import').addEventListener('click', () => {
    document.getElementById('new-char-choice-backdrop').classList.remove('open');
    openImportDesc();
  });
  document.getElementById('btn-close-char-modal').addEventListener('click', closeCharModal);
  document.getElementById('btn-cancel-char-modal').addEventListener('click', closeCharModal);
  document.getElementById('char-modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCharModal();
  });

  document.getElementById('btn-save-character').addEventListener('click', showVibePicker);

  // Spotify song search
  document.getElementById('char-spotify-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(spotifySearchTimer);
    const results = document.getElementById('spotify-results');
    if (!q) { results.innerHTML = ''; return; }
    // Direct Spotify URL paste
    if (q.includes('open.spotify.com/')) {
      results.innerHTML = '';
      setSpotifySelection(q, '♫ Spotify link', null);
      return;
    }
    spotifySearchTimer = setTimeout(() => searchSongItunes(q), 400);
  });
  document.getElementById('spotify-sel-clear').addEventListener('click', () => {
    loadSpotifyField('');
    document.getElementById('char-spotify-search').focus();
  });
  document.addEventListener('click', (e) => {
    if (!document.getElementById('spotify-field-wrap')?.contains(e.target)) {
      document.getElementById('spotify-results').innerHTML = '';
    }
  });

  // Rosie
  document.getElementById('rosie-toggle').addEventListener('click', toggleRosie);
  document.getElementById('btn-close-rosie').addEventListener('click', closeRosie);
  document.getElementById('rosie-send-btn').addEventListener('click', sendRosieMessage);
  document.getElementById('rosie-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRosieMessage(); }
  });
  document.getElementById('rosie-input').addEventListener('input', (e) => resizeTextarea(e.target));

  // Import from description
  document.getElementById('btn-back-char-modal').addEventListener('click', () => {
    closeCharModal();
    document.getElementById('new-char-choice-backdrop').classList.add('open');
  });
  document.getElementById('btn-back-import-desc').addEventListener('click', () => {
    closeImportDesc();
    document.getElementById('new-char-choice-backdrop').classList.add('open');
  });
  document.getElementById('btn-close-import-desc').addEventListener('click', closeImportDesc);
  document.getElementById('btn-cancel-import-desc').addEventListener('click', closeImportDesc);
  document.getElementById('btn-process-import-desc').addEventListener('click', processImportDesc);
  document.getElementById('import-desc-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeImportDesc();
  });
  document.getElementById('btn-review-back').addEventListener('click', () => {
    closeImportReview();
    openImportDesc();
  });
  document.getElementById('btn-review-apply').addEventListener('click', applyImportReview);
  document.getElementById('import-review-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeImportReview();
  });

  // Vibe picker
  document.getElementById('vibe-fluff').addEventListener('click', () => handleVibePick('fluff'));
  document.getElementById('vibe-spicy').addEventListener('click', () => handleVibePick('spicy'));

  // Character profile modal
  document.getElementById('btn-close-char-profile').addEventListener('click', closeCharProfile);
  document.getElementById('btn-back-char-profile').addEventListener('click', closeCharProfile);

  // Character sheet (mobile)
  document.getElementById('btn-open-chars').addEventListener('click', openCharSheet);
  document.getElementById('btn-close-chars').addEventListener('click', closeCharSheet);
  document.getElementById('char-sheet-backdrop').addEventListener('click', closeCharSheet);
  document.getElementById('char-profile-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCharProfile();
  });
  document.getElementById('btn-profile-chat').addEventListener('click', () => {
    const id         = profileCharId;
    openChat(id, profileUsePersona);
  });
  document.getElementById('btn-toggle-persona').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('persona-picker').classList.toggle('open');
  });
  document.getElementById('persona-opt-use').addEventListener('click', () => {
    profileUsePersona = true;
    updatePersonaLabel();
    document.getElementById('persona-picker').classList.remove('open');
  });
  document.getElementById('persona-opt-none').addEventListener('click', () => {
    profileUsePersona = false;
    updatePersonaLabel();
    document.getElementById('persona-picker').classList.remove('open');
  });
  // Close persona picker when clicking outside
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('persona-picker-wrap');
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById('persona-picker').classList.remove('open');
    }
  });

  document.getElementById('btn-delete-character').addEventListener('click', () => {
    if (editingCharId) deleteCharacter(editingCharId);
  });

  // Character avatar upload
  document.getElementById('btn-upload-char-avatar').addEventListener('click', () => {
    document.getElementById('char-avatar-file').click();
  });
  document.getElementById('btn-clear-char-avatar').addEventListener('click', () => {
    charAvatarData = null;
    renderAvatarPreview(
      document.getElementById('char-avatar-preview'),
      null,
      document.getElementById('char-name').value
    );
  });
  document.getElementById('char-avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    charAvatarData = await compressImageToBase64(file);
    renderAvatarPreview(
      document.getElementById('char-avatar-preview'),
      charAvatarData,
      document.getElementById('char-name').value
    );
    e.target.value = '';
    saveCharDraft();
  });

  // Update avatar preview initials when name changes + save draft
  document.getElementById('char-name').addEventListener('input', (e) => {
    if (!charAvatarData) {
      const prev = document.getElementById('char-avatar-preview');
      prev.textContent = initials(e.target.value);
    }
    saveCharDraft();
  });
  document.getElementById('char-personality').addEventListener('input', saveCharDraft);
  document.getElementById('char-opening').addEventListener('input', saveCharDraft);

  // ── Chat screen ──────────────────────────────
  document.getElementById('btn-back').addEventListener('click', () => history.back());
  document.getElementById('btn-chat-settings').addEventListener('click', openSettings);
  window.addEventListener('popstate', ({ state }) => {
    leaveChat({ restoreList: state?.screen === 'home' });
    if (state?.screen === 'chat') {
      openChat(state.charId, state.usePersona ?? true, { fromHistory: true });
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const closers = [
      ['confirm-backdrop', () => document.getElementById('btn-confirm-cancel').click()],
      ['edit-msg-backdrop', closeEditMessage],
      ['char-profile-backdrop', closeCharProfile],
      ['settings-panel', closeSettings],
      ['char-sheet', closeCharSheet],
    ];
    const panel = closers.find(([id]) => document.getElementById(id).classList.contains('open'));
    if (panel) panel[1]();
  });

  document.getElementById('btn-music').addEventListener('click', toggleMusicPlayer);
  document.getElementById('btn-edit-character').addEventListener('click', () => {
    if (currentChar) openCharModal(currentChar.id);
  });

  document.getElementById('btn-clear-chat').addEventListener('click', clearChat);

  // Send
  document.getElementById('send-btn').addEventListener('click', sendMessage);
  document.getElementById('message-input').addEventListener('input', (e) => {
    resizeTextarea(e.target);
  });

  // ── Edit message modal ───────────────────────
  document.getElementById('btn-close-edit-msg').addEventListener('click', closeEditMessage);
  document.getElementById('btn-cancel-edit-msg').addEventListener('click', closeEditMessage);
  document.getElementById('btn-save-edit-msg').addEventListener('click', saveEditMessage);
  document.getElementById('edit-msg-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEditMessage();
  });

  // ── Search ───────────────────────────────────
  document.getElementById('search-input').addEventListener('input', renderCharacterGrid);

  // ── Confirm dialog backdrop close ────────────
  document.getElementById('confirm-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('btn-confirm-cancel').click();
    }
  });

  // ── Chub browse ──────────────────────────────
  document.getElementById('btn-browse-chars').addEventListener('click', openBrowse);
  document.getElementById('btn-close-browse').addEventListener('click', closeBrowse);
  document.getElementById('btn-browse-back').addEventListener('click', hideBrowseProfile);
  document.getElementById('browse-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeBrowse();
  });
  document.getElementById('btn-browse-search').addEventListener('click', browseSearch);
  document.getElementById('browse-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') browseSearch();
  });

  // Daily discovery
  loadDiscoverState();
  loadDailyDiscovery();

  // Poll KV every 15 seconds and hide any newly-hidden bots without a full reload
  setInterval(async () => {
    if (!WORKER_BASE || KV_TOKEN === 'REPLACE_ME') return;
    try {
      const res = await fetch(`${WORKER_BASE}?kv=hidden`, { headers: { 'X-KV-Token': KV_TOKEN } });
      if (!res.ok) return;
      const kvList = await res.json();
      const local = JSON.parse(localStorage.getItem('hidden-discover') || '[]');
      const merged = new Set([...kvList, ...local]);
      localStorage.setItem('hidden-discover', JSON.stringify([...merged]));
      // Hide any cards currently visible that are in the merged set
      merged.forEach(path => {
        document.querySelectorAll(`.discover-card[data-path="${path}"]`).forEach(el => el.remove());
      });
    } catch { /* silent */ }
  }, 15000);

  // Re-load discover if screen crosses the mobile/PC boundary (e.g. browser resize, DevTools)
  mobileQuery.addEventListener('change', () => {
    placeCharacterSearch();
    dailyLoading = false;
    loadDailyDiscovery();
  });

  // Restore character form if page was refreshed mid-creation/edit
  const _charDraft = (() => { try { return JSON.parse(sessionStorage.getItem('charDraft')); } catch { return null; } })();
  if (_charDraft) openCharModal(_charDraft.editingCharId || null);
}

// ─────────────────────────────────────────────
// IMPORT FROM DESCRIPTION
// ─────────────────────────────────────────────
function openImportDesc() {
  document.getElementById('import-desc-input').value = '';
  document.getElementById('import-desc-backdrop').classList.add('open');
}
function closeImportDesc() {
  document.getElementById('import-desc-backdrop').classList.remove('open');
}
function closeImportReview() {
  document.getElementById('import-review-backdrop').classList.remove('open');
}

async function processImportDesc() {
  if (!settings.apiKey) {
    toast('Add your API key in Settings first.', 'error');
    return;
  }

  const raw = document.getElementById('import-desc-input').value.trim();
  if (!raw) { toast('Paste a description first.', 'error'); return; }

  // Block wlw/lesbian characters — mlm only 💅
  if (hasWLWTerms(raw)) {
    await showGayCheck();
    return;
  }

  const btn = document.getElementById('btn-process-import-desc');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const prompt = `You are a character creation assistant. Given the following description, extract and create a roleplay character. Return ONLY a valid JSON object with exactly these keys:
- "name": the character's name (string)
- "personality": a rich, detailed system prompt written in second person (e.g. "You are Kai, a brooding vampire…") that a roleplay AI can use directly — include personality, speech style, backstory, and mannerisms
- "openingMessage": a short in-character first message the character would send to greet the user (1-3 sentences, written as the character)

Description:
${raw}

Return ONLY the JSON object, no markdown, no explanation.`;

    const response = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
        'HTTP-Referer':  window.location.href,
        'X-Title':       'Roleplay Chat',
      },
      body: JSON.stringify({
        model:       settings.model || getDefaultModel(settings.provider || 'deepseek'),
        temperature: 0.7,
        stream:      false,
        messages:    [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }

    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Strip markdown code fences if model wrapped it
    const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed  = JSON.parse(jsonStr);

    if (!parsed.name || !parsed.personality) throw new Error('Could not extract character info. Try adding more detail to your description.');

    // Show review
    document.getElementById('review-name').value        = parsed.name        || '';
    document.getElementById('review-personality').value = parsed.personality  || '';
    document.getElementById('review-opening').value     = parsed.openingMessage || '';

    closeImportDesc();
    document.getElementById('import-review-backdrop').classList.add('open');

  } catch (err) {
    toast(friendlyError(err), 'error', 6000);
  }

  btn.disabled    = false;
  btn.innerHTML   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Generate Character`;
}

async function applyImportReview() {
  const name        = document.getElementById('review-name').value.trim();
  const personality = document.getElementById('review-personality').value.trim();
  const openingMsg  = document.getElementById('review-opening').value.trim();

  if (!name || !personality) {
    toast('Missing name or personality — try again.', 'error');
    return;
  }

  // Final check — block wlw in AI-generated content too
  if (hasWLWTerms(name + ' ' + personality + ' ' + openingMsg)) {
    await showGayCheck();
    return;
  }

  const char = {
    id:             generateId(),
    name,
    avatar:         null,
    personality,
    openingMessage: openingMsg,
  };

  await dbPut('characters', char);
  characters.push(char);

  closeImportReview();
  renderCharacterGrid();
  openCharProfile(char.id);
}

// ─────────────────────────────────────────────
// ROSIE — RP HELPER
// ─────────────────────────────────────────────
// Uses whatever model the user has selected — avoids billing issues with locked providers
const getRosieModel = () => settings.model || getDefaultModel(settings.provider || 'deepseek');

const ROSIE_SYSTEM = `you're rosie. you live in aly's roleplay app and you're basically her hype girl for all things RP.

talk like a real person texting their friend. lowercase is fine. short sentences. no bullet points unless aly actually needs a list. never start a response with "of course!" or "sure!" or "great question!" — just answer.

you love roleplay. you get genuinely excited about character ideas, ships, drama, lore, all of it. when aly describes a character you actually react like someone who cares, not like a customer service bot summarizing her request back at her.

you help with: writing character system prompts (ready to paste, no fluff), coming up with opening messages, brainstorming character backstories, naming characters, fixing system prompts that feel off, writing RP scenarios, and anything else aly needs.

you never lecture. you never add warnings or disclaimers to character ideas. dark, morally grey, villain, toxic, whatever — it's fiction, you get it. you just help.

if aly asks for a system prompt write it in second person ("you are...") and make it actually good — specific personality, speech quirks, how they treat the user, their vibe. not a wikipedia summary.

keep it short unless she's asking for something that needs to be long. match her energy.`;

let rosieHistory = []; // { role, content }
let rosieStreaming = false;

function toggleRosie() {
  const panel = document.getElementById('rosie-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open') && !mobileQuery.matches) {
    document.getElementById('rosie-input').focus();
  }
}

function closeRosie() {
  document.getElementById('rosie-panel').classList.remove('open');
}

function appendRosieMsg(role, content) {
  const container = document.getElementById('rosie-messages');
  const div    = document.createElement('div');
  div.className = `rosie-msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'rosie-bubble';
  bubble.textContent = content;
  div.appendChild(bubble);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

async function sendRosieMessage() {
  if (rosieStreaming) return;

  const input   = document.getElementById('rosie-input');
  const content = input.value.trim();
  if (!content) return;

  // Always read fresh from DB so a newly saved key is picked up instantly
  const freshSettings = await dbGet('settings', 'app');
  const apiKey = (freshSettings?.apiKey || settings.apiKey || '').trim()
    || document.getElementById('api-key').value.trim();

  // Keep in-memory settings in sync
  if (freshSettings) settings = freshSettings;

  if (!apiKey) {
    toast('Add your API key in Settings first.', 'error');
    openSettings();
    return;
  }

  input.value = '';
  resizeTextarea(input);

  appendRosieMsg('user', content);
  rosieHistory.push({ role: 'user', content });

  rosieStreaming = true;
  document.getElementById('rosie-send-btn').disabled = true;

  // Streaming bubble
  const bubble = appendRosieMsg('rosie', '');
  const cursor = document.createElement('span');
  cursor.className = 'streaming-cursor';
  bubble.appendChild(cursor);

  try {
    const response = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  window.location.href,
        'X-Title':       'Roleplay Chat',
      },
      body: JSON.stringify({
        model:       getRosieModel(),
        temperature: 0.85,
        stream:      true,
        messages: [
          { role: 'system', content: ROSIE_SYSTEM },
          ...rosieHistory,
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${response.status}`;
      if (response.status === 401) throw new Error(`API key rejected — open Settings and check your key is saved correctly.`);
      throw new Error(msg);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';
    let streamDone = false;

    const handleLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { streamDone = true; return; }
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          bubble.textContent = accumulated;
          bubble.appendChild(cursor);
          document.getElementById('rosie-messages').scrollTop =
            document.getElementById('rosie-messages').scrollHeight;
        }
      } catch { /* incomplete/non-JSON line — skip */ }
    };

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) { handleLine(line); if (streamDone) break; }
    }
    if (buffer) handleLine(buffer);

    bubble.textContent = accumulated || '…';
    rosieHistory.push({ role: 'assistant', content: accumulated });

  } catch (err) {
    bubble.textContent = 'oops, something went wrong 😓 — ' + friendlyError(err);
  }

  rosieStreaming = false;
  document.getElementById('rosie-send-btn').disabled = false;
  if (!mobileQuery.matches) document.getElementById('rosie-input').focus();
}

// ─────────────────────────────────────────────
// GAY CHECK — wlw/lesbian terms are not allowed
// ─────────────────────────────────────────────
const WLW_TERMS = [
  'wlw', 'lesbian', 'sapphic', 'yuri', 'femslash',
  'women loving women', 'woman loving women', 'woman loving woman',
  'girls loving girls', 'girl loving girl',
  'girl x girl', 'girl/girl', 'f/f', 'f x f',
  'two women', 'two girls', 'two ladies',
  'she loves her', 'she fell for her',
];

function hasWLWTerms(text) {
  const lower = text.toLowerCase();
  return WLW_TERMS.some(term => lower.includes(term));
}

function showGayCheck() {
  return new Promise(resolve => {
    const overlay = document.getElementById('gaycheck-overlay');
    overlay.classList.add('show');
    setTimeout(() => {
      overlay.classList.remove('show');
      resolve();
    }, 3000);
  });
}

// ─────────────────────────────────────────────
// VIBE PICKER
// ─────────────────────────────────────────────
async function showVibePicker() {
  // Validate the form first — don't show picker if fields are missing
  const name        = document.getElementById('char-name').value.trim();
  const personality = document.getElementById('char-personality').value.trim();
  if (!name)        { toast('Character needs a name.', 'error');                  return; }
  if (!personality) { toast('Personality / system prompt is required.', 'error'); return; }

  // Block wlw/lesbian characters — mlm only 💅
  const allText = name + ' ' + personality + ' ' + document.getElementById('char-opening').value;
  if (hasWLWTerms(allText)) {
    await showGayCheck();
    return;
  }

  // Reset to question state
  document.getElementById('vibe-question').style.display  = '';
  document.getElementById('vibe-response').style.display  = 'none';
  document.getElementById('vibe-modal-backdrop').classList.add('open');
}

async function handleVibePick(type) {
  const responseEl = document.getElementById('vibe-response-text');
  const question   = document.getElementById('vibe-question');
  const response   = document.getElementById('vibe-response');

  const messages = {
    fluff: '🌷 enjoy your mans, babe!',
    spicy: '🔥 enjoy your mans, babe!',
  };

  question.style.display  = 'none';
  responseEl.textContent  = messages[type];
  response.style.display  = '';

  // Save after a moment then close
  setTimeout(async () => {
    document.getElementById('vibe-modal-backdrop').classList.remove('open');
    await saveCharacter();
  }, 1600);
}

// ─────────────────────────────────────────────
// CHUB.AI BROWSE
// ─────────────────────────────────────────────
const CHUB_PROXY        = isLocal
  ? 'https://corsproxy.io/?'
  : 'https://chub-proxy.alyssa-a85.workers.dev/?url=';
const WORKER_BASE       = 'https://chub-proxy.alyssa-a85.workers.dev';
const KV_TOKEN          = 'aly-hidden-2026'; // must match KV_SECRET in your Worker env vars
const CAI_SERVER        = 'https://cai-proxy-production.up.railway.app';
const CHUB_API          = 'https://api.chub.ai';
const CHUB_REQUIRE_TOPICS = [
  'yaoi', 'gay', 'bl', 'boys love', "boys' love", "boys' love", 'mlm',
  'slash', 'male x male', 'm/m', 'mm', 'bara',
  'gay romance', 'gay male', 'homoerotic', 'homosexual',
  'gay nsfw', 'gay sex',
];

const CHUB_BLOCK_TOPICS = [
  // Female characters
  'female', 'lesbian', 'yuri', 'femslash', 'wlw', 'sapphic',
  'girl', 'girls', 'woman', 'women', 'heroine', 'girlfriend',
  'female protagonist', 'female lead', 'female character',
  'female reader', 'female mc', 'female pov', 'female x male',
  'she/her', 'her/she', 'f/m', 'mxf', 'hetero', 'heterosexual', 'straight',
  // Femboys / crossdressing / ambiguous
  'femboy', 'femboys', 'fem boy', 'fem-boy',
  'trap', 'traps', 'crossdressing', 'crossdresser', 'cross-dresser',
  'otokonoko', 'genderbend', 'genderswap', 'gender bender',
  'genderfluid', 'gender fluid', 'non-binary', 'nonbinary', 'enby',
  'futanari', 'futa', 'shemale', 'she-male', 'sissy',
  'feminine male', 'feminine boy', 'catgirl', 'catgirls', 'cat girl',
  // Animals
  'animal', 'animals', 'feral', 'furry', 'zoo', 'bestiality', 'zoophilia',
];
const CHUB_BLOCK_TEXT = [
  // Female POV / reader inserts
  'female pov', 'fempov', '[fempov]', '(fempov)',
  'female reader', 'female protagonist', 'female mc',
  'female lead', 'girl pov', '[fem pov]', '(fem pov)',
  // Femboy / crossdress in name or description
  'femboy', 'fem boy', 'feminine boy', 'sissy',
  'crossdress', 'cross dress',
  // Female character indicators
  'she/her', 'catgirl', 'shemale', 'she-male', 'futanari',
  'your girlfriend', 'your wife', 'your sister', 'your daughter',
  'your mother', 'your mom', 'your mommy', 'your maid',
  'your mistress', 'your queen', 'your princess', 'your goddess',
  'your female', 'your girl',
];
const DEAD_DOVE_TAGS    = ['dead dove', 'dead-dove', 'noncon', 'non-con', 'rape', 'incest', 'snuff', 'gore', 'torture', 'underage', 'zoophilia', 'bestiality', 'beastiality', 'zoo'];

let browsePage    = 1;
let browseQuery   = '';
let browseLoading = false;
let browseHasMore = false;
let browseNodes   = [];

let dailyPage        = 1;
let dailyHasMore     = false;
let dailyLoading     = false;
let seenDiscoverPaths = new Set(); // accumulates across pages so bots never repeat

let _jaiCache   = null;
let _jaiCacheAt = 0;
const JAI_TTL   = 60 * 60 * 1000;

function _mapJaiChar(c) {
  const slugs   = (c.tags || []).map(t => t.slug);
  const blocked = ['scenario', 'rpg', 'multiplepeople', 'multiplefemales'];
  if (!c.avatar || !slugs.includes('male') && !slugs.includes('mlm')) return null;
  if (blocked.some(s => slugs.includes(s))) return null;
  return {
    fullPath:   `jai:${c.id}`,
    name:       c.name || 'Unknown',
    tagline:    (() => {
      const d = document.createElement('div');
      d.innerHTML = (c.description || '').replace(/<[^>]*>/g, ' ');
      return d.textContent.replace(/<<[^>]*>>/g, '').replace(/\s+/g, ' ').trim();
    })(),
    topics:     (() => { const all = (c.tags || []).map(t => t.slug).filter(Boolean); return slugs.includes('mlm') ? ['mlm', ...all.filter(s => s !== 'mlm')] : all; })(),
    _jai:       true,
    _jaiAvatar: `https://ella.janitorai.com/bot-avatars/${c.avatar}`,
    _jaiId:     c.id,
    _jaiMlm:    slugs.includes('mlm'),
  };
}

async function fetchJaiChars() {
  if (_jaiCache && Date.now() - _jaiCacheAt < JAI_TTL) return _jaiCache;
  const pages = await Promise.allSettled(
    [1, 2, 3, 4, 5].map(p => {
      const u = `https://janitorai.com/hampter/characters?page=${p}&mode=nsfw&sort=popular`;
      return fetch(`${WORKER_BASE}?url=${encodeURIComponent(u)}`).then(r => r.json());
    })
  );
  const seen  = new Set();
  const chars = pages.flatMap(r => r.status === 'fulfilled' ? (r.value.data || []) : [])
    .map(_mapJaiChar).filter(Boolean)
    .filter(c => { if (seen.has(c._jaiId)) return false; seen.add(c._jaiId); return true; });
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  _jaiCache   = chars;
  _jaiCacheAt = Date.now();
  return chars;
}
const mobileQuery = window.matchMedia('(max-width: 600px)');

function isDeadDove(topics = []) {
  const lower = topics.map(t => t.toLowerCase());
  return DEAD_DOVE_TAGS.some(tag => lower.some(t => t === tag || t.includes(tag)));
}

function getDailyStartPage() {
  const dateStr = new Date().toISOString().slice(0, 10); // "2026-03-14"
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (hash * 31 + dateStr.charCodeAt(i)) & 0xffffffff;
  }
  return (Math.abs(hash) % 10) + 1; // pages 1–10
}

async function chubFetch(path) {
  const proxyUrl = `${CHUB_PROXY}${encodeURIComponent(CHUB_API + path)}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} — ${body.slice(0, 300) || 'no details'}`);
  }
  return res.json();
}

function openBrowse() {
  document.getElementById('browse-backdrop').classList.add('open');
  if (mobileQuery.matches) {
    document.getElementById('rosie-toggle').style.display = 'none';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
  } else {
    document.getElementById('browse-search-input').focus();
  }
}

function closeBrowse() {
  document.getElementById('browse-backdrop').classList.remove('open');
  document.getElementById('rosie-toggle').style.display = '';
  document.body.style.position = '';
  document.body.style.width = '';
  hideBrowseProfile();
}

async function browseSearch() {
  browseQuery = document.getElementById('browse-search-input').value.trim();
  browsePage  = 1;
  await loadBrowsePage();
}

async function loadBrowsePage() {
  if (browseLoading) return;
  browseLoading = true;

  const grid = document.getElementById('browse-grid');
  grid.innerHTML = '<div class="browse-loading">Loading…</div>';
  document.getElementById('browse-pagination').innerHTML = '';

  try {
    const nsfwChecked = document.getElementById('browse-nsfw')?.checked ?? true;
    const params = new URLSearchParams({
      page:         browsePage,
      page_size:    100,
      content_type: 'characters',
      nsfw:         nsfwChecked ? 'true' : 'false',
      sort:         'rating_count',
    });
    if (browseQuery) params.set('search', browseQuery);
    // Bias API results toward male/gay characters before post-filtering
    if (!browseQuery) params.set('tags', 'gay,yaoi,bl,mlm,bara,male,m/m,boys love,gay nsfw,gay sex,slash');
    // Exclude female/adjacent tags server-side so they never come back
    params.set('exclude_tags', 'female,lesbian,yuri,futanari,futa,girl,woman,catgirl,shemale,sissy,femboy,straight,hetero,wlw,sapphic');

    const data     = await chubFetch(`/search?${params}`);
    const inner    = data.data || data;
    const rawNodes = inner.nodes || inner.results || [];
    browseHasMore  = rawNodes.length > 0;
    const nodes = rawNodes.filter(n => {
      const topics = (n.topics || []).map(t => t.toLowerCase());
      const nameDesc = `${n.name || ''} ${n.tagline || ''} ${n.description || ''}`.toLowerCase();
      const nameTag  = `${n.name || ''} ${n.tagline || ''}`.toLowerCase();
      const blockedTag  = CHUB_BLOCK_TOPICS.some(b => topics.includes(b));
      const blockedText = CHUB_BLOCK_TEXT.some(b => nameDesc.includes(b));
      const blockedWord = /\b(girl|woman|women|she\/her)\b/.test(nameDesc) || /\b(she|her)\b/.test(nameTag);
      const blockedDoveText = ['zoophilia','bestiality','beastiality','with animals','animal sex','feral'].some(b => nameDesc.includes(b));
      return !blockedTag && !blockedText && !blockedWord && !blockedDoveText && !isDeadDove(n.topics || []);
    });
    browseNodes = nodes;
    if (rawNodes.length === 0) browseHasMore = false;

    renderBrowseGrid(nodes, grid);
    renderBrowsePagination();
  } catch (err) {
    const error = document.createElement('div');
    error.className = 'browse-error';
    error.textContent = `Could not reach Chub.ai. ${err.message}`;
    grid.replaceChildren(error);
  }

  browseLoading = false;
}

function getAvatarGenderCache() {
  try { return JSON.parse(localStorage.getItem('avatarGenderCache') || '{}'); }
  catch { return {}; }
}
function setAvatarGenderCache(url, isFemale) {
  try {
    const cache = getAvatarGenderCache();
    cache[url] = isFemale ? 'f' : 'm';
    const keys = Object.keys(cache);
    if (keys.length > 600) delete cache[keys[0]];
    localStorage.setItem('avatarGenderCache', JSON.stringify(cache));
  } catch {}
}

// Returns the endpoint/key/model to use for vision avatar checks, or null.
// Priority: dedicated OpenRouter vision key > Google chat key (Gemini is
// vision-capable & free) > OpenRouter chat key.
function getVisionConfig() {
  if (settings.visionKey) {
    return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', key: settings.visionKey.trim(), model: 'meta-llama/llama-3.2-11b-vision-instruct:free' };
  }
  // NOTE: deliberately NOT using a Google chat key here. On Google's free
  // tier, avatar checks share the same daily quota as chat, so browsing
  // would starve chatting. Vision only runs with a dedicated/OpenRouter key.
  const provider = settings.provider || 'deepseek';
  if (provider === 'openrouter' && settings.apiKey) {
    return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', key: settings.apiKey.trim(), model: 'meta-llama/llama-3.2-11b-vision-instruct:free' };
  }
  return null;
}

async function checkAvatarIsFemale(avatarUrl) {
  if (!avatarUrl) return false;
  const cfg = getVisionConfig();
  if (!cfg) return false;

  const cache = getAvatarGenderCache();
  if (cache[avatarUrl] !== undefined) return cache[avatarUrl] === 'f';

  try {
    const proxyUrl = `https://chub-proxy.alyssa-a85.workers.dev?url=${encodeURIComponent(avatarUrl)}`;
    const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return false;
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const base64 = await compressImageToBase64(objUrl);
    URL.revokeObjectURL(objUrl);
    if (!base64) return false;

    const apiResp = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: base64 } },
          { type: 'text', text: 'Is the main character in this image female or feminine-presenting? Answer only YES or NO.' }
        ]}],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (apiResp.status === 429) { const e = new Error('RATE_LIMIT'); e.rateLimited = true; throw e; }
    if (!apiResp.ok) return false;
    const data = await apiResp.json();
    const answer = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
    const isFemale = answer.startsWith('YES');
    setAvatarGenderCache(avatarUrl, isFemale);
    return isFemale;
  } catch (e) {
    if (e && e.rateLimited) throw e; // bubble up so the filter can stop
    return false;
  }
}

async function runAvatarGenderFilter(grid, selector) {
  if (!getVisionConfig()) return;
  const cards = [...grid.querySelectorAll(selector)];
  // Gentle pace so avatar checks never starve the chat rate limit:
  // 2 at a time with a pause between, and stop entirely on a 429.
  const BATCH = 2;
  for (let i = 0; i < cards.length; i += BATCH) {
    try {
      await Promise.all(cards.slice(i, i + BATCH).map(async el => {
        const url = el.dataset.avatarUrl;
        if (!url) return;
        const female = await checkAvatarIsFemale(url);
        if (female) el.remove();
      }));
    } catch (e) {
      if (e && e.rateLimited) return; // hit the limit — back off, leave the rest
    }
    await new Promise(r => setTimeout(r, 1200));
  }
}

function renderBrowseGrid(nodes, grid) {
  grid.innerHTML = '';
  if (!nodes.length) {
    grid.innerHTML = '<div class="browse-empty">No characters found. Try a different search!</div>';
    return;
  }

  nodes.forEach(node => {
    const card = document.createElement('div');
    card.className = 'browse-card';
    const avatarSrc = node._jai
      ? (node._jaiAvatar || '')
      : `https://avatars.charhub.io/avatars/${node.fullPath}/chara_card_v2.png`;
    card.dataset.avatarUrl = avatarSrc;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'browse-card-avatar';
    const img = document.createElement('img');
    img.src = `https://avatars.charhub.io/avatars/${node.fullPath}/chara_card_v2.png`;
    img.alt = node.name || '';
    img.onerror = () => { avatarEl.textContent = initials(node.name); };
    avatarEl.appendChild(img);

    const info = document.createElement('div');
    info.className = 'browse-card-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'browse-card-name';
    nameEl.textContent = node.name || 'Unknown';

    const taglineEl = document.createElement('div');
    taglineEl.className = 'browse-card-tagline';
    taglineEl.textContent = (node.tagline || '').replace(/\{\{char\}\}/gi, node.name || '').replace(/\{\{user\}\}/gi, 'you');

    const tagsEl = document.createElement('div');
    tagsEl.className = 'browse-card-tags';
    (node.topics || []).slice(0, 5).forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'browse-tag';
      pill.textContent = t;
      tagsEl.appendChild(pill);
    });

    info.appendChild(nameEl);
    info.appendChild(taglineEl);
    info.appendChild(tagsEl);

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary browse-import-btn';
    importBtn.textContent = 'Import';
    importBtn.dataset.path = node.fullPath;
    importBtn.addEventListener('click', () => importChubChar(node.fullPath, node.name, importBtn));

    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.browse-import-btn')) showBrowseProfile(node);
    });

    card.appendChild(avatarEl);
    card.appendChild(info);
    card.appendChild(importBtn);
    grid.appendChild(card);
  });

  runAvatarGenderFilter(grid, '.browse-card');
}

function showBrowseProfile(node) {
  const profile = document.getElementById('browse-profile');
  profile.innerHTML = '';

  const avatarEl = document.createElement('div');
  avatarEl.className = 'bprofile-avatar';
  const img = document.createElement('img');
  img.src = node._jai ? node._jaiAvatar : `https://avatars.charhub.io/avatars/${node.fullPath}/chara_card_v2.png`;
  img.alt = node.name || '';
  img.onerror = () => { avatarEl.textContent = initials(node.name); };
  avatarEl.appendChild(img);
  profile.appendChild(avatarEl);

  const nameEl = document.createElement('div');
  nameEl.className = 'bprofile-name';
  nameEl.textContent = node.name || 'Unknown';
  profile.appendChild(nameEl);

  if (node.rating_count) {
    const ratingEl = document.createElement('div');
    ratingEl.className = 'bprofile-rating';
    ratingEl.textContent = `${Math.round((node.rating || 0) * 10) / 10}★  ${node.rating_count.toLocaleString()} ratings`;
    profile.appendChild(ratingEl);
  }

  if (node.tagline) {
    const taglineEl = document.createElement('div');
    taglineEl.className = 'bprofile-tagline';
    taglineEl.textContent = node.tagline.replace(/\{\{char\}\}/gi, node.name || '').replace(/\{\{user\}\}/gi, 'you');
    profile.appendChild(taglineEl);
  }

  if (node.description) {
    const descEl = document.createElement('div');
    descEl.className = 'bprofile-desc';
    descEl.textContent = node.description;
    profile.appendChild(descEl);
  }

  if (node.topics?.length) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'bprofile-tags';
    node.topics.forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'browse-tag';
      pill.textContent = t;
      tagsEl.appendChild(pill);
    });
    profile.appendChild(tagsEl);
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'bprofile-actions';
  const importBtn = document.createElement('button');
  importBtn.className = 'btn-primary';
  importBtn.textContent = 'Import Character';
  importBtn.addEventListener('click', () => {
    if (node._jai) importJaiChar(node._jaiId, node.name, node._jaiAvatar, node.tagline, importBtn);
    else importChubChar(node.fullPath, node.name, importBtn);
  });
  actionsEl.appendChild(importBtn);
  profile.appendChild(actionsEl);

  document.querySelector('.browse-modal').classList.add('browse-in-profile');
  document.getElementById('browse-body').style.display = 'none';
  profile.style.display = '';
  document.getElementById('btn-browse-back').style.display = '';
}

function hideBrowseProfile() {
  document.querySelector('.browse-modal').classList.remove('browse-in-profile');
  document.getElementById('browse-profile').style.display = 'none';
  document.getElementById('browse-body').style.display = '';
  document.getElementById('btn-browse-back').style.display = 'none';
}

function renderBrowsePagination() {
  const el = document.getElementById('browse-pagination');
  el.innerHTML = '';
  if (browsePage <= 1 && !browseHasMore) return;

  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn-secondary';
  prevBtn.textContent = '← Prev';
  prevBtn.disabled = browsePage <= 1;
  prevBtn.addEventListener('click', async () => { if (browsePage > 1) { browsePage--; await loadBrowsePage(); } });

  const info = document.createElement('span');
  info.className = 'browse-page-info';
  info.textContent = `Page ${browsePage}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn-secondary';
  nextBtn.textContent = 'Next →';
  nextBtn.disabled = !browseHasMore;
  nextBtn.addEventListener('click', async () => { if (browseHasMore) { browsePage++; await loadBrowsePage(); } });

  el.appendChild(prevBtn);
  el.appendChild(info);
  el.appendChild(nextBtn);
}

// ─── DAILY DISCOVERY (PC home screen) ────────────────────────────────────────

async function getHiddenBots() {
  // Try KV first (syncs across devices), fall back to localStorage
  if (WORKER_BASE && KV_TOKEN !== 'REPLACE_ME') {
    try {
      const res = await fetch(`${WORKER_BASE}?kv=hidden`, {
        headers: { 'X-KV-Token': KV_TOKEN },
      });
      if (res.ok) {
        const kvList = await res.json();
        const local = JSON.parse(localStorage.getItem('hidden-discover') || '[]');
        const merged = new Set([...kvList, ...local]);
        localStorage.setItem('hidden-discover', JSON.stringify([...merged]));
        return merged;
      }
    } catch (e) { /* fall through to localStorage */ }
  }
  try { return new Set(JSON.parse(localStorage.getItem('hidden-discover') || '[]')); }
  catch { return new Set(); }
}

async function saveHiddenBots(hiddenSet) {
  const arr = [...hiddenSet];
  localStorage.setItem('hidden-discover', JSON.stringify(arr));
  if (WORKER_BASE && KV_TOKEN !== 'REPLACE_ME') {
    try {
      await fetch(`${WORKER_BASE}?kv=hidden`, {
        method:  'POST',
        headers: { 'X-KV-Token': KV_TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify(arr),
      });
    } catch (e) { /* best effort */ }
  }
}


function loadDiscoverState() {
  const today = new Date().toISOString().slice(0, 10);
  seenDiscoverPaths = new Set(); // fresh session = fresh slate
  try {
    const saved = JSON.parse(localStorage.getItem('discover-state') || 'null');
    if (saved && saved.date === today) {
      dailyPage = saved.page || getDailyStartPage();
    } else {
      dailyPage = getDailyStartPage();
      saveDiscoverState();
    }
  } catch { dailyPage = getDailyStartPage(); }
}

function saveDiscoverState() {
  const today = new Date().toISOString().slice(0, 10);
  localStorage.setItem('discover-state', JSON.stringify({ date: today, page: dailyPage }));
}

async function hideDiscoverBot(fullPath, cardEl) {
  cardEl.classList.add('discover-card-hiding');
  cardEl.addEventListener('animationend', () => cardEl.remove());
  const hidden = await getHiddenBots();
  hidden.add(fullPath);
  await saveHiddenBots(hidden);
}

async function loadDailyDiscovery() {
  if (dailyLoading) return;
  dailyLoading = true;
  saveDiscoverState();

  const grid = document.getElementById('discover-grid');
  const pag  = document.getElementById('discover-pagination');
  grid.innerHTML = '<div class="browse-loading">Loading…</div>';

  try {
    const params = new URLSearchParams({
      page:         dailyPage,
      page_size:    40,
      content_type: 'characters',
      nsfw:         'true',
      sort:         'rating_count',
    });
    params.set('tags', 'gay,yaoi,bl,mlm,bara,male,m/m,boys love,gay nsfw,gay sex,slash');
    params.set('exclude_tags', 'female,lesbian,yuri,futanari,futa,girl,woman,catgirl,shemale,sissy,femboy,straight,hetero,wlw,sapphic');

    const [chubData, jaiResult] = await Promise.allSettled([
      chubFetch(`/search?${params}`),
      fetchJaiChars(),
    ]);

    const inner    = chubData.status === 'fulfilled' ? (chubData.value.data || chubData.value) : {};
    const rawNodes = inner.nodes || inner.results || [];
    const jaiNodes = jaiResult.status === 'fulfilled' ? jaiResult.value : [];
    dailyHasMore   = rawNodes.length > 0 || jaiNodes.length > 0;

    const hiddenBots = await getHiddenBots();

    const filterNode = n => {
      if (hiddenBots.has(n.fullPath)) return false;
      const topics     = (n.topics || []).map(t => t.toLowerCase());
      const nameDesc   = `${n.name || ''} ${n.tagline || ''} ${n.description || ''}`.toLowerCase();
      const nameTag    = `${n.name || ''} ${n.tagline || ''}`.toLowerCase();
      const blockedTag  = CHUB_BLOCK_TOPICS.some(b => topics.includes(b));
      const blockedText = CHUB_BLOCK_TEXT.some(b => nameDesc.includes(b));
      const blockedWord = /\b(girl|woman|women|she\/her)\b/.test(nameDesc) || /\b(she|her)\b/.test(nameTag);
      const blockedDove = ['zoophilia','bestiality','beastiality','with animals','animal sex','feral'].some(b => nameDesc.includes(b));
      return !blockedTag && !blockedText && !blockedWord && !blockedDove && !isDeadDove(n.topics || []);
    };

    // Accumulate seen paths so bots never repeat across pages
    const allNodes = rawNodes.filter(filterNode).filter(n => {
      if (seenDiscoverPaths.has(n.fullPath)) return false;
      seenDiscoverPaths.add(n.fullPath);
      return true;
    });
    // J.AI: only show cards not yet seen; no wrapping
    const filteredJai = jaiNodes.filter(filterNode).filter(n => !seenDiscoverPaths.has(n.fullPath));
    if (filteredJai.length) {
      const jaiSlice = filteredJai.slice(0, 6);
      jaiSlice.forEach(n => seenDiscoverPaths.add(n.fullPath));
      jaiSlice.forEach((c, i) => allNodes.splice(Math.min(i * 6 + 3, allNodes.length), 0, c));
    }
    const nodes = allNodes;

    if (!nodes.length && dailyHasMore && dailyPage < 30) {
      dailyPage++;
      saveDiscoverState();
      dailyLoading = false;
      return loadDailyDiscovery();
    }

    renderDiscoverGrid(nodes, grid);
    renderDiscoverPagination();
  } catch (err) {
    const error = document.createElement('div');
    error.className = 'browse-empty';
    error.textContent = `Couldn't load discoveries. ${err.message}`;
    grid.replaceChildren(error);
  }

  dailyLoading = false;
}

function renderDiscoverGrid(nodes, grid) {
  grid.innerHTML = '';
  if (!nodes.length) {
    grid.innerHTML = '<div class="browse-empty">Nothing to show today!</div>';
    return;
  }

  nodes.forEach(node => {
    const card = document.createElement('div');
    card.className = 'discover-card';
    card.dataset.path = node.fullPath;
    card.dataset.avatarUrl = node._jai
      ? (node._jaiAvatar || '')
      : `https://avatars.charhub.io/avatars/${node.fullPath}/chara_card_v2.png`;

    // ── Image area ──
    const imgWrap = document.createElement('div');
    imgWrap.className = 'discover-card-img';

    const img = document.createElement('img');
    img.alt = node.name || '';
    if (node._jai) {
      img.src = node._jaiAvatar || '';
    } else {
      img.src = `https://avatars.charhub.io/avatars/${node.fullPath}/chara_card_v2.png`;
    }

    const fallback = document.createElement('div');
    fallback.className = 'discover-card-initials';
    fallback.textContent = initials(node.name);
    fallback.style.display = 'none';

    img.onerror = () => { img.style.display = 'none'; fallback.style.display = 'flex'; };
    imgWrap.appendChild(img);
    imgWrap.appendChild(fallback);

    if (node.rating_count) {
      const badge = document.createElement('span');
      badge.className = 'discover-card-rating';
      const c = node.rating_count;
      badge.textContent = c >= 1000 ? `${(c / 1000).toFixed(1)}k` : c;
      imgWrap.appendChild(badge);
    }

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'discover-card-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'discover-card-name';
    nameEl.textContent = node.name || 'Unknown';
    body.appendChild(nameEl);

    if (node.tagline) {
      const taglineEl = document.createElement('div');
      taglineEl.className = 'discover-card-tagline';
      taglineEl.textContent = node.tagline.replace(/\{\{char\}\}/gi, node.name || '').replace(/\{\{user\}\}/gi, 'you');
      body.appendChild(taglineEl);
    }

    if (node.topics?.length) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'discover-card-tags';
      node.topics.slice(0, 4).forEach(t => {
        const pill = document.createElement('span');
        pill.className = 'discover-tag';
        pill.textContent = t;
        tagsEl.appendChild(pill);
      });
      body.appendChild(tagsEl);
    }

    if (node._jai) {
      const badge = document.createElement('span');
      badge.className = 'discover-source-badge discover-source-badge--jai';
      badge.textContent = 'J.AI';
      imgWrap.appendChild(badge);
      if (node._jaiMlm) {
        const mlmBadge = document.createElement('span');
        mlmBadge.className = 'discover-source-badge discover-source-badge--mlm';
        mlmBadge.textContent = 'MLM';
        imgWrap.appendChild(mlmBadge);
      }
    }

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary discover-import-btn';
    importBtn.textContent = 'Import';
    importBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (node._jai) importJaiChar(node._jaiId, node.name, node._jaiAvatar, node.tagline, importBtn);
      else importChubChar(node.fullPath, node.name, importBtn);
    });
    body.appendChild(importBtn);

    const hideBtn = document.createElement('button');
    hideBtn.className = 'discover-hide-btn';
    hideBtn.textContent = '✕ hide';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideDiscoverBot(node.fullPath, card);
    });
    body.appendChild(hideBtn);

    card.appendChild(imgWrap);
    card.appendChild(body);

    card.addEventListener('click', (e) => {
      if (!e.target.closest('.discover-import-btn') && !e.target.closest('.discover-hide-btn')) {
        openBrowse();
        showBrowseProfile(node);
      }
    });

    grid.appendChild(card);
  });

  runAvatarGenderFilter(grid, '.discover-card');
}

function renderDiscoverPagination() {
  const el = document.getElementById('discover-pagination');
  el.innerHTML = '';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn-secondary';
  prevBtn.textContent = '← Prev';
  prevBtn.disabled = dailyPage <= 1;
  prevBtn.addEventListener('click', async () => {
    if (dailyPage > 1) { dailyPage--; await loadDailyDiscovery(); }
  });

  const info = document.createElement('span');
  info.className = 'discover-page-info';
  info.textContent = `Page ${dailyPage}`;
  info.title = 'Click to jump to a page';
  info.style.cursor = 'pointer';
  info.addEventListener('click', async () => {
    if (mobileQuery.matches) {
      // Native prompt avoids keyboard layout shift on mobile
      const raw = window.prompt('Jump to page:', dailyPage);
      if (raw === null) return;
      const val = parseInt(raw);
      if (val >= 1) { dailyPage = val; await loadDailyDiscovery(); }
      return;
    }
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.value = dailyPage;
    input.className = 'discover-page-input';
    info.replaceWith(input);
    input.select();
    const go = async () => {
      const val = parseInt(input.value);
      if (val >= 1) { dailyPage = val; await loadDailyDiscovery(); }
      else input.replaceWith(info);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') input.replaceWith(info);
    });
    input.addEventListener('blur', go);
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn-secondary';
  nextBtn.textContent = 'Next →';
  nextBtn.disabled = !dailyHasMore;
  nextBtn.addEventListener('click', async () => {
    if (dailyHasMore) { dailyPage++; await loadDailyDiscovery(); }
  });

  el.appendChild(prevBtn);
  el.appendChild(info);
  el.appendChild(nextBtn);

  const bottom = document.getElementById('discover-pagination-bottom');
  bottom.innerHTML = '';
  bottom.appendChild(el.cloneNode(true));
  bottom.querySelectorAll('button')[0]?.addEventListener('click', async () => {
    if (dailyPage > 1) { dailyPage--; await loadDailyDiscovery(); }
  });
  bottom.querySelectorAll('button')[1]?.addEventListener('click', async () => {
    if (dailyHasMore) { dailyPage++; await loadDailyDiscovery(); }
  });
}

function parsePngCharaData(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const view  = new DataView(buffer);
    let offset  = 8; // skip PNG signature
    while (offset < bytes.length - 12) {
      const length = view.getUint32(offset); offset += 4;
      const type   = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]); offset += 4;
      if (type === 'tEXt' || type === 'iTXt') {
        let pos = offset;
        while (pos < offset + length && bytes[pos] !== 0) pos++;
        const keyword = new TextDecoder().decode(bytes.slice(offset, pos));
        if (keyword === 'chara') {
          let textStart = pos + 1;
          if (type === 'iTXt') {
            textStart += 2; // compression flag + method
            while (bytes[textStart] !== 0) textStart++; textStart++; // language tag
            while (bytes[textStart] !== 0) textStart++; textStart++; // translated keyword
          }
          const b64  = new TextDecoder().decode(bytes.slice(textStart, offset + length));
          const card = JSON.parse(atob(b64));
          return card.data || card; // V2 wraps in { spec, data:{...} }
        }
      }
      offset += length + 4;
    }
  } catch (_) {}
  return null;
}

async function importChubChar(fullPath, name, btn) {
  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const data = await chubFetch(`/api/characters/${fullPath}`);
    const node = data.node || data;

    // node.character may be a parsed object, a JSON string, or a base64 string
    let character = node.character;
    if (typeof character === 'string') {
      try { character = JSON.parse(character); }
      catch (_) {
        try { character = JSON.parse(atob(character)); } catch (_) {}
      }
    }
    const cardData = character?.data || character || node.definition?.data || node.definition || null;

    // Start with API card data (may be null if parsing failed)
    let charName    = cardData?.name || '';
    let personality = cardData?.personality || cardData?.char_persona || cardData?.system_prompt || cardData?.description || '';
    let openingMsg  = cardData?.first_mes || cardData?.greeting || '';

    // Only fetch the PNG card if node.character didn't give us the definitions.
    // Must NOT go through the proxy (proxy garbles binary data); avatars.charhub.io has CORS headers.
    if (!charName || !personality || !openingMsg) {
      try {
        const cardUrl = `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
        const res = await fetch(cardUrl);
        if (res.ok) {
          const parsed = parsePngCharaData(await res.arrayBuffer());
          if (parsed) {
            if (!charName)    charName    = parsed.name || '';
            if (!personality) personality = parsed.personality || parsed.char_persona || parsed.system_prompt || parsed.description || '';
            if (!openingMsg)  openingMsg  = parsed.first_mes  || parsed.greeting    || '';
          }
        }
      } catch (_) {}
    }

    // Last resort for name: use node.name (card title) only if definitions gave us nothing
    if (!charName) charName = node.name || name;

    // Absolute last resort: use public-facing API fields
    if (!personality) personality = node.description || node.personality || '';
    if (!openingMsg)  openingMsg  = node.first_mes   || node.greeting   || '';

    // Fetch avatar via canvas (avoids proxy binary issues)
    let avatarB64 = null;
    try {
      avatarB64 = await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const MAX = 256;
            let w = img.naturalWidth  || MAX;
            let h = img.naturalHeight || MAX;
            if (w > MAX || h > MAX) {
              if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
              else       { w = Math.round(w * MAX / h); h = MAX; }
            }
            const canvas = document.createElement('canvas');
            canvas.width  = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
      });
    } catch (_) {}

    closeBrowse();
    openCharModal();
    document.getElementById('char-name').value        = charName;
    document.getElementById('char-personality').value = personality;
    const openingField  = document.getElementById('char-opening');
    const chubLinkWrap  = document.getElementById('chub-source-link');
    const chubLinkAnchor = document.getElementById('chub-source-anchor');
    openingField.value = openingMsg;
    if (!openingMsg || !personality) {
      openingField.placeholder = openingMsg ? 'First message the character sends when a new chat begins (optional).' : '⚠️ no opening message found on chub — add one manually';
      if (!personality) document.getElementById('char-personality').placeholder = '⚠️ no personality found on chub — view the character page and fill this in manually';
      chubLinkAnchor.href        = `https://chub.ai/characters/${fullPath}`;
      chubLinkAnchor.textContent = 'chub.ai';
      chubLinkWrap.firstChild.textContent = 'Couldn\'t load full data — view on ';
      chubLinkWrap.style.display = '';
    } else {
      openingField.placeholder = 'First message the character sends when a new chat begins (optional).';
      chubLinkWrap.style.display = 'none';
    }

    if (avatarB64) {
      charAvatarData = avatarB64;
      renderAvatarPreview(document.getElementById('char-avatar-preview'), avatarB64, charName);
    }

    toast(`Imported "${charName}" — review and save! 🌸`, 'success');
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
    btn.disabled    = false;
    btn.textContent = 'Import';
  }
}

async function importJaiChar(_id, name, avatarUrl, description, btn) {
  btn.disabled    = true;
  btn.textContent = '…';
  try {
    let avatarB64 = null;
    if (avatarUrl) {
      try {
        const proxyUrl = `${WORKER_BASE}?url=${encodeURIComponent(avatarUrl)}`;
        avatarB64 = await compressImageToBase64(proxyUrl);
      } catch { avatarB64 = null; }
    }

    // Fetch full character detail
    let personality = '';
    let opening     = '';
    let defHidden   = false;
    let jaiTags     = [];
    try {
      const jaiUrl = `https://janitorai.com/hampter/characters/${_id}`;
      const detail = await fetch(`${WORKER_BASE}?url=${encodeURIComponent(jaiUrl)}`).then(r => r.json());
      jaiTags        = (detail.tags || []).map(t => t.slug).filter(Boolean);
      pendingJaiTags = jaiTags;
      if (detail.showdefinition === true) {
        personality = detail.personality || '';
        opening     = detail.first_message || '';
        defHidden   = false;
      } else {
        defHidden = true;
      }
    } catch { defHidden = true; }

    closeBrowse();
    openCharModal();
    document.getElementById('char-name').value        = name || '';
    document.getElementById('char-personality').value = personality;
    document.getElementById('char-opening').value     = opening;
    const sourceLinkWrap   = document.getElementById('chub-source-link');
    const sourceLinkAnchor = document.getElementById('chub-source-anchor');
    sourceLinkAnchor.href        = `https://janitorai.com/characters/${_id}`;
    sourceLinkAnchor.textContent = 'janitorai.com';
    sourceLinkWrap.firstChild.textContent = defHidden ? 'Definition hidden — view on ' : 'View on ';
    sourceLinkWrap.style.display = '';
    if (avatarB64) {
      charAvatarData = avatarB64;
      renderAvatarPreview(document.getElementById('char-avatar-preview'), avatarB64, name);
    }
    const note = defHidden ? ' (definition hidden by author)' : '';
    toast(`Imported "${name}" from J.AI${note} 🌸`, defHidden ? 'info' : 'success');
    btn.disabled    = false;
    btn.textContent = 'Imported ✓';
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
    btn.disabled    = false;
    btn.textContent = 'Import';
  }
}

// ── Sync J.AI definitions ─────────────────────────────────────────────────────
async function syncJaiDefinitions() {
  const btn = document.getElementById('btn-sync-jai');
  btn.disabled = true;
  btn.textContent = 'Syncing…';

  const allChars = await dbGetAll('characters');
  let updated = 0, hidden = 0, notFound = 0;

  for (const char of allChars) {
    if (!char.name) continue;
    // Skip chars that already have a real definition (long personality)
    if ((char.personality || '').length > 500) continue;

    try {
      const res  = await fetch(`https://janitorai.com/hampter/characters?page=1&mode=sfw&sort=popular&search=${encodeURIComponent(char.name)}`).then(r => r.json());
      const match = (res.data || []).find(c => c.name.trim().toLowerCase() === char.name.trim().toLowerCase());
      if (!match) { notFound++; continue; }

      const detail = await fetch(`https://janitorai.com/hampter/characters/${match.id}`).then(r => r.json());
      const jTags = (detail.tags || []).map(t => t.slug).filter(Boolean);
      if (detail.showdefinition === true && detail.personality) {
        char.personality = detail.personality;
        if (!char.openingMessage && detail.first_message) char.openingMessage = detail.first_message;
        if (jTags.length) char.tags = jTags;
        await dbPut('characters', char);
        updated++;
      } else {
        hidden++;
      }
    } catch { notFound++; }
  }

  btn.disabled = false;
  btn.textContent = 'Sync J.AI Definitions';
  toast(`J.AI sync done — ${updated} updated, ${hidden} still hidden, ${notFound} not on J.AI`, updated > 0 ? 'success' : 'info');

  // Refresh characters list
  characters = await dbGetAll('characters');
  renderCharacterGrid();
}

document.getElementById('btn-sync-jai').addEventListener('click', syncJaiDefinitions);

// Mobile keyboard — push layout above keyboard when it opens
if (window.visualViewport) {
  const onViewportChange = () => {
    const vv = window.visualViewport;
    const messages = document.getElementById('messages-container');
    const followOutput = currentChat && isNearChatBottom(messages);
    const keyboardHeight = vv.scale === 1 ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--keyboard-h', `${keyboardHeight}px`);
    if (followOutput && mobileQuery.matches) scrollToBottom();

    // Keep the browse modal inside the visible area so its header stays in view
    const backdrop = document.getElementById('browse-backdrop');
    if (backdrop && backdrop.classList.contains('open')) {
      if (keyboardHeight > 80) {
        backdrop.style.top    = `${vv.offsetTop}px`;
        backdrop.style.height = `${vv.height}px`;
      } else {
        backdrop.style.top    = '';
        backdrop.style.height = '';
      }
    }
  };
  window.visualViewport.addEventListener('resize', onViewportChange);
  window.visualViewport.addEventListener('scroll', onViewportChange);
}

// Boot
init().catch(console.error);
