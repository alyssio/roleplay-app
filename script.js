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

if (MAINTENANCE && isLocal) {
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

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────
let characters   = [];   // all characters from DB
let settings     = {};   // API key, model, temperature, persona
let currentChar  = null; // character object currently in chat
let currentChat  = null; // { id, messages: [] }
let isStreaming  = false;
let editMsgIndex = null; // index of message being edited
let profileCharId   = null;  // char shown in profile modal
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

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
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

// ─────────────────────────────────────────────
// CONFIRM DIALOG
// ─────────────────────────────────────────────
function confirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('confirm-backdrop');
    const msg      = document.getElementById('confirm-message');
    const ok       = document.getElementById('btn-confirm-ok');
    const cancel   = document.getElementById('btn-confirm-cancel');

    msg.textContent = message;
    backdrop.classList.add('open');

    function cleanup(result) {
      backdrop.classList.remove('open');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
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
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─────────────────────────────────────────────
// SETTINGS PANEL
// ─────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-panel').classList.add('open');
  document.getElementById('settings-overlay').classList.add('visible');
  populateSettingsForm();
}

function closeSettings() {
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('visible');
}

// Provider configs
const PROVIDERS = {
  deepseek:   { label: 'DeepSeek API Key', placeholder: 'sk-…',     endpoint: 'https://api.deepseek.com/v1/chat/completions' },
  openrouter: { label: 'OpenRouter API Key', placeholder: 'sk-or-…', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
};

const PROVIDER_MODELS = {
  deepseek:   ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['deepseek/deepseek-chat-v3-0324', 'deepseek/deepseek-r1', 'google/gemini-2.0-flash-001', 'anthropic/claude-3.5-haiku', 'openai/gpt-4o-mini'],
};

function getEndpoint() {
  const provider = settings.provider || 'deepseek';
  return PROVIDERS[provider]?.endpoint || PROVIDERS.deepseek.endpoint;
}

function updateProviderUI(provider) {
  const cfg         = PROVIDERS[provider] || PROVIDERS.deepseek;
  const modelSelect = document.getElementById('model-select');
  const models      = PROVIDER_MODELS[provider] || PROVIDER_MODELS.deepseek;
  const current     = modelSelect.value;

  // Rebuild model options for this provider
  modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('')
    + `<option value="custom">Custom…</option>`;

  // Restore selection if still valid
  if (models.includes(current)) modelSelect.value = current;

  document.getElementById('api-key-label').textContent = cfg.label;
  document.getElementById('api-key').placeholder       = cfg.placeholder;
}

function populateSettingsForm() {
  const provider = settings.provider || 'deepseek';
  document.getElementById('provider-select').value     = provider;
  document.getElementById('api-key').value             = settings.apiKey      || '';
  document.getElementById('temperature').value         = settings.temperature ?? 0.8;
  document.getElementById('temp-display').textContent  = settings.temperature ?? 0.8;
  document.getElementById('persona-name').value        = settings.persona?.name        || '';
  document.getElementById('persona-desc').value        = settings.persona?.description || '';
  document.getElementById('ooc-enabled').checked       = settings.oocEnabled ?? false;

  updateProviderUI(provider);

  const modelSelect = document.getElementById('model-select');
  const customGroup = document.getElementById('custom-model-group');
  const customInput = document.getElementById('custom-model');
  const storedModel = settings.model || 'deepseek-chat';
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
  const modelSelect = document.getElementById('model-select');
  const model = modelSelect.value === 'custom'
    ? document.getElementById('custom-model').value.trim()
    : modelSelect.value;

  if (!model) { if (!silent) toast('Please enter a model ID.', 'error'); return; }

  settings = {
    id:          'app',
    provider:    document.getElementById('provider-select').value,
    apiKey:      document.getElementById('api-key').value.trim(),
    model,
    temperature: parseFloat(document.getElementById('temperature').value),
    oocEnabled:  document.getElementById('ooc-enabled').checked,
    persona: {
      name:        document.getElementById('persona-name').value.trim(),
      description: document.getElementById('persona-desc').value.trim(),
      avatar:      settings.persona?.avatar || null,
    },
    chatBg: settings.chatBg || null,
  };

  await dbPut('settings', settings);

  if (close) closeSettings();
  if (!silent) toast('Settings saved.', 'success');

  if (currentChar) renderMessages();
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
async function loadCharacters() {
  characters = await dbGetAll('characters');
  renderCharacterGrid(characters);
}

function renderCharacterGrid(list) {
  const grid  = document.getElementById('character-grid');
  const empty = document.getElementById('empty-state');
  grid.innerHTML = '';

  if (list.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.forEach(char => {
    const card = document.createElement('div');
    card.className = 'character-card';
    card.dataset.id = char.id;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'card-avatar';
    if (char.avatar) {
      avatarEl.innerHTML = `<img src="${char.avatar}" alt="${escapeHtml(char.name)}" />`;
    } else {
      avatarEl.textContent = initials(char.name);
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'card-name';
    nameEl.textContent = char.name;

    // edit button on card (top-right)
    const editBtn = document.createElement('button');
    editBtn.className = 'card-edit-btn';
    editBtn.title = 'Edit character';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCharModal(char.id);
    });

    // profile button on card (top-left)
    const profileBtn = document.createElement('button');
    profileBtn.className = 'card-profile-btn';
    profileBtn.title = 'View profile';
    profileBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCharProfile(char.id);
    });

    card.appendChild(editBtn);
    card.appendChild(profileBtn);
    card.appendChild(avatarEl);
    card.appendChild(nameEl);

    card.addEventListener('click', () => openChat(char.id));
    grid.appendChild(card);
  });
}

// ─────────────────────────────────────────────
// CHARACTER MODAL (create / edit)
// ─────────────────────────────────────────────
let charAvatarData = null; // base64 or null for current edit
let editingCharId  = null;

function openCharModal(charId = null) {
  const backdrop  = document.getElementById('char-modal-backdrop');
  const title     = document.getElementById('char-modal-title');
  const deleteBtn = document.getElementById('btn-delete-character');

  editingCharId  = charId;
  charAvatarData = null;

  if (charId) {
    const char = characters.find(c => c.id === charId);
    if (!char) return;
    title.textContent = 'Edit Character';
    deleteBtn.style.display = '';
    document.getElementById('btn-back-char-modal').style.display = 'none';
    document.getElementById('char-name').value         = char.name;
    document.getElementById('char-personality').value  = char.personality;
    document.getElementById('char-opening').value      = char.openingMessage || '';
    charAvatarData = char.avatar || null;
  } else {
    title.textContent = 'New Character';
    deleteBtn.style.display = 'none';
    document.getElementById('btn-back-char-modal').style.display = '';
    document.getElementById('char-name').value         = '';
    document.getElementById('char-personality').value  = '';
    document.getElementById('char-opening').value      = '';
    charAvatarData = null;
  }

  const prev = document.getElementById('char-avatar-preview');
  renderAvatarPreview(prev, charAvatarData, document.getElementById('char-name').value);

  backdrop.classList.add('open');
}

function closeCharModal() {
  document.getElementById('char-modal-backdrop').classList.remove('open');
  editingCharId  = null;
  charAvatarData = null;
}

async function saveCharacter() {
  const name         = document.getElementById('char-name').value.trim();
  const personality  = document.getElementById('char-personality').value.trim();
  const openingMsg   = document.getElementById('char-opening').value.trim();

  if (!name)        { toast('Character needs a name.', 'error');             return; }
  if (!personality) { toast('Personality / system prompt is required.', 'error'); return; }

  const isNew = !editingCharId;

  const char = {
    id:             editingCharId || generateId(),
    name,
    avatar:         charAvatarData,
    personality,
    openingMessage: openingMsg,
  };

  await dbPut('characters', char);

  const idx = characters.findIndex(c => c.id === char.id);
  if (idx >= 0) characters[idx] = char;
  else          characters.push(char);

  closeCharModal();
  renderCharacterGrid(characters);

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
  const ok = await confirm('Delete this character? Their chat history will also be deleted.');
  if (!ok) return;

  await dbDelete('characters', charId);
  await dbDelete('chats', charId);
  characters = characters.filter(c => c.id !== charId);

  closeCharModal();

  // If we're in this character's chat, go home
  if (currentChar?.id === charId) {
    currentChar = null;
    currentChat = null;
    showScreen('home-screen');
  }

  renderCharacterGrid(characters);
  toast('Character deleted.', 'success');
}

// ─────────────────────────────────────────────
// CHARACTER PROFILE MODAL
// ─────────────────────────────────────────────
function openCharProfile(charId) {
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  profileCharId  = charId;
  chatUsePersona = true; // reset to default on each profile open

  // Avatar
  renderAvatarPreview(document.getElementById('profile-avatar-large'), char.avatar, char.name);

  // Name
  document.getElementById('profile-char-name').textContent = char.name;

  // Opening message
  const openingEl = document.getElementById('profile-opening');
  if (char.openingMessage) {
    openingEl.textContent = '"' + char.openingMessage + '"';
    openingEl.style.display = '';
  } else {
    openingEl.style.display = 'none';
  }

  // Personality preview
  const p = char.personality;
  document.getElementById('profile-personality-preview').textContent =
    p.length > 220 ? p.slice(0, 220) + '…' : p;

  // Persona picker
  const hasPersona = !!(settings.persona?.name || settings.persona?.description);
  document.getElementById('persona-picker-wrap').style.display = hasPersona ? '' : 'none';
  document.getElementById('persona-picker').classList.remove('open');
  updatePersonaLabel();

  document.getElementById('char-profile-backdrop').classList.add('open');
}

function closeCharProfile() {
  document.getElementById('char-profile-backdrop').classList.remove('open');
  document.getElementById('persona-picker').classList.remove('open');
  profileCharId = null;
}

function updatePersonaLabel() {
  const label = document.getElementById('persona-label');
  const useBtn = document.getElementById('persona-opt-use');
  const noneBtn = document.getElementById('persona-opt-none');
  const toggleBtn = document.getElementById('btn-toggle-persona');

  if (chatUsePersona) {
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
function renderAvatarPreview(el, avatarData, name) {
  if (avatarData) {
    el.innerHTML = `<img src="${avatarData}" alt="avatar" />`;
  } else {
    el.innerHTML = '';
    el.textContent = initials(name);
  }
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
async function openChat(charId, usePersona = true) {
  chatUsePersona = usePersona;
  currentChar = characters.find(c => c.id === charId);
  if (!currentChar) return;

  // Load or create chat
  let chat = await dbGet('chats', charId);
  if (!chat) {
    chat = { id: charId, messages: [] };
    // inject opening message if any
    if (currentChar.openingMessage) {
      chat.messages.push({
        role:      'assistant',
        content:   currentChar.openingMessage,
        timestamp: Date.now(),
      });
    }
    await dbPut('chats', chat);
  }
  currentChat = chat;

  updateChatHeader();
  showScreen('chat-screen');
  renderMessages();
  scrollToBottom(false);
  document.getElementById('message-input').focus();
}

function updateChatHeader() {
  const nameEl   = document.getElementById('chat-header-name');
  const avatarEl = document.getElementById('chat-header-avatar');
  nameEl.textContent = currentChar.name;
  if (currentChar.avatar) {
    avatarEl.innerHTML = `<img src="${currentChar.avatar}" alt="${escapeHtml(currentChar.name)}" />`;
  } else {
    avatarEl.innerHTML = '';
    avatarEl.textContent = initials(currentChar.name);
  }
}

// ─────────────────────────────────────────────
// CHAT — RENDER MESSAGES
// ─────────────────────────────────────────────
function renderMessages() {
  const container = document.getElementById('messages-container');
  container.innerHTML = '';

  if (!currentChat) return;

  currentChat.messages.forEach((msg, index) => {
    container.appendChild(createMessageEl(msg, index));
  });
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
    const ua = settings.persona?.avatar;
    if (ua) {
      avatar.innerHTML = `<img src="${ua}" alt="you" />`;
    } else {
      avatar.textContent = initials(settings.persona?.name || 'Y');
    }
  } else {
    if (currentChar?.avatar) {
      avatar.innerHTML = `<img src="${currentChar.avatar}" alt="${escapeHtml(currentChar.name)}" />`;
    } else {
      avatar.textContent = initials(currentChar?.name || '?');
    }
  }

  // Bubble wrap
  const wrap   = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.content;

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
  }

  if (isLastAI) {
    // Regenerate — last AI message only
    const regenBtn = makeActionBtn('Regenerate', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`);
    regenBtn.addEventListener('click', () => regenerateLastAI());
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

function scrollToBottom(smooth = true) {
  const c = document.getElementById('messages-container');
  c.scrollTo({ top: c.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

// ─────────────────────────────────────────────
// CHAT — SEND MESSAGE
// ─────────────────────────────────────────────
async function sendMessage() {
  if (isStreaming) return;
  const input   = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  if (!settings.apiKey) {
    toast('Add your API key in Settings first.', 'error');
    openSettings();
    return;
  }

  input.value = '';
  resizeTextarea(input);

  // Add user message
  const userMsg = { role: 'user', content, timestamp: Date.now() };
  currentChat.messages.push(userMsg);
  await dbPut('chats', currentChat);

  // Render user message
  const container = document.getElementById('messages-container');
  container.appendChild(createMessageEl(userMsg, currentChat.messages.length - 1));
  scrollToBottom();

  await streamAIResponse();
}

// ─────────────────────────────────────────────
// CHAT — STREAM AI RESPONSE
// ─────────────────────────────────────────────
async function streamAIResponse() {
  if (isStreaming) return;
  isStreaming = true;
  setSendDisabled(true);

  const container = document.getElementById('messages-container');

  // Placeholder bubble
  const placeholderMsg = { role: 'assistant', content: '', timestamp: Date.now() };
  const row   = document.createElement('div');
  row.className = 'message-row char';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  if (currentChar?.avatar) {
    avatar.innerHTML = `<img src="${currentChar.avatar}" alt="${escapeHtml(currentChar.name)}" />`;
  } else {
    avatar.textContent = initials(currentChar?.name || '?');
  }

  const wrap   = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const cursor = document.createElement('span');
  cursor.className = 'streaming-cursor';
  bubble.appendChild(cursor);
  wrap.appendChild(bubble);
  row.appendChild(avatar);
  row.appendChild(wrap);
  container.appendChild(row);
  scrollToBottom();

  try {
    const messages = buildAPIMessages();
    const model    = settings.model || 'google/gemini-2.0-flash-001';
    const temp     = settings.temperature ?? 0.8;

    const response = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
        'HTTP-Referer':  window.location.href,
        'X-Title':       'Roleplay Chat',
      },
      body: JSON.stringify({
        model,
        temperature: temp,
        stream:      true,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const parsed = JSON.parse(data);
          const delta  = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            // Update bubble — preserve cursor at end
            bubble.textContent = accumulated;
            bubble.appendChild(cursor);
            scrollToBottom(false);
          }
        } catch { /* malformed chunk — skip */ }
      }
    }

    // Finalize
    bubble.textContent = accumulated || '…';
    placeholderMsg.content   = accumulated || '…';
    placeholderMsg.timestamp = Date.now();

    currentChat.messages.push(placeholderMsg);
    await dbPut('chats', currentChat);

    // Replace streaming row with proper rendered row
    const finalRow = createMessageEl(placeholderMsg, currentChat.messages.length - 1);
    container.replaceChild(finalRow, row);
    scrollToBottom();

  } catch (err) {
    console.error(err);
    row.remove();
    toast('Error: ' + err.message, 'error', 5000);
  }

  isStreaming = false;
  setSendDisabled(false);
  document.getElementById('message-input').focus();
}

function buildAPIMessages() {
  // System prompt = character personality + user persona (if enabled)
  let systemContent = currentChar.personality;
  if (chatUsePersona && (settings.persona?.name || settings.persona?.description)) {
    systemContent += '\n\n---\n';
    if (settings.persona.name)        systemContent += `The user's name is ${settings.persona.name}. `;
    if (settings.persona.description) systemContent += settings.persona.description;
  }

  // OOC instructions
  if (settings.oocEnabled) {
    systemContent += `\n\n---\nOOC COMMANDS: The user may send out-of-character messages using the format [OOC: message]. When you see this, immediately step fully outside your character and respond as the author/narrator of this story. Answer the OOC message thoroughly and in complete detail — treat it as a direct instruction or question you must fully address. Do not brush over it or give short answers. If asked about the character's behavior, feelings, or reactions in a scenario, explore it deeply. You may wrap your OOC reply in [OOC: ...] to keep it distinct. After addressing the OOC message, return naturally to the roleplay only if the context calls for it.`;
  }

  const messages = [{ role: 'system', content: systemContent }];

  // Add chat history (skip opening message if it's a pure assistant seed)
  currentChat.messages.forEach(m => {
    messages.push({ role: m.role, content: m.content });
  });

  return messages;
}

function setSendDisabled(disabled) {
  document.getElementById('send-btn').disabled = disabled;
}

// ─────────────────────────────────────────────
// CHAT — MESSAGE ACTIONS
// ─────────────────────────────────────────────
async function deleteMessage(index) {
  const ok = await confirm('Delete this message and all messages after it?');
  if (!ok) return;

  currentChat.messages.splice(index);
  await dbPut('chats', currentChat);
  renderMessages();
  scrollToBottom(false);
}

function openEditMessage(index) {
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
  if (editMsgIndex === null) return;
  const newContent = document.getElementById('edit-msg-input').value.trim();
  if (!newContent) { toast('Message cannot be empty.', 'error'); return; }

  // Replace message content and drop everything after it
  currentChat.messages[editMsgIndex].content   = newContent;
  currentChat.messages[editMsgIndex].timestamp = Date.now();
  currentChat.messages.splice(editMsgIndex + 1);
  await dbPut('chats', currentChat);

  closeEditMessage();
  renderMessages();
  scrollToBottom(false);

  // Re-send to get AI response
  await streamAIResponse();
}

async function regenerateLastAI() {
  if (isStreaming) return;
  // Remove last AI message and re-stream
  const msgs = currentChat.messages;
  if (msgs.length === 0) return;
  const last = msgs[msgs.length - 1];
  if (last.role !== 'assistant') return;

  msgs.pop();
  await dbPut('chats', currentChat);
  renderMessages();
  scrollToBottom(false);

  await streamAIResponse();
}

async function clearChat() {
  const ok = await confirm('Clear all messages in this chat?');
  if (!ok) return;

  currentChat.messages = [];

  // Re-add opening message if character has one
  if (currentChar.openingMessage) {
    currentChat.messages.push({
      role:      'assistant',
      content:   currentChar.openingMessage,
      timestamp: Date.now(),
    });
  }

  await dbPut('chats', currentChat);
  renderMessages();
  scrollToBottom(false);
  toast('Chat cleared.', 'success');
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

  const data = { characters: chars, chats, settings: s, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `roleplay-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Data exported.', 'success');
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.characters || !Array.isArray(data.characters)) throw new Error('Invalid backup file.');

    const ok = await confirm(`Import will overwrite all current data. Continue?`);
    if (!ok) return;

    for (const c of data.characters) await dbPut('characters', c);
    for (const chat of (data.chats || []))    await dbPut('chats', chat);
    if (data.settings) await dbPut('settings', data.settings);

    // Reload everything
    settings   = data.settings || {};
    characters = await dbGetAll('characters');
    renderCharacterGrid(characters);
    populateSettingsForm();
    toast('Data imported successfully.', 'success');

  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
  }
}

// ─────────────────────────────────────────────
// INIT — WIRE UP ALL EVENTS
// ─────────────────────────────────────────────
async function init() {
  db       = await openDB();
  settings = (await dbGet('settings', 'app')) || { id: 'app' };
  await loadCharacters();

  applyChatBg();
  showScreen('home-screen');

  // ── Settings panel ──────────────────────────
  document.getElementById('btn-open-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);
  document.getElementById('btn-save-settings').addEventListener('click', () => saveSettings({ close: true }));

  // Auto-save whenever any settings field changes
  ['api-key', 'persona-name', 'persona-desc', 'custom-model'].forEach(id => {
    document.getElementById(id).addEventListener('input', scheduleAutoSave);
  });
  document.getElementById('model-select').addEventListener('change', scheduleAutoSave);
  document.getElementById('temperature').addEventListener('change', scheduleAutoSave);
  document.getElementById('ooc-enabled').addEventListener('change', scheduleAutoSave);

  document.getElementById('temperature').addEventListener('input', (e) => {
    document.getElementById('temp-display').textContent = parseFloat(e.target.value).toFixed(2);
  });

  document.getElementById('provider-select').addEventListener('change', (e) => {
    updateProviderUI(e.target.value);
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
    const b64 = await readFileAsBase64(file);
    if (!settings.persona) settings.persona = {};
    settings.persona.avatar = b64;
    renderAvatarPreview(document.getElementById('user-avatar-preview'), b64, settings.persona?.name);
    e.target.value = '';
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
  document.getElementById('char-profile-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCharProfile();
  });
  document.getElementById('btn-profile-chat').addEventListener('click', () => {
    const id         = profileCharId;
    const usePersona = chatUsePersona;
    closeCharProfile();
    openChat(id, usePersona);
  });
  document.getElementById('btn-toggle-persona').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('persona-picker').classList.toggle('open');
  });
  document.getElementById('persona-opt-use').addEventListener('click', () => {
    chatUsePersona = true;
    updatePersonaLabel();
    document.getElementById('persona-picker').classList.remove('open');
  });
  document.getElementById('persona-opt-none').addEventListener('click', () => {
    chatUsePersona = false;
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
    charAvatarData = await readFileAsBase64(file);
    renderAvatarPreview(
      document.getElementById('char-avatar-preview'),
      charAvatarData,
      document.getElementById('char-name').value
    );
    e.target.value = '';
  });

  // Update avatar preview initials when name changes
  document.getElementById('char-name').addEventListener('input', (e) => {
    if (!charAvatarData) {
      const prev = document.getElementById('char-avatar-preview');
      prev.textContent = initials(e.target.value);
    }
  });

  // ── Chat screen ──────────────────────────────
  document.getElementById('btn-back').addEventListener('click', () => {
    showScreen('home-screen');
    currentChar = null;
    currentChat = null;
  });

  document.getElementById('btn-edit-character').addEventListener('click', () => {
    if (currentChar) openCharModal(currentChar.id);
  });

  document.getElementById('btn-clear-chat').addEventListener('click', clearChat);

  // Send
  document.getElementById('send-btn').addEventListener('click', sendMessage);
  document.getElementById('message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
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
  document.getElementById('search-input').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = characters.filter(c => c.name.toLowerCase().includes(q));
    renderCharacterGrid(filtered);
  });

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
  document.getElementById('browse-search-input').addEventListener('focus', () => {
    if (window.innerWidth <= 600) requestAnimationFrame(() => window.scrollTo(0, 0));
  });
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
        model:       settings.model || 'google/gemini-2.0-flash-001',
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
    toast('Error: ' + err.message, 'error', 5000);
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
  renderCharacterGrid(characters);
  openCharProfile(char.id);
}

// ─────────────────────────────────────────────
// ROSIE — RP HELPER
// ─────────────────────────────────────────────
// Uses whatever model the user has selected — avoids billing issues with locked providers
const getRosieModel = () => settings.model || 'deepseek/deepseek-chat-v3-0324';

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
  if (panel.classList.contains('open') && window.innerWidth > 600) {
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            bubble.textContent = accumulated;
            bubble.appendChild(cursor);
            document.getElementById('rosie-messages').scrollTop =
              document.getElementById('rosie-messages').scrollHeight;
          }
        } catch { /* skip malformed */ }
      }
    }

    bubble.textContent = accumulated || '…';
    rosieHistory.push({ role: 'assistant', content: accumulated });

  } catch (err) {
    bubble.textContent = 'oops, something went wrong 😓 — ' + err.message;
  }

  rosieStreaming = false;
  document.getElementById('rosie-send-btn').disabled = false;
  if (window.innerWidth > 600) document.getElementById('rosie-input').focus();
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
const CHUB_API          = 'https://api.chub.ai';
const CHUB_BLOCK_TOPICS = [
  'female', 'lesbian', 'yuri', 'femslash', 'wlw', 'girl', 'girls',
  'femboy', 'femboys', 'trap', 'traps', 'crossdressing', 'crossdresser',
  'otokonoko', 'genderbend', 'genderswap', 'gender bender',
  'animal', 'animals', 'feral', 'furry', 'zoo', 'bestiality', 'zoophilia',
];
const CHUB_BLOCK_TEXT = [
  'female pov', 'fempov', '[fempov]', '(fempov)',
  'female reader', 'female protagonist', 'female mc',
  'female lead', 'girl pov', '[fem pov]', '(fem pov)',
];
const DEAD_DOVE_TAGS    = ['dead dove', 'dead-dove', 'noncon', 'non-con', 'rape', 'incest', 'snuff', 'gore', 'torture', 'underage', 'zoophilia', 'bestiality', 'beastiality', 'zoo'];

let browsePage    = 1;
let browseQuery   = '';
let browseLoading = false;
let browseHasMore = false;
let browseNodes   = [];

function isDeadDove(topics = []) {
  const lower = topics.map(t => t.toLowerCase());
  return DEAD_DOVE_TAGS.some(tag => lower.some(t => t === tag || t.includes(tag)));
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
  if (window.innerWidth <= 600) document.getElementById('rosie-toggle').style.display = 'none';
  if (window.innerWidth > 600) document.getElementById('browse-search-input').focus();
}

function closeBrowse() {
  document.getElementById('browse-backdrop').classList.remove('open');
  document.getElementById('rosie-toggle').style.display = '';
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
      page_size:    48,
      content_type: 'characters',
      nsfw:         nsfwChecked ? 'true' : 'false',
      sort:         'rating_count',
    });
    if (browseQuery) params.set('search', browseQuery);

    const data     = await chubFetch(`/search?${params}`);
    const inner    = data.data || data;
    const rawNodes = inner.nodes || inner.results || [];
    browseHasMore  = rawNodes.length >= 48;
    const nodes = rawNodes.filter(n => {
      const topics = (n.topics || []).map(t => t.toLowerCase());
      const nameDesc = `${n.name || ''} ${n.description || ''}`.toLowerCase();
      const blockedTag  = CHUB_BLOCK_TOPICS.some(b => topics.includes(b));
      const blockedText = CHUB_BLOCK_TEXT.some(b => nameDesc.includes(b));
      const blockedDoveText = ['zoophilia','bestiality','beastiality','with animals','animal sex','feral'].some(b => nameDesc.includes(b));
      return !blockedTag && !blockedText && !blockedDoveText && !isDeadDove(n.topics || []);
    });
    browseNodes = nodes;

    renderBrowseGrid(nodes, grid);
    renderBrowsePagination();
  } catch (err) {
    grid.innerHTML = `<div class="browse-error">Could not reach Chub.ai — ${err.message}<br/><small>If this is a CORS error, the app needs to be served (not opened as file://)</small></div>`;
  }

  browseLoading = false;
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
    taglineEl.textContent = node.tagline || '';

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
}

function showBrowseProfile(node) {
  const profile = document.getElementById('browse-profile');
  profile.innerHTML = '';

  const avatarEl = document.createElement('div');
  avatarEl.className = 'bprofile-avatar';
  const img = document.createElement('img');
  img.src = `https://avatars.charhub.io/avatars/${node.fullPath}/chara_card_v2.png`;
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
    taglineEl.textContent = node.tagline;
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
  importBtn.addEventListener('click', () => importChubChar(node.fullPath, node.name, importBtn));
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

async function importChubChar(fullPath, name, btn) {
  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const data     = await chubFetch(`/api/characters/${fullPath}`);
    const node     = data.node || data;
    // V2 card data is nested under node.character.data or flattened
    const cardData = node.character?.data || node.character || node;

    const charName   = cardData.name        || node.name || name;
    const personality= cardData.description || node.description || '';
    const openingMsg = cardData.first_mes   || node.first_mes   || '';

    closeBrowse();
    openCharModal();
    document.getElementById('char-name').value        = charName;
    document.getElementById('char-personality').value = personality;
    document.getElementById('char-opening').value     = openingMsg;

    toast(`Imported "${charName}" — review and save! 🌸`, 'success');
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
    btn.disabled    = false;
    btn.textContent = 'Import';
  }
}

// Mobile keyboard — push layout above keyboard when it opens
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const keyboardHeight = window.innerHeight - window.visualViewport.height;
    document.documentElement.style.setProperty('--keyboard-h', `${keyboardHeight}px`);
  });
}

// Boot
init().catch(console.error);
