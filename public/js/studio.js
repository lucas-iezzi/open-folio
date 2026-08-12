'use strict';

// Surface any JS errors visually so they're easy to diagnose
window.onerror = (msg, _src, line, _col, err) => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#c0392b;color:#fff;padding:10px 14px;font:13px/1.5 monospace;white-space:pre-wrap;';
  box.textContent = `studio.js error (line ${line}): ${err?.message || msg}`;
  document.body?.appendChild(box);
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  generated:        false,
  uploading:        false,
  generating:       false,
  uploadedFiles:    [],
  provider:         'anthropic',
  model:            'claude-sonnet-4-6',
  currentProject:   null,
  chatAttachments:  [],   // files staged for the next chat message only
  pendingAiProject: null, // AI-suggested project awaiting accept/discard
  preAiProject:     null, // snapshot of project before AI suggestion
};

// ── Image editing state ───────────────────────────────────────────────────────
let _imgActiveWrap = null; // .img-section-wrap currently selected
let _imgSelectedEl = null; // <img> currently selected within that wrap

// ── Mode (edit vs generate) ───────────────────────────────────────────────────
const studioMode = document.querySelector('meta[name="studio-mode"]')?.content || 'generate';
const editSlug   = document.querySelector('meta[name="studio-edit-slug"]')?.content || '';

let initialProject = null;
const initDataEl = document.getElementById('studio-initial-data');
if (initDataEl) {
  try { initialProject = JSON.parse(initDataEl.textContent); } catch {}
}

// ── Persistence ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'studioState_v1';

function currentTempId() {
  return document.querySelector('meta[name="studio-temp-id"]')?.content || '';
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tempId:        currentTempId(),
      description:   description?.value || '',
      uploadedFiles: state.uploadedFiles,
    }));
  } catch { /* storage full */ }
}

function clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

let _descDebounce;
function scheduleSave() {
  clearTimeout(_descDebounce);
  _descDebounce = setTimeout(saveToStorage, 600);
}

async function tryRestoreFromStorage() {
  let saved;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch { return; }

  if (!saved?.tempId || !saved.tempId.match(/^[a-f0-9-]{36}$/)) return;

  const serverTempId = currentTempId();
  if (saved.tempId === serverTempId) {
    restoreUI(saved);
    return;
  }

  try {
    const data = await apiFetch('/admin/studio/restore', {
      tempId:        saved.tempId,
      uploadedFiles: saved.uploadedFiles || [],
      description:   saved.description   || '',
    });
    const meta = document.querySelector('meta[name="studio-temp-id"]');
    if (meta) meta.content = saved.tempId;
    saved.uploadedFiles = data.uploadedFiles;
    restoreUI(saved);
    setStatus(uploadStatus, 'Session restored — hit Generate to rebuild the preview.', false);
  } catch (err) {
    if (err.message === 'expired') clearStorage();
  }
}

function restoreUI(saved) {
  if (saved.description && description) description.value = saved.description;
  if (saved.uploadedFiles?.length) {
    state.uploadedFiles = saved.uploadedFiles;
    renderAllFiles();
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const studioWrap        = $('studio-wrap');
const dropZone          = $('studio-drop-zone');
// Attach a throwaway file input off-screen for the duration of the pick,
// then remove it — browsers require it to be in the DOM to allow .click(),
// but position:fixed + negative coords keeps it fully invisible.
function pickFiles() {
  const inp = document.createElement('input');
  inp.type  = 'file';
  inp.multiple = true;
  inp.accept = studioMode === 'edit'
    ? 'image/jpeg,image/png,image/gif,image/webp'
    : 'image/jpeg,image/png,image/gif,image/webp,text/plain,text/markdown,text/csv,application/json,.txt,.md,.csv,.json';
  inp.style.cssText = 'position:fixed;top:-200vh;left:-200vw;width:0;height:0;opacity:0;overflow:hidden;pointer-events:none;';
  document.body.appendChild(inp);

  const cleanup = () => { try { inp.remove(); } catch {} };

  inp.addEventListener('change', () => {
    uploadFiles(inp.files);
    cleanup();
  });

  // If user cancels the picker (no change fires), clean up on next window focus
  window.addEventListener('focus', function onFocus() {
    window.removeEventListener('focus', onFocus);
    setTimeout(cleanup, 300); // small delay so change can fire first if files were picked
  }, { once: true });

  inp.click();
}
const pregenFileList      = $('pregen-file-list');
const fileGrid            = $('studio-image-grid');
const uploadStatus        = $('studio-upload-status');
const uploadStatusSidebar = $('studio-upload-status-sidebar');
const tagSaveStatus       = $('studio-tag-save-status');
const description         = $('studio-description');
const modelSel            = $('studio-model');
const generateBtn         = $('studio-generate-btn');
const generateStatus      = $('studio-generate-status');
const fileCountNote       = $('studio-file-count-note');
const chatHistory         = $('studio-chat-history');
const chatInput           = $('studio-chat-input');
const chatSend            = $('studio-chat-send');
const titleInput          = $('studio-title');
const slugInput           = $('studio-slug');
const slugPreview         = $('studio-slug-preview');
const publishBtn          = $('studio-publish-btn');
const draftBtn            = $('studio-draft-btn');
const discardBtn          = $('studio-discard-btn');
const publishStatus       = $('studio-publish-status');
const previewFrame        = $('studio-preview-frame');
const loading             = $('studio-loading');
const loadingText         = $('studio-loading-text');
const sidebarUploadBtn    = $('sidebar-upload-btn');

const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  const base = el.classList.contains('studio-nav-status') ? 'studio-nav-status' : 'studio-status';
  el.className = base + (isError ? ' is-error' : '');
}

function lockButtons(on) {
  state.generating      = on;
  if (generateBtn) generateBtn.disabled = on;
  chatSend.disabled     = on;
  chatInput.disabled    = on;
  if (publishBtn) publishBtn.disabled   = on;
  if (draftBtn)   draftBtn.disabled     = on;
  if (discardBtn) discardBtn.disabled   = on;
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getTags() {
  const tags = {};
  for (const f of state.uploadedFiles) {
    if (f.tag) tags[f.filename] = f.tag;
  }
  return tags;
}

async function apiFetch(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf(),
      'Accept':       'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Accordion sections ────────────────────────────────────────────────────────
const SECTIONS = ['files', 'chat', 'publish'];

function openSection(id) {
  SECTIONS.forEach(sid => {
    const el  = $(`section-${sid}`);
    const hdr = el.querySelector('.studio-section-header');
    if (sid === id) {
      el.classList.replace('is-closed', 'is-open');
      hdr?.setAttribute('aria-expanded', 'true');
    } else {
      el.classList.replace('is-open', 'is-closed');
      hdr?.setAttribute('aria-expanded', 'false');
    }
  });
}

document.querySelectorAll('.studio-section-header').forEach(hdr => {
  hdr.addEventListener('click', () => {
    if (!state.generated) return;
    openSection(hdr.dataset.section);
  });
  hdr.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && state.generated) {
      e.preventDefault();
      openSection(hdr.dataset.section);
    }
  });
});

// ── File count label (sidebar header) ────────────────────────────────────────
function updateFileCountNote() {
  const images = state.uploadedFiles.filter(f => f.fileType === 'image').length;
  const docs   = state.uploadedFiles.filter(f => f.fileType !== 'image').length;
  const parts  = [];
  if (images) parts.push(`${images} image${images !== 1 ? 's' : ''}`);
  if (docs)   parts.push(`${docs} file${docs !== 1 ? 's' : ''}`);
  fileCountNote.textContent = parts.length ? parts.join(' · ') : 'No files';
}

// ── Layout transition ─────────────────────────────────────────────────────────
let _timerInterval = null;
let _timerStart    = 0;

function transitionToPostGen() {
  const sidebar = $('studio-sidebar');
  sidebar.style.display = '';
  studioWrap.classList.add('is-generated');
  loading.classList.add('is-active');
  previewFrame.style.display = 'none';
  openSection('chat');
  updateFileCountNote();
  renderAllFiles();
}

function startLoadingTimer() {
  _timerStart = Date.now();
  clearInterval(_timerInterval);
  const tick = () => { loadingText.textContent = `Generating — ${Math.floor((Date.now() - _timerStart) / 1000)}s`; };
  tick();
  _timerInterval = setInterval(tick, 1000);
}

function stopLoadingTimer() {
  clearInterval(_timerInterval);
  _timerInterval = null;
  loading.classList.remove('is-active');
}

// ── Chat bubbles ──────────────────────────────────────────────────────────────
function appendBubble(role, text, opts = {}) {
  const div = document.createElement('div');
  div.className = `studio-chat-bubble studio-chat-bubble--${role}`;

  if (opts.isThinking) {
    div.classList.add('is-thinking-bubble');
    div.innerHTML = '<span class="studio-typing-dot"></span><span class="studio-typing-dot"></span><span class="studio-typing-dot"></span>';
  } else if (role === 'assistant') {
    div.innerHTML = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  } else {
    const MAX = 280;
    if (text.length > MAX) {
      const short  = text.slice(0, MAX);
      const rest   = text.slice(MAX);
      const shortEl = document.createElement('span');
      shortEl.textContent = short + '…';
      const toggle = document.createElement('button');
      toggle.className   = 'studio-chat-expand';
      toggle.textContent = 'Show more';
      const restEl = document.createElement('span');
      restEl.textContent   = rest;
      restEl.style.display = 'none';
      toggle.addEventListener('click', () => {
        const expanded = restEl.style.display !== 'none';
        restEl.style.display = expanded ? 'none'     : 'inline';
        shortEl.textContent  = expanded ? short + '…' : short;
        toggle.textContent   = expanded ? 'Show more' : 'Show less';
      });
      div.append(shortEl, restEl, document.createElement('br'), toggle);
    } else {
      div.textContent = text;
    }
  }

  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return div;
}

// ── File rendering ────────────────────────────────────────────────────────────
function fileExt(name) {
  return (name || '').split('.').pop().toUpperCase().slice(0, 4);
}

function renderPregenFileList() {
  if (!pregenFileList) return;
  pregenFileList.innerHTML = '';
  for (const f of state.uploadedFiles) {
    const item = document.createElement('div');
    item.className = 'studio-pregen-file-item';
    const tagVal = (f.tag || '').replace(/"/g, '&quot;');
    const tagPh  = f.fileType === 'image' ? 'e.g. hero shot, before photo' : 'e.g. project notes, spec doc';
    const thumb  = f.fileType === 'image'
      ? `<img class="studio-pregen-file-thumb" src="${f.previewSrc}" alt="${f.originalName}">`
      : `<div class="studio-pregen-file-icon">${fileExt(f.originalName)}</div>`;
    item.innerHTML = `
      ${thumb}
      <div class="studio-pregen-file-info">
        <span class="studio-pregen-file-name" title="${f.originalName}">${f.originalName}</span>
        <input class="studio-pregen-tag-input" type="text" placeholder="${tagPh}" maxlength="80" value="${tagVal}" data-filename="${f.filename}" aria-label="Label for ${f.originalName}">
      </div>
      <button class="studio-pregen-file-remove" data-filename="${f.filename}" title="Remove">✕</button>`;
    pregenFileList.appendChild(item);
  }
}

function renderFileGrid() {
  fileGrid.innerHTML = '';
  for (const f of state.uploadedFiles) {
    if (f.fileType !== 'image') continue; // edit mode shows images only
    const card = document.createElement('div');
    card.className = 'studio-file-card';
    const tagVal = (f.tag || '').replace(/"/g, '&quot;');
    card.innerHTML = `
      <div class="studio-file-thumb">
        <img src="${f.previewSrc}" alt="${f.originalName}" title="${f.originalName}">
        <button class="studio-file-remove" data-filename="${f.filename}" title="Remove">✕</button>
      </div>
      <input class="studio-file-tag-input" type="text" placeholder="Image label" maxlength="80" value="${tagVal}" data-filename="${f.filename}" aria-label="Label for ${f.originalName}">`;
    fileGrid.appendChild(card);
  }
}

function renderAllFiles() {
  renderPregenFileList();
  renderFileGrid();
  updateFileCountNote();
  populateThumbnailPicker();
  // Refresh the active section's Add/Replace dropdowns so new uploads appear immediately
  if (studioMode === 'edit') refreshImgDropdowns();
}

// ── Thumbnail picker ──────────────────────────────────────────────────────────
function populateThumbnailPicker() {
  const select  = $('studio-thumbnail-select');
  const preview = $('studio-thumbnail-preview');
  if (!select) return;

  const images = state.uploadedFiles.filter(f => f.fileType === 'image');
  // Live DOM value takes priority — preserves the user's current selection across rebuilds
  const current = select.value || state.currentProject?.thumbnail || '';

  select.innerHTML = '<option value="">— no thumbnail —</option>';
  images.forEach(f => {
    const src = f.permanentPath || f.previewSrc || '';
    const opt = document.createElement('option');
    opt.value = src;
    opt.textContent = f.tag || f.originalName || f.filename;
    select.appendChild(opt);
  });

  // Restore selection by value — more reliable than opt.selected after innerHTML reset
  select.value = current;

  updateThumbnailPreview(select.value, preview);

  if (!select.dataset.listening) {
    select.dataset.listening = '1';
    select.addEventListener('change', () => {
      const val = select.value;
      if (state.currentProject) state.currentProject.thumbnail = val;
      updateThumbnailPreview(val, preview);
      if (studioMode === 'edit') scheduleAutoSave();
    });
  }
}

function updateThumbnailPreview(src, preview) {
  preview = preview || $('studio-thumbnail-preview');
  if (!preview) return;
  if (src) {
    preview.innerHTML = `<img src="${src}" alt="Thumbnail preview">`;
    preview.classList.add('has-image');
  } else {
    preview.innerHTML = '';
    preview.classList.remove('has-image');
  }
}

// Tag changes (sidebar)
const _tagDebounces = {};
fileGrid.addEventListener('input', e => {
  const input = e.target.closest('.studio-file-tag-input');
  if (!input) return;
  const f = state.uploadedFiles.find(f => f.filename === input.dataset.filename);
  if (!f) return;
  f.tag = input.value.slice(0, 80);
  if (studioMode === 'edit') {
    // Write label back to section alt texts and persist to DB
    if (f.permanentPath) updateImageLabel(f.permanentPath, f.tag);
    populateThumbnailPicker();   // refresh dropdown labels without re-rendering the whole grid
    refreshImgDropdowns();
    scheduleAutoSave();
  } else {
    scheduleSave();
    clearTimeout(_tagDebounces[f.filename]);
    _tagDebounces[f.filename] = setTimeout(() => syncTag(f.filename, f.tag), 800);
  }
});

async function syncTag(filename, tag) {
  try {
    await apiFetch('/admin/studio/update-tag', { filename, tag });
    setStatus(tagSaveStatus, 'Labels synced.', false);
    tagSaveStatus.className = 'studio-status is-done';
    setTimeout(() => setStatus(tagSaveStatus, ''), 2000);
  } catch { /* silent */ }
}

fileGrid.addEventListener('click', async e => {
  const btn = e.target.closest('.studio-file-remove');
  if (!btn) return;
  await removeFile(btn.dataset.filename);
});

if (pregenFileList) {
  pregenFileList.addEventListener('input', e => {
    const input = e.target.closest('.studio-pregen-tag-input');
    if (!input) return;
    const f = state.uploadedFiles.find(f => f.filename === input.dataset.filename);
    if (!f) return;
    f.tag = input.value.slice(0, 80);
    scheduleSave();
  });
  pregenFileList.addEventListener('click', async e => {
    const btn = e.target.closest('.studio-pregen-file-remove');
    if (!btn) return;
    await removeFile(btn.dataset.filename);
  });
}

async function removeFile(filename) {
  const f = state.uploadedFiles.find(f => f.filename === filename);
  try {
    if (studioMode === 'edit' && f?.permanentPath) {
      // Delete the permanent project image from disk
      await apiFetch('/admin/image/delete', { imagePath: f.permanentPath });
    } else {
      await apiFetch('/admin/studio/delete-upload', { filename });
    }
    state.uploadedFiles = state.uploadedFiles.filter(f => f.filename !== filename);
    renderAllFiles();
    if (studioMode !== 'edit') saveToStorage();
  } catch (err) {
    setStatus(state.generated ? uploadStatusSidebar : uploadStatus, err.message, true);
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function uploadFile(file) {
  if (state.uploading) return;
  state.uploading = true;
  const statusEl = state.generated ? uploadStatusSidebar : uploadStatus;
  setStatus(statusEl, `Uploading ${file.name}…`);

  const form = new FormData();
  form.append('image', file);

  try {
    if (studioMode === 'edit') {
      const res = await fetch(`/admin/upload/${encodeURIComponent(editSlug)}`, {
        method: 'POST', headers: { Accept: 'application/json' }, body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const filename = data.path.split('/').pop();
      state.uploadedFiles.push({
        filename, originalName: file.name, fileType: 'image',
        previewSrc: data.path, permanentPath: data.path, fromEditor: false, tag: '',
      });
    } else {
      const res = await fetch('/admin/studio/upload', {
        method: 'POST', headers: { Accept: 'application/json' }, body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      state.uploadedFiles.push({ ...data.file, tag: '' });
    }
    renderAllFiles(); // also calls refreshImgDropdowns in edit mode
    saveToStorage();
    if (state.generated) openSection('files');
    setStatus(statusEl, '');
  } catch (err) {
    setStatus(statusEl, err.message, true);
  } finally {
    state.uploading = false;
  }
}

async function uploadFiles(files) {
  for (const file of Array.from(files)) await uploadFile(file);
}

// Pre-gen drop zone
if (dropZone) {
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('is-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('is-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('is-over');
    uploadFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('click',   () => pickFiles());
  dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } });
}

sidebarUploadBtn.addEventListener('click', () => pickFiles());
if (description) description.addEventListener('input', scheduleSave);

// ── Generate ──────────────────────────────────────────────────────────────────
if (generateBtn) generateBtn.addEventListener('click', async () => {
  if (state.generating) return;
  const desc = (description?.value || '').trim();
  if (desc.length < 10) {
    setStatus(generateStatus, 'Please add a project description (at least 10 characters).', true);
    return;
  }

  state.modelTier = modelSel?.value || 'smart';

  lockButtons(true);
  transitionToPostGen();
  startLoadingTimer();
  appendBubble('user', desc);

  try {
    const data = await apiFetch('/admin/studio/generate', {
      description: desc, modelTier: state.modelTier, tags: getTags(),
    });
    stopLoadingTimer();
    await refreshPreview();
    onGenerated(data.project, data.summary);
  } catch (err) {
    stopLoadingTimer();
    appendBubble('assistant', `Error: ${err.message}`);
  } finally {
    lockButtons(false);
  }
});

// ── After generation ──────────────────────────────────────────────────────────
function onGenerated(project, summary) {
  state.generated = true;
  if (project) state.currentProject = project;
  updateSlug(project?.slug);
  if (project?.title) titleInput.value = project.title;
  if (summary) appendBubble('assistant', summary);
  chatInput.focus();
}

function updateSlug(slug) {
  if (!slug) return;
  const clean = slugify(slug);
  slugInput.value = clean;
  slugPreview.textContent = clean;
}

slugInput.addEventListener('input', () => {
  slugPreview.textContent = slugify(slugInput.value);
});

// ── Chat send ─────────────────────────────────────────────────────────────────
async function sendChatMessage() {
  if (state.generating) return;
  const msg = chatInput.value.trim();
  if (msg.length < 2) return;

  // In AI preview mode: check for acceptance before hitting the LLM
  if (studioMode === 'edit' && state.pendingAiProject) {
    if (ACCEPT_RE.test(msg)) {
      chatInput.value = '';
      appendBubble('user', msg);
      appendBubble('assistant', 'Changes accepted and saved.');
      await acceptAiChanges();
      return;
    }
    // Otherwise: treat as a refinement of the pending AI suggestion (fall through)
  }

  chatInput.value = '';
  appendBubble('user', msg);
  const thinkingBubble = appendBubble('assistant', '', { isThinking: true });
  lockButtons(true);

  try {
    let payload;

    if (studioMode === 'edit') {
      const currentProject = readProjectFromDOM();
      state.currentProject = currentProject;

      // Always send the full current page state — server injects it before every user message
      payload = {
        feedback:       msg,
        modelTier:      state.modelTier || 'smart',
        currentProject,
        imageManifest:  state.uploadedFiles.map(f => ({
          filename: (f.permanentPath || f.previewSrc || f.filename || '').split('/').pop(),
          label:    f.tag || '',
          src:      f.permanentPath || f.previewSrc || '',
        })),
        ...(state.chatAttachments.length ? { chatAttachments: state.chatAttachments } : {}),
      };
    } else {
      payload = {
        feedback:       msg,
        modelTier:      state.modelTier || 'smart',
        tags:           getTags(),
        currentProject: state.currentProject,
        editorImages:   state.uploadedFiles.filter(f => f.fromEditor),
      };
    }

    const data = await apiFetch('/admin/studio/refine', payload);

    state.chatAttachments = [];
    renderChatAttachments();
    thinkingBubble.remove();
    if (data.message) appendBubble('assistant', data.message);

    if (data.regenerate && data.project) {
      if (studioMode === 'edit') {
        // Snapshot the current committed state before showing AI changes
        if (!state.pendingAiProject) {
          state.preAiProject = state.currentProject
            ? JSON.parse(JSON.stringify(state.currentProject))
            : null;
        }
        state.pendingAiProject = data.project;
        state.currentProject   = data.project;
        await refreshPreview();        // renders AI version
        enterAiPreviewMode();          // orange banner, editing frozen
        updateSlug(data.project?.slug);
        if (data.project?.title) titleInput.value = data.project.title;
      } else {
        state.currentProject = data.project;
        await refreshPreview();
        updateSlug(data.project?.slug);
        if (data.project?.title) titleInput.value = data.project.title;
      }
    }
  } catch (err) {
    thinkingBubble.remove();
    appendBubble('assistant', `Error: ${err.message}`);
  } finally {
    lockButtons(false);
    chatInput.focus();
  }
}

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});

// ── Chat file attachments (passed directly to LLM, never saved to server) ─────
const chatAttachBtn   = $('studio-chat-attach-btn');
const chatAttachInput = Object.assign(document.createElement('input'), {
  type: 'file', multiple: true,
  accept: 'image/*,.txt,.md,.csv,.json',
});

chatAttachBtn?.addEventListener('click', () => chatAttachInput.click());

chatAttachInput.addEventListener('change', async () => {
  for (const file of chatAttachInput.files) {
    state.chatAttachments.push(await readChatAttachment(file));
  }
  chatAttachInput.value = '';
  renderChatAttachments();
});

async function readChatAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = () => resolve({
        name: file.name, type: 'image',
        mediaType: file.type || 'image/jpeg',
        data: reader.result.split(',')[1],
      });
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ name: file.name, type: 'text', data: reader.result });
      reader.readAsText(file);
    }
    reader.onerror = reject;
  });
}

function renderChatAttachments() {
  const el = $('studio-chat-attachments');
  if (!el) return;
  el.innerHTML = '';
  state.chatAttachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'studio-chat-attach-chip';
    chip.innerHTML = `${a.name} <button data-idx="${i}" aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.chatAttachments.splice(i, 1);
      renderChatAttachments();
    });
    el.appendChild(chip);
  });
  el.style.display = state.chatAttachments.length ? 'flex' : 'none';
}

// ── Preview (generate mode: iframe; edit mode: inline DOM refresh after chat) ──
async function refreshPreview() {
  const res = await fetch('/admin/studio/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    body: JSON.stringify({ project: state.currentProject }),
  });
  if (!res.ok) return;
  const { html } = await res.json();

  if (studioMode === 'edit') {
    const content = $('studio-preview-content');
    if (content) {
      _imgActiveWrap = null;
      _imgSelectedEl = null;
      content.innerHTML = html;
      makeTextEditable();
    }
  } else {
    previewFrame.style.display = 'block';
    await new Promise(resolve => {
      previewFrame.addEventListener('load', resolve, { once: true });
      previewFrame.srcdoc = html;
    });
  }
}

// ── Generate mode: publish & save draft ───────────────────────────────────────
async function saveProject(asDraft) {
  if (state.generating) return;
  const slug  = slugify(slugInput.value);
  const title = titleInput.value.trim();
  if (!slug) {
    setStatus(publishStatus, 'Please enter a valid URL slug.', true);
    return;
  }
  if (publishBtn) publishBtn.disabled = true;
  if (draftBtn)   draftBtn.disabled   = true;
  if (discardBtn) discardBtn.disabled = true;
  setStatus(publishStatus, asDraft ? 'Saving draft…' : 'Publishing…');
  try {
    await apiFetch(asDraft ? '/admin/studio/save-draft' : '/admin/studio/publish', { slug, title });
    clearStorage();
    setStatus(publishStatus, asDraft ? 'Draft saved! Redirecting…' : 'Published! Redirecting…');
    setTimeout(() => { window.location.href = '/admin/dashboard'; }, 900);
  } catch (err) {
    setStatus(publishStatus, err.message, true);
    publishBtn.disabled = false;
    if (draftBtn) draftBtn.disabled = false;
    if (discardBtn) discardBtn.disabled = false;
  }
}

if (publishBtn) publishBtn.addEventListener('click', () => studioMode === 'edit' ? publishEdits() : saveProject(false));
if (draftBtn) draftBtn.addEventListener('click', () => studioMode === 'edit' ? publishEdits() : saveProject(true));

// ── Discard ───────────────────────────────────────────────────────────────────
if (discardBtn) discardBtn.addEventListener('click', async () => {
  if (studioMode === 'edit') {
    window.location.href = '/admin/dashboard';
    return;
  }
  if (!confirm('Discard this project and all uploaded files?')) return;
  clearStorage();
  try { await apiFetch('/admin/studio/discard', {}); } finally {
    window.location.href = '/admin/dashboard';
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// EDIT MODE
// ═══════════════════════════════════════════════════════════════════════════════

// ── Edit mode: init ───────────────────────────────────────────────────────────
function initEditMode(project) {
  state.currentProject = project;
  state.generated      = true;

  studioWrap.classList.add('is-generated');
  updateSlug(project?.slug);
  if (project?.title) titleInput.value = project.title;
  openSection('publish');

  // Auto-save when the homepage card title changes
  if (titleInput && !titleInput.dataset.editListening) {
    titleInput.dataset.editListening = '1';
    titleInput.addEventListener('input', () => {
      if (state.currentProject) state.currentProject.title = titleInput.value.trim();
      scheduleAutoSave();
    });
  }

  // Populate sidebar image bank with existing project images
  populateProjectFiles(project);
  renderAllFiles();
  updateFileCountNote();

  // Activate inline editing on the server-rendered project DOM
  makeTextEditable();
}

// ── Edit mode: populate sidebar from all images in the project folder ─────────
function populateProjectFiles(project) {
  // Build src → alt map from section data so labels survive a page reload
  const altMap = new Map();
  for (const sec of (project.sections || []))
    for (const img of (sec.images || []))
      if (img.src && img.alt) altMap.set(img.src, img.alt);

  const seen = new Set(state.uploadedFiles.map(f => f.permanentPath).filter(Boolean));
  const add = (src, fallbackLabel) => {
    if (!src) return;
    const resolvedTag = altMap.get(src) || fallbackLabel || '';
    if (seen.has(src)) {
      // Already added (e.g. by folder scan with empty tag) — backfill label if we now know it
      if (resolvedTag) {
        const existing = state.uploadedFiles.find(f => f.permanentPath === src);
        if (existing && !existing.tag) existing.tag = resolvedTag;
      }
      return;
    }
    seen.add(src);
    const fn = src.split('/').pop();
    state.uploadedFiles.push({
      filename: fn, originalName: fn, fileType: 'image',
      previewSrc: src, permanentPath: src, fromEditor: false,
      tag: resolvedTag,
    });
  };

  // Load ALL images from the project's folder (server-scanned list)
  const folderEl = document.getElementById('studio-folder-images');
  if (folderEl) {
    try {
      const folderImages = JSON.parse(folderEl.textContent);
      folderImages.forEach(src => add(src, ''));
    } catch { /* ignore parse errors */ }
  }

  // Ensure thumbnail and section images are included even if missing from folder scan.
  // Use thumbnailAlt (persisted in DB) as the thumbnail's label.
  if (project.thumbnail) add(project.thumbnail, project.thumbnailAlt || '');
  for (const sec of (project.sections || []))
    for (const img of (sec.images || [])) add(img.src, img.alt || '');
}


// Update alt text for an image across all sections and the sidebar state
function updateImageLabel(src, label) {
  const project = state.currentProject;
  if (project) {
    // Persist thumbnail label via thumbnailAlt (stored in DB)
    if (project.thumbnail === src) project.thumbnailAlt = label;
    // Persist section image labels via alt text
    for (const sec of (project.sections || []))
      for (const img of (sec.images || []))
        if (img.src === src) img.alt = label;
  }
  // Also update DOM img elements so the live preview reflects it immediately
  const scope = $('studio-preview-content');
  if (scope) {
    scope.querySelectorAll(`.project-section-images img[src="${CSS.escape(src)}"]`).forEach(el => {
      el.alt = label;
      el.title = label;
    });
  }
}

// ── Edit mode: read current project from DOM (single source of truth) ─────────
function readProjectFromDOM() {
  const scope    = $('studio-preview-content');
  const stateSecs = state.currentProject?.sections || [];
  const sections  = [];

  (scope?.querySelectorAll('[data-section-id]') || []).forEach(container => {
    // Only process real section containers (must contain a .project-section)
    if (!container.querySelector('.project-section')) return;
    const sectionId = container.dataset.sectionId;
    const stateSec  = stateSecs.find(s => String(s.id) === String(sectionId));
    const headingEl = container.querySelector('.project-section__heading');
    const bodyEl    = container.querySelector('.project-section__body');
    const imgEls    = [...container.querySelectorAll('.project-section-images img')];
    sections.push({
      id:      sectionId,
      heading: headingEl?.textContent.trim() || stateSec?.heading || '',
      body:    bodyEl
        ? bodyEl.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
        : (stateSec?.body || ''),
      images:  imgEls.map(img => ({ src: img.getAttribute('src') || '', alt: img.alt || '' })).filter(i => i.src),
      cols:    stateSec?.cols ?? 0,
    });
  });

  return {
    ...(state.currentProject || {}),
    pageTitle: scope?.querySelector('.project-title')?.textContent.trim()    || state.currentProject?.pageTitle || '',
    subtitle:  scope?.querySelector('.project-subtitle')?.textContent.trim() || state.currentProject?.subtitle  || '',
    sections,
  };
}

// ── Edit mode: save to DB (no redirect) ──────────────────────────────────────
let _saving = false;
let _pendingSave = false;

async function saveEdit() {
  if (_saving) { _pendingSave = true; return; }
  _saving = true;

  const project = readProjectFromDOM();
  const totalImgs = project.sections.reduce((t, s) => t + s.images.length, 0);
  setStatus(publishStatus, `Saving…`);

  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(editSlug)}/publish-edits`, { project });
    setStatus(publishStatus, `Saved (${project.sections.length} sections, ${totalImgs} images)`);
    setTimeout(() => setStatus(publishStatus, ''), 3000);
  } catch (err) {
    // If session expired, show a clear message
    const msg = err.message.includes('403') || err.message.includes('Forbidden') || err.message.includes('login')
      ? 'Session expired — please refresh and log back in'
      : err.message;
    setStatus(publishStatus, msg, true);
  } finally {
    _saving = false;
    if (_pendingSave) { _pendingSave = false; saveEdit(); }
  }
}

let _autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(saveEdit, 800);
}

// ── Edit mode: publish = save + redirect ──────────────────────────────────────
async function publishEdits() {
  if (publishBtn) publishBtn.disabled = true;
  setStatus(publishStatus, 'Saving…');
  try {
    const project   = readProjectFromDOM();
    const totalImgs = project.sections.reduce((t, s) => t + s.images.length, 0);
    await apiFetch(`/admin/projects/${encodeURIComponent(editSlug)}/publish-edits`, { project });
    setStatus(publishStatus, `Saved (${project.sections.length} sections, ${totalImgs} images) — returning…`);
    setTimeout(() => { window.location.href = '/admin/dashboard'; }, 1200);
  } catch (err) {
    const msg = err.message.includes('403') || err.message.includes('Forbidden') || err.message.includes('login')
      ? 'Session expired — please refresh and log back in'
      : err.message;
    setStatus(publishStatus, msg, true);
    if (publishBtn) publishBtn.disabled = false;
  }
}

// ── Edit mode: activate text + image editing on the preview DOM ───────────────
function makeTextEditable() {
  activateEditing($('studio-preview-content'));
}

// ── AI preview mode (orange banner, editing frozen until accept/discard) ───────
const ACCEPT_RE = /^(yes|yep|yup|ok|okay|sure|good|great|perfect|looks good|love it|accept|approve|go ahead|save|save it|commit|apply|keep|keep it|that works|that's good|done|correct|right|solid|ship it|lgtm)\W*$/i;

function enterAiPreviewMode() {
  const scope = $('studio-preview-content');
  if (!scope) return;
  scope.classList.add('is-ai-preview');
  // Freeze all contenteditable elements
  scope.querySelectorAll('[contenteditable="true"]').forEach(el => {
    el.contentEditable = 'false';
    el.dataset.wasEditable = '1';
  });
  // Swap hint bar to orange
  const hint = scope.querySelector('.studio-edit-hint');
  if (hint) {
    hint.className = 'studio-edit-hint is-ai-preview';
    hint.innerHTML =
      '<span>Showing AI suggested changes</span>' +
      '<button class="studio-ai-accept-btn" aria-label="Accept AI changes">✓ Accept</button>' +
      '<button class="studio-ai-discard-btn" aria-label="Discard AI changes">✕ Discard</button>';
    hint.style.pointerEvents = 'auto';
    hint.querySelector('.studio-ai-accept-btn').addEventListener('click', acceptAiChanges);
    hint.querySelector('.studio-ai-discard-btn').addEventListener('click', discardAiChanges);
  }
}

function exitAiPreviewMode() {
  const scope = $('studio-preview-content');
  if (!scope) return;
  scope.classList.remove('is-ai-preview');
  // Restore contenteditable
  scope.querySelectorAll('[data-was-editable]').forEach(el => {
    el.contentEditable = 'true';
    delete el.dataset.wasEditable;
  });
  // Restore hint bar
  const hint = scope.querySelector('.studio-edit-hint');
  if (hint) {
    hint.className = 'studio-edit-hint';
    hint.textContent = 'Click any text to edit';
    hint.style.pointerEvents = 'none';
  }
  state.pendingAiProject = null;
  state.preAiProject     = null;
}

async function acceptAiChanges() {
  await saveEdit();
  exitAiPreviewMode();
}

async function discardAiChanges() {
  const old = state.preAiProject;
  if (!old) { exitAiPreviewMode(); return; }
  state.currentProject = old;
  // Re-render from the pre-AI snapshot
  const res = await fetch('/admin/studio/preview', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    body:    JSON.stringify({ project: old }),
  });
  if (res.ok) {
    const { html } = await res.json();
    const content = $('studio-preview-content');
    if (content) {
      _imgActiveWrap = null;
      _imgSelectedEl = null;
      content.innerHTML = html;
      delete content.dataset.editListening; // allow listeners to re-register on fresh DOM
      exitAiPreviewMode();
      makeTextEditable();
    }
  } else {
    exitAiPreviewMode();
  }
}

function activateEditing(scope) {
  if (!scope) return;

  // "Click to edit" hint bar
  if (!scope.querySelector('.studio-edit-hint')) {
    const hint = document.createElement('div');
    hint.className = 'studio-edit-hint';
    hint.textContent = 'Click any text to edit';
    scope.insertBefore(hint, scope.firstChild);
  }

  // Make title/subtitle contenteditable
  [
    ['.project-title',    'Project title'],
    ['.project-subtitle', 'Project subtitle'],
  ].forEach(([sel, ph]) => {
    const el = scope.querySelector(sel);
    if (el) { el.contentEditable = 'true'; el.dataset.placeholder = ph; }
  });

  // Make section headings and bodies contenteditable
  scope.querySelectorAll('.project-section').forEach(sec => {
    const h = sec.querySelector('.project-section__heading');
    const b = sec.querySelector('.project-section__body');
    if (h) { h.contentEditable = 'true'; h.dataset.placeholder = 'Section heading'; }
    if (b) { b.contentEditable = 'true'; b.dataset.placeholder = 'Section body'; }
  });

  // Auto-save 800ms after typing stops in any contenteditable
  if (!scope.dataset.editListening) {
    scope.dataset.editListening = '1';
    scope.addEventListener('input', scheduleAutoSave);
    scope.addEventListener('blur', e => {
      if (e.target.isContentEditable) scheduleAutoSave();
    }, true); // capture so blur reaches us even though it doesn't bubble
  }

  makeImagesEditable(scope);
  applyJustifiedRows(scope);

  // "Add Section" button (once)
  if (!scope.querySelector('.studio-add-section-btn')) {
    const btn = document.createElement('button');
    btn.className = 'studio-add-section-btn';
    btn.textContent = '+ Add Section';
    btn.addEventListener('click', e => { e.stopPropagation(); addSection(); });
    scope.appendChild(btn);
  }
}

// ── Justified image rows (mirrors main.js) ────────────────────────────────────
function applyJustifiedRows(scope) {
  (scope || document).querySelectorAll('.project-section-images').forEach(row => {
    const imgs = [...row.querySelectorAll('img')];
    if (imgs.length < 2) return;
    imgs.forEach(img => {
      const size = () => {
        if (img.naturalWidth > 0) {
          img.style.flex  = `${img.naturalWidth / img.naturalHeight} 1 0%`;
          img.style.width = '0';
        }
      };
      if (img.complete && img.naturalWidth > 0) size();
      else img.addEventListener('load', size, { once: true });
    });
  });
}

// ── Section lookup ────────────────────────────────────────────────────────────
function getSec(sectionId) {
  const sec = state.currentProject?.sections?.find(s => String(s.id) === String(sectionId));
  if (!sec) {
    const known = state.currentProject?.sections?.map(s => s.id) || [];
    console.warn('[studio] getSec: no match for', sectionId, '— known IDs:', known);
    setStatus(uploadStatusSidebar, 'Section not found — please refresh the page', true);
  }
  return sec || null;
}

// ── Wrap image areas for editing ──────────────────────────────────────────────
function makeImagesEditable(scope) {
  if (!scope) return;
  scope.querySelectorAll('[data-section-id]').forEach(container => {
    const section = container.querySelector('.project-section');
    if (!section || section.querySelector('.img-section-wrap')) return; // already wrapped

    const existingRows = [...section.querySelectorAll('.project-section-images')];
    const wrap = document.createElement('div');
    wrap.className = 'img-section-wrap';

    if (existingRows.length > 0) {
      existingRows[0].before(wrap);
      existingRows.forEach(r => wrap.appendChild(r));
    } else {
      section.appendChild(wrap);
      wrap.appendChild(makeImgPlaceholder());
    }

    const bar = buildImgEditBar(container);
    wrap.appendChild(bar);

    wrap.addEventListener('click', e => {
      e.stopPropagation();
      activateImgSection(wrap, container.dataset.sectionId);
      const img = e.target.closest('img');
      if (img) setSelectedImg(img, wrap);
      else     clearSelectedImg(wrap);
    });
  });

  // Global click — deactivate section when clicking outside any wrap
  if (!scope.dataset.imgListening) {
    scope.dataset.imgListening = '1';
    scope.addEventListener('click', e => {
      if (!e.target.closest('.img-section-wrap')) deactivateImgSection();
    });
  }
}

// ── Refresh active section's Add/Replace dropdowns ────────────────────────────
function refreshImgDropdowns() {
  if (!_imgActiveWrap) return;
  const container = _imgActiveWrap.closest('[data-section-id]');
  if (container) activateImgSection(_imgActiveWrap, container.dataset.sectionId);
}

// ── Import a new image directly into a section ────────────────────────────────
function importImageToSection(container, sectionId) {
  const inp = document.createElement('input');
  inp.type   = 'file';
  inp.accept = 'image/jpeg,image/png,image/gif,image/webp';
  inp.style.cssText = 'position:fixed;top:-200vh;left:-200vw;width:0;height:0;opacity:0;pointer-events:none;';
  document.body.appendChild(inp);

  const cleanup = () => { try { inp.remove(); } catch {} };
  window.addEventListener('focus', function onFocus() {
    window.removeEventListener('focus', onFocus);
    setTimeout(cleanup, 300);
  }, { once: true });

  inp.addEventListener('change', async () => {
    cleanup();
    const file = inp.files[0];
    if (!file) return;
    setStatus(uploadStatusSidebar, `Uploading ${file.name}…`);
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(`/admin/upload/${encodeURIComponent(editSlug)}`, {
        method: 'POST', headers: { Accept: 'application/json' }, body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const src      = data.path;
      const filename = src.split('/').pop();

      // Add to image bank if not already there
      if (!state.uploadedFiles.some(f => f.permanentPath === src)) {
        state.uploadedFiles.push({
          filename, originalName: file.name, fileType: 'image',
          previewSrc: src, permanentPath: src, fromEditor: false, tag: '',
        });
        renderFileGrid();
        updateFileCountNote();
        populateThumbnailPicker();
      }

      // Add the image to this section
      appendImgToSection(container, sectionId, src);
      setStatus(uploadStatusSidebar, '');
    } catch (err) {
      setStatus(uploadStatusSidebar, err.message, true);
    }
  });

  inp.click();
}

// ── Low-level: render an images array into a wrap element ────────────────────
// Does NOT require state — takes explicit images and cols values.
function renderImagesIntoWrap(wrap, images, cols) {
  const bar = wrap.querySelector('.img-edit-bar');
  wrap.querySelectorAll('.project-section-images').forEach(r => r.remove());
  wrap.querySelector('.img-add-placeholder')?.remove();

  if (!images.length) {
    wrap.insertBefore(makeImgPlaceholder(), bar);
  } else {
    const rows = (cols > 0)
      ? Array.from({ length: Math.ceil(images.length / cols) }, (_, i) => images.slice(i * cols, i * cols + cols))
      : [images];
    rows.forEach(rowImgs => {
      const rowEl = document.createElement('div');
      rowEl.className = 'project-section-images';
      rowImgs.forEach(imgData => {
        if (!imgData.src) return;
        const img = document.createElement('img');
        img.setAttribute('src', imgData.src);
        img.alt      = imgData.alt || '';
        img.loading  = 'lazy';
        img.decoding = 'async';
        rowEl.appendChild(img);
      });
      wrap.insertBefore(rowEl, bar);
    });
  }

  _imgSelectedEl = null;
  wrap.querySelector('.img-edit-img-controls')?.classList.remove('is-visible');
  wrap.querySelectorAll('.img-edit-perrow-btn').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.cols) === cols);
  });
  applyJustifiedRows(wrap);
}

// ── Append an image (by src) to a section — works even if state is missing ───
function appendImgToSection(container, sectionId, src) {
  const wrap = container.querySelector('.img-section-wrap');
  if (!wrap) return;

  // Read current images from DOM (the authoritative source)
  const domImgs = [...wrap.querySelectorAll('.project-section-images img')];
  const sec     = getSec(sectionId); // may be null — that's OK
  const cols    = sec?.cols ?? 0;

  const newImages = [
    ...domImgs.map(img => ({ src: img.getAttribute('src'), alt: img.alt || '' })),
    { src, alt: sec?.heading || '' },
  ];

  // Update state if available (enables move/remove to work via state later)
  if (sec) sec.images = newImages;

  // Render to DOM — this is what readProjectFromDOM reads
  renderImagesIntoWrap(wrap, newImages, cols);
  refreshImgDropdowns();
  // Auto-save immediately whenever an image is added
  saveEdit();
}

// ── Build the image toolbar for one section ───────────────────────────────────
function buildImgEditBar(container) {
  const sectionId = container.dataset.sectionId;
  const bar = document.createElement('div');
  bar.className = 'img-edit-bar';

  bar.innerHTML = `
    <div class="img-edit-group">
      <span class="img-edit-label">Per row</span>
      <div class="img-edit-perrow-btns">
        <button class="img-edit-perrow-btn" data-cols="1">1</button>
        <button class="img-edit-perrow-btn" data-cols="2">2</button>
        <button class="img-edit-perrow-btn" data-cols="3">3</button>
        <button class="img-edit-perrow-btn" data-cols="4">4</button>
        <button class="img-edit-perrow-btn" data-cols="0">All</button>
      </div>
    </div>
    <div class="img-edit-group">
      <div class="img-edit-divider"></div>
      <button class="img-edit-btn img-edit-import-btn" title="Upload new image into this section">Import</button>
      <button class="img-edit-btn img-edit-add-btn" title="Add image from bank">Add</button>
      <select class="img-edit-add-select"><option value="">Pick image…</option></select>
    </div>
    <div class="img-edit-img-controls">
      <div class="img-edit-divider"></div>
      <button class="img-edit-btn" data-action="move-left"  title="Move left">←</button>
      <button class="img-edit-btn" data-action="move-right" title="Move right">→</button>
      <button class="img-edit-btn img-edit-replace-btn" title="Replace selected image">Replace</button>
      <select class="img-edit-replace-select"><option value="">Pick image…</option></select>
      <button class="img-edit-btn img-edit-btn--remove" data-action="remove" title="Remove image">✕</button>
    </div>`;

  // Stop bar clicks from bubbling up to the wrap's deselect handler
  bar.addEventListener('click', e => e.stopPropagation());

  // Per-row layout buttons
  bar.querySelectorAll('.img-edit-perrow-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = getSec(sectionId);
      if (!sec) return;
      sec.cols = parseInt(btn.dataset.cols);
      reRenderSectionImages(container, sectionId);
    });
  });

  // Import button: file picker → upload → add to section
  bar.querySelector('.img-edit-import-btn').addEventListener('click', () => {
    importImageToSection(container, sectionId);
  });

  // Add button: toggle the Add dropdown
  bar.querySelector('.img-edit-add-btn').addEventListener('click', () => {
    const addSel  = bar.querySelector('.img-edit-add-select');
    const replSel = bar.querySelector('.img-edit-replace-select');
    const opening = addSel.style.display !== 'inline-block';
    replSel.style.display = 'none';
    addSel.style.display  = opening ? 'inline-block' : 'none';
    if (opening) addSel.focus();
  });

  // Add dropdown: append selected image to section
  bar.querySelector('.img-edit-add-select').addEventListener('change', e => {
    const src = e.target.value;
    e.target.value = '';
    e.target.style.display = 'none';
    if (!src) return;
    appendImgToSection(container, sectionId, src);
  });

  // Replace button: toggle the Replace dropdown
  bar.querySelector('.img-edit-replace-btn').addEventListener('click', () => {
    const addSel  = bar.querySelector('.img-edit-add-select');
    const replSel = bar.querySelector('.img-edit-replace-select');
    const opening = replSel.style.display !== 'inline-block';
    addSel.style.display  = 'none';
    replSel.style.display = opening ? 'inline-block' : 'none';
    if (opening) replSel.focus();
  });

  // Replace dropdown: swap the selected image
  bar.querySelector('.img-edit-replace-select').addEventListener('change', e => {
    const newSrc = e.target.value;
    e.target.value = '';
    e.target.style.display = 'none';
    if (!newSrc || !_imgSelectedEl) return;

    const sec = getSec(sectionId);
    if (!sec) return;
    const wrap    = container.querySelector('.img-section-wrap');
    const domImgs = wrap ? [...wrap.querySelectorAll('.project-section-images img')] : [];
    sec.images = domImgs.map(img => ({
      src: img === _imgSelectedEl ? newSrc : img.getAttribute('src'),
      alt: img.alt || '',
    }));
    reRenderSectionImages(container, sectionId);
    reSelectImg(container, newSrc);
    refreshImgDropdowns();
  });

  // Move / remove actions
  bar.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'move-left')  doImgMove(container, sectionId, -1);
    if (action === 'move-right') doImgMove(container, sectionId, +1);
    if (action === 'remove')     doImgRemove(container, sectionId);
  });

  return bar;
}

// ── Activate / deactivate image section ───────────────────────────────────────
function activateImgSection(wrap, sectionId) {
  if (_imgActiveWrap && _imgActiveWrap !== wrap) deactivateImgSection();
  _imgActiveWrap = wrap;
  wrap.classList.add('is-active');

  const sec = getSec(sectionId);
  const currentCols = sec?.cols ?? 0;
  wrap.querySelectorAll('.img-edit-perrow-btn').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.cols) === currentCols);
  });

  // Close dropdowns on (re)activation
  wrap.querySelector('.img-edit-add-select').style.display     = 'none';
  wrap.querySelector('.img-edit-replace-select').style.display = 'none';

  // Populate dropdowns with all uploaded images
  const imgs = state.uploadedFiles.filter(f => f.fileType === 'image');
  [wrap.querySelector('.img-edit-add-select'), wrap.querySelector('.img-edit-replace-select')].forEach(sel => {
    if (!sel) return;
    sel.innerHTML = '<option value="">Pick image…</option>';
    imgs.forEach(f => {
      const src = f.permanentPath || f.previewSrc || '';
      if (!src) return;
      const opt = document.createElement('option');
      opt.value = src;
      opt.textContent = f.tag || f.originalName || f.filename || src.split('/').pop();
      sel.appendChild(opt);
    });
  });
}

function deactivateImgSection() {
  if (!_imgActiveWrap) return;
  _imgActiveWrap.classList.remove('is-active');
  clearSelectedImg(_imgActiveWrap);
  _imgActiveWrap = null;
}

function setSelectedImg(img, wrap) {
  if (_imgSelectedEl) _imgSelectedEl.classList.remove('img-selected');
  _imgSelectedEl = img;
  img.classList.add('img-selected');
  wrap.querySelector('.img-edit-img-controls')?.classList.add('is-visible');
}

function clearSelectedImg(wrap) {
  if (_imgSelectedEl) _imgSelectedEl.classList.remove('img-selected');
  _imgSelectedEl = null;
  if (wrap) {
    wrap.querySelector('.img-edit-img-controls')?.classList.remove('is-visible');
    const replSel = wrap.querySelector('.img-edit-replace-select');
    if (replSel) replSel.style.display = 'none';
  }
}

// ── Re-render a section's images from state ───────────────────────────────────
function reRenderSectionImages(container, sectionId) {
  const sec  = getSec(sectionId);
  const wrap = container.querySelector('.img-section-wrap');
  if (!wrap || !sec) return;
  renderImagesIntoWrap(wrap, sec.images || [], sec.cols ?? 0);
  scheduleAutoSave();
}

function makeImgPlaceholder() {
  const pl = document.createElement('div');
  pl.className = 'img-add-placeholder';
  pl.innerHTML = '<span class="img-placeholder-plus">+</span><span>Add a photo</span>';
  return pl;
}

// ── Add a new section at the bottom ──────────────────────────────────────────
function addSection() {
  const newSec = { id: crypto.randomUUID(), heading: 'New Section', body: '', images: [], cols: 0 };
  if (state.currentProject) {
    state.currentProject.sections = [...(state.currentProject.sections || []), newSec];
  }

  const scope = $('studio-preview-content');
  if (!scope) return;

  const container = document.createElement('div');
  container.className = 'container';
  container.dataset.sectionId = newSec.id;

  const section = document.createElement('section');
  section.className = 'project-section';

  const h = document.createElement('h2');
  h.className = 'project-section__heading';
  h.contentEditable = 'true';
  h.dataset.placeholder = 'Section heading';
  h.textContent = 'New Section';

  const b = document.createElement('div');
  b.className = 'project-section__body';
  b.contentEditable = 'true';
  b.dataset.placeholder = 'Section body';

  section.appendChild(h);
  section.appendChild(b);
  container.appendChild(section);

  const addBtn = scope.querySelector('.studio-add-section-btn');
  scope.insertBefore(container, addBtn);

  // Wire up image editing for the new section
  makeImagesEditable(scope);
  scheduleAutoSave();
  container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Re-select an image by src after re-render ─────────────────────────────────
function reSelectImg(container, src) {
  const wrap  = container.querySelector('.img-section-wrap');
  if (!wrap) return;
  const match = [...wrap.querySelectorAll('img')].find(i => i.getAttribute('src') === src);
  if (match) setSelectedImg(match, wrap);
}

// ── Move selected image left or right ─────────────────────────────────────────
function doImgMove(container, sectionId, delta) {
  if (!_imgSelectedEl) return;
  const wrap = container.querySelector('.img-section-wrap');
  if (!wrap) return;
  const sec = getSec(sectionId);
  if (!sec) return;

  const allImgs    = [...wrap.querySelectorAll('.project-section-images img')];
  const idx        = allImgs.indexOf(_imgSelectedEl);
  const newIdx     = idx + delta;
  if (idx < 0 || newIdx < 0 || newIdx >= allImgs.length) return;

  const selectedSrc = _imgSelectedEl.getAttribute('src');
  const reordered   = [...allImgs];
  [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];

  const imgMap = new Map((sec.images || []).map(i => [i.src, i]));
  sec.images = reordered.map(img => {
    const s = img.getAttribute('src');
    return imgMap.get(s) || { src: s, alt: img.alt || '' };
  });

  reRenderSectionImages(container, sectionId);
  reSelectImg(container, selectedSrc);
  saveEdit();
}

// ── Remove selected image from a section ─────────────────────────────────────
function doImgRemove(container, sectionId) {
  if (!_imgSelectedEl) return;
  const sec = getSec(sectionId);
  if (!sec) return;
  const src = _imgSelectedEl.getAttribute('src');
  sec.images = (sec.images || []).filter(i => i.src !== src);
  _imgSelectedEl = null;
  reRenderSectionImages(container, sectionId);
  saveEdit();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
if (studioMode !== 'edit') tryRestoreFromStorage();

if (studioMode === 'edit' && initialProject) {
  try {
    initEditMode(initialProject);
  } catch (e) {
    console.error('initEditMode failed:', e);
    const scope = $('studio-preview-content');
    if (scope) {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'background:#fdd;color:#900;padding:12px;font:12px monospace;white-space:pre-wrap;border-bottom:1px solid #f88;';
      errEl.textContent = 'Edit mode init error:\n' + e.message;
      scope.insertBefore(errEl, scope.firstChild);
      activateEditing(scope);
    }
  }
}
