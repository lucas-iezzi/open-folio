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
  sidebarCollapsed: false,
  editModeActive:   false,
  hasManualEdits:   false,
};

// ── Mode (edit vs generate) ───────────────────────────────────────────────────
const studioMode = document.querySelector('meta[name="studio-mode"]')?.content || 'generate';
const editSlug   = document.querySelector('meta[name="studio-edit-slug"]')?.content || '';
const hasDraft   = document.querySelector('meta[name="studio-has-draft"]')?.content === '1';

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
// Sync collapse state immediately from DOM — edit mode pre-applies sidebar-collapsed server-side
if (studioWrap?.classList.contains('sidebar-collapsed')) state.sidebarCollapsed = true;
const dropZone          = $('studio-drop-zone');
// Attach a throwaway file input off-screen for the duration of the pick,
// then remove it — browsers require it to be in the DOM to allow .click(),
// but position:fixed + negative coords keeps it fully invisible.
function pickFiles() {
  const inp = document.createElement('input');
  inp.type  = 'file';
  inp.multiple = true;
  inp.accept   = 'image/jpeg,image/png,image/gif,image/webp,text/plain,text/markdown,text/csv,application/json,.txt,.md,.csv,.json';
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
const pregenFileList    = $('pregen-file-list');
const fileGrid          = $('studio-image-grid');
const uploadStatus      = $('studio-upload-status');
const uploadStatusSidebar = $('studio-upload-status-sidebar');
const tagSaveStatus     = $('studio-tag-save-status');
const description       = $('studio-description');
const provider          = $('studio-provider');
const modelSel          = $('studio-model');
const generateBtn       = $('studio-generate-btn');
const generateStatus    = $('studio-generate-status');
const fileCountNote     = $('studio-file-count-note');
const chatHistory       = $('studio-chat-history');
const chatInput         = $('studio-chat-input');
const chatSend          = $('studio-chat-send');
const chatStatus        = $('studio-chat-status');
const titleInput        = $('studio-title');
const slugInput         = $('studio-slug');
const slugPreview       = $('studio-slug-preview');
const publishBtn        = $('studio-publish-btn');
const draftBtn          = $('studio-draft-btn');
const discardBtn        = $('studio-discard-btn');
const publishStatus     = $('studio-publish-status');
const previewFrame      = $('studio-preview-frame');
const loading           = $('studio-loading');
const loadingText       = $('studio-loading-text');
const sidebarUploadBtn  = $('sidebar-upload-btn');
const sidebarToggleBtn  = $('studio-sidebar-toggle');

const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  // publishStatus is .studio-nav-status in edit mode, .studio-status in generate mode
  const base = el.classList.contains('studio-nav-status') ? 'studio-nav-status' : 'studio-status';
  el.className = base + (isError ? ' is-error' : '');
}

function lockButtons(on) {
  state.generating      = on;
  if (generateBtn) generateBtn.disabled = on;
  chatSend.disabled     = on;
  chatInput.disabled    = on;
  publishBtn.disabled   = on;
  draftBtn.disabled     = on;
  discardBtn.disabled   = on;
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
  fileCountNote.textContent = parts.length
    ? parts.join(' · ')
    : 'No files';
}

// ── Layout transition ─────────────────────────────────────────────────────────
let _timerInterval = null;
let _timerStart    = 0;

function transitionToPostGen() {
  const sidebar = $('studio-sidebar');
  sidebar.style.display = ''; // unhide; CSS grid takes over from here
  studioWrap.classList.add('is-generated');
  loading.classList.add('is-active');
  previewFrame.style.display = 'none';
  openSection('chat');
  updateFileCountNote();
  renderAllFiles(); // re-render sidebar grid
}

function startLoadingTimer() {
  _timerStart = Date.now();
  clearInterval(_timerInterval);
  const tick = () => {
    const s = Math.floor((Date.now() - _timerStart) / 1000);
    loadingText.textContent = `Generating — ${s}s`;
  };
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

// File list shown in the pre-gen form card — includes label inputs
function renderPregenFileList() {
  if (!pregenFileList) return;
  pregenFileList.innerHTML = '';
  for (const f of state.uploadedFiles) {
    const item = document.createElement('div');
    item.className = 'studio-pregen-file-item';

    const tagVal         = (f.tag || '').replace(/"/g, '&quot;');
    const tagPlaceholder = f.fileType === 'image' ? 'e.g. hero shot, before photo' : 'e.g. project notes, spec doc';

    const thumb = f.fileType === 'image'
      ? `<img class="studio-pregen-file-thumb" src="${f.previewSrc}" alt="${f.originalName}">`
      : `<div class="studio-pregen-file-icon">${fileExt(f.originalName)}</div>`;

    item.innerHTML = `
      ${thumb}
      <div class="studio-pregen-file-info">
        <span class="studio-pregen-file-name" title="${f.originalName}">${f.originalName}</span>
        <input class="studio-pregen-tag-input" type="text" placeholder="${tagPlaceholder}" maxlength="80" value="${tagVal}" data-filename="${f.filename}" aria-label="Label for ${f.originalName}">
      </div>
      <button class="studio-pregen-file-remove" data-filename="${f.filename}" title="Remove">✕</button>`;

    pregenFileList.appendChild(item);
  }
}

// Full tag-editing grid shown in the sidebar
function renderFileGrid() {
  fileGrid.innerHTML = '';
  for (const f of state.uploadedFiles) {
    const card = document.createElement('div');
    card.className = 'studio-file-card';

    const tagVal         = (f.tag || '').replace(/"/g, '&quot;');
    const tagPlaceholder = f.fileType === 'image' ? 'e.g. hero shot, before photo' : 'e.g. project notes, spec doc';

    if (f.fileType === 'image') {
      card.innerHTML = `
        <div class="studio-file-thumb">
          <img src="${f.previewSrc}" alt="${f.originalName}" title="${f.originalName}">
          <button class="studio-file-remove" data-filename="${f.filename}" title="Remove">✕</button>
        </div>
        <input class="studio-file-tag-input" type="text" placeholder="${tagPlaceholder}" maxlength="80" value="${tagVal}" data-filename="${f.filename}" aria-label="Label for ${f.originalName}">`;
    } else {
      card.innerHTML = `
        <div class="studio-file-thumb studio-file-thumb--doc">
          <div class="studio-file-icon">
            <div class="studio-file-icon-ext">${fileExt(f.originalName)}</div>
            <div class="studio-file-icon-name">${f.originalName}</div>
          </div>
          <button class="studio-file-remove" data-filename="${f.filename}" title="Remove">✕</button>
        </div>
        <input class="studio-file-tag-input" type="text" placeholder="${tagPlaceholder}" maxlength="80" value="${tagVal}" data-filename="${f.filename}" aria-label="Label for ${f.originalName}">`;
    }

    fileGrid.appendChild(card);
  }
}

function renderAllFiles() {
  renderPregenFileList();
  renderFileGrid();
  updateFileCountNote();
  populateThumbnailPicker();
}

// ── Thumbnail picker ──────────────────────────────────────────────────────────
function populateThumbnailPicker() {
  const select  = $('studio-thumbnail-select');
  const preview = $('studio-thumbnail-preview');
  if (!select) return;

  const images  = state.uploadedFiles.filter(f => f.fileType === 'image');
  const current = state.currentProject?.thumbnail || '';

  select.innerHTML = '<option value="">— no thumbnail —</option>';
  images.forEach(f => {
    const src  = f.permanentPath || f.previewSrc || '';
    const label = f.tag || f.originalName || f.filename;
    const opt  = document.createElement('option');
    opt.value  = src;
    opt.textContent = label;
    if (src === current) opt.selected = true;
    select.appendChild(opt);
  });

  updateThumbnailPreview(current, preview);

  if (!select.dataset.listening) {
    select.dataset.listening = '1';
    select.addEventListener('change', () => {
      const val = select.value;
      if (state.currentProject) state.currentProject.thumbnail = val;
      updateThumbnailPreview(val, preview);
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

// Tag changes (sidebar) — debounce sync to server
const _tagDebounces = {};
fileGrid.addEventListener('input', e => {
  const input = e.target.closest('.studio-file-tag-input');
  if (!input) return;
  const f = state.uploadedFiles.find(f => f.filename === input.dataset.filename);
  if (!f) return;
  f.tag = input.value.slice(0, 80);
  scheduleSave();
  clearTimeout(_tagDebounces[f.filename]);
  _tagDebounces[f.filename] = setTimeout(() => syncTag(f.filename, f.tag), 800);
});

async function syncTag(filename, tag) {
  try {
    await apiFetch('/admin/studio/update-tag', { filename, tag });
    setStatus(tagSaveStatus, 'Labels synced.', false);
    tagSaveStatus.className = 'studio-status is-done';
    setTimeout(() => setStatus(tagSaveStatus, ''), 2000);
  } catch { /* silent */ }
}

// Remove file (sidebar grid)
fileGrid.addEventListener('click', async e => {
  const btn = e.target.closest('.studio-file-remove');
  if (!btn) return;
  await removeFile(btn.dataset.filename);
});

// Tag changes (pre-gen list) — update state so getTags() picks them up on Generate
if (pregenFileList) {
  pregenFileList.addEventListener('input', e => {
    const input = e.target.closest('.studio-pregen-tag-input');
    if (!input) return;
    const f = state.uploadedFiles.find(f => f.filename === input.dataset.filename);
    if (!f) return;
    f.tag = input.value.slice(0, 80);
    scheduleSave();
  });

  // Remove file (pre-gen list)
  pregenFileList.addEventListener('click', async e => {
    const btn = e.target.closest('.studio-pregen-file-remove');
    if (!btn) return;
    await removeFile(btn.dataset.filename);
  });
}

async function removeFile(filename) {
  try {
    await apiFetch('/admin/studio/delete-upload', { filename });
    state.uploadedFiles = state.uploadedFiles.filter(f => f.filename !== filename);
    renderAllFiles();
    saveToStorage();
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
    const res = await fetch('/admin/studio/upload', {
      method:  'POST',
      headers: { 'Accept': 'application/json' },
      body:    form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.uploadedFiles.push({ ...data.file, tag: '' });
    renderAllFiles();
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

// Sidebar "Add files" button
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

  state.provider = provider?.value || 'anthropic';
  state.model    = modelSel?.value || 'claude-sonnet-4-6';

  lockButtons(true);
  transitionToPostGen();
  startLoadingTimer();
  appendBubble('user', desc);

  try {
    const data = await apiFetch('/admin/studio/generate', {
      description: desc,
      provider:    state.provider,
      model:       state.model,
      tags:        getTags(),
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
  const clean             = slugify(slug);
  slugInput.value         = clean;
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

  chatInput.value = '';
  appendBubble('user', msg);
  const thinkingBubble = appendBubble('assistant', '', { isThinking: true });

  lockButtons(true);

  try {
    const data = await apiFetch('/admin/studio/refine', {
      feedback:       msg,
      provider:       state.provider,
      model:          state.model,
      tags:           getTags(),
      currentProject: state.currentProject,
      editorImages:   state.uploadedFiles.filter(f => f.fromEditor),
      hadManualEdits: state.hasManualEdits,
    });

    state.hasManualEdits = false;
    thinkingBubble.remove();
    if (data.message) appendBubble('assistant', data.message);

    if (data.regenerate) {
      const oldSrc = previewFrame.srcdoc;
      try {
        if (data.project) state.currentProject = data.project;
        await refreshPreview();
        updateSlug(data.project?.slug);
        if (data.project?.title) titleInput.value = data.project.title;
        if (state.editModeActive) {
          await new Promise(resolve => {
            previewFrame.addEventListener('load', resolve, { once: true });
          });
          enableEditMode();
        }
      } catch {
        previewFrame.srcdoc = oldSrc;
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

// ── Preview ───────────────────────────────────────────────────────────────────
async function refreshPreview() {
  if (studioMode === 'edit') {
    // Edit mode: update the inline project content div
    const res = await fetch('/admin/studio/preview', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body:    JSON.stringify({ project: state.currentProject }),
    });
    if (!res.ok) return;
    const { html } = await res.json();
    const content = $('studio-preview-content');
    if (content) {
      content.innerHTML = html;
      makeTextEditable();
    }
  } else {
    // Generate mode: render full page in iframe via srcdoc
    const res = await fetch('/admin/studio/preview', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body:    JSON.stringify({ project: state.currentProject }),
    });
    previewFrame.style.display = 'block';
    if (!res.ok) return;
    const { html } = await res.json();
    await new Promise(resolve => {
      previewFrame.addEventListener('load', resolve, { once: true });
      previewFrame.srcdoc = html;
    });
  }
}

// ── Publish & Save Draft ──────────────────────────────────────────────────────
async function saveProject(asDraft) {
  if (state.generating) return;
  const slug  = slugify(slugInput.value);
  const title = titleInput.value.trim();
  if (!slug) {
    setStatus(publishStatus, 'Please enter a valid URL slug.', true);
    return;
  }

  publishBtn.disabled = true;
  draftBtn.disabled   = true;
  discardBtn.disabled = true;
  setStatus(publishStatus, asDraft ? 'Saving draft…' : 'Publishing…');

  try {
    const endpoint = asDraft ? '/admin/studio/save-draft' : '/admin/studio/publish';
    await apiFetch(endpoint, { slug, title });
    clearStorage();
    setStatus(publishStatus, asDraft ? 'Draft saved! Redirecting…' : 'Published! Redirecting…');
    setTimeout(() => { window.location.href = '/admin/dashboard'; }, 900);
  } catch (err) {
    setStatus(publishStatus, err.message, true);
    publishBtn.disabled = false;
    draftBtn.disabled   = false;
    discardBtn.disabled = false;
  }
}

publishBtn.addEventListener('click', () => studioMode === 'edit' ? publishEdits() : saveProject(false));
draftBtn.addEventListener('click',   () => studioMode === 'edit' ? saveDraftEdits() : saveProject(true));

// ── Discard ───────────────────────────────────────────────────────────────────
discardBtn.addEventListener('click', async () => {
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

// ── Sidebar collapse ──────────────────────────────────────────────────────────
function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  studioWrap.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
}

$('studio-collapse-btn')?.addEventListener('click', toggleSidebar);
if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', toggleSidebar);

// ── Edit mode: init ───────────────────────────────────────────────────────────
function initEditMode(project) {
  state.currentProject = project;
  state.generated = true;

  studioWrap.classList.add('is-generated', 'sidebar-collapsed');
  updateSlug(project?.slug);
  if (project?.title) titleInput.value = project.title;
  openSection('publish');

  populateProjectFiles(project);
  renderAllFiles();
  updateFileCountNote();

  // Project HTML is already in the DOM (server-side rendered) — just activate editing
  makeTextEditable();

  if (hasDraft) {
    const discardEl = document.createElement('button');
    discardEl.className = 'btn btn-sm btn-ghost studio-full-btn';
    discardEl.style.marginTop = '8px';
    discardEl.textContent = 'Discard Draft';
    discardEl.addEventListener('click', discardDraftEdits);
    $('section-publish-body')?.appendChild(discardEl);
  }
}

// ── Edit mode: make text fields contenteditable ───────────────────────────────
function makeTextEditable() {
  activateEditing($('studio-preview-content'));
}

// ── Edit mode: populate sidebar files from project images ─────────────────────
function populateProjectFiles(project) {
  const seen = new Set(state.uploadedFiles.map(f => f.permanentPath).filter(Boolean));

  const add = (src, label) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    const fn = src.split('/').pop();
    state.uploadedFiles.push({
      filename:     fn,
      originalName: fn,
      fileType:     'image',
      previewSrc:   src,
      permanentPath: src,
      fromEditor:   false,
      tag:          label || '',
    });
  };

  if (project.thumbnail) add(project.thumbnail, 'Thumbnail');
  for (const sec of (project.sections || [])) {
    for (const img of (sec.images || [])) add(img.src, img.alt || '');
  }
}

// ── Edit mode: enable (inject editing UI into iframe) ────────────────────────
async function enableEditMode() {
  const doc = previewFrame.contentDocument;
  if (!doc || !doc.body) return;
  state.editModeActive = true;
  doc.body.setAttribute('data-edit-mode', '');
  if (!doc.getElementById('studio-edit-style')) {
    const link = doc.createElement('link');
    link.id = 'studio-edit-style';
    link.rel = 'stylesheet';
    link.href = '/css/studio-editing.css';
    await new Promise(resolve => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      doc.head.appendChild(link);
    });
  }
  injectEditingIntoIframe(doc);
}

// ── Edit mode: disable ────────────────────────────────────────────────────────
function disableEditMode() {
  const doc = previewFrame.contentDocument;
  if (doc && doc.body) {
    syncFromDOM(doc);
    state.hasManualEdits = true;
    doc.body.removeAttribute('data-edit-mode');
    const styleLink = doc.getElementById('studio-edit-style');
    if (styleLink) styleLink.remove();
    doc.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    doc.querySelectorAll('.edit-img-wrap').forEach(wrap => {
      const img = wrap.querySelector('img');
      if (img) wrap.parentNode.insertBefore(img, wrap);
      wrap.remove();
    });
    doc.querySelectorAll('.edit-section-bar, .edit-img-controls, .edit-add-img, .edit-add-section').forEach(el => el.remove());
    doc.querySelectorAll('.edit-section-wrap').forEach(el => el.classList.remove('edit-section-wrap'));
    doc.querySelectorAll('.edit-section-drop-above, .edit-section-drop-below').forEach(el => {
      el.classList.remove('edit-section-drop-above', 'edit-section-drop-below');
    });
  }
  state.editModeActive = false;
}

// ── Edit mode: sync DOM → state ───────────────────────────────────────────────
let _syncDebounce;
function syncFromDOM() {
  const scope = $('studio-preview-content');
  if (!scope || !state.currentProject) return;

  const titleEl = scope.querySelector('.project-title');
  if (titleEl) state.currentProject.pageTitle = titleEl.textContent.trim();

  const subtitleEl = scope.querySelector('.project-subtitle');
  if (subtitleEl) state.currentProject.subtitle = subtitleEl.textContent.trim();

  const sections = state.currentProject.sections;
  scope.querySelectorAll('[data-section-id]').forEach(container => {
    const sectionId = container.dataset.sectionId;
    const sec = sections.find(s => String(s.id) === String(sectionId));
    if (!sec) return;
    const headingEl = container.querySelector('.project-section__heading');
    if (headingEl) sec.heading = headingEl.textContent.trim();
    const bodyEl = container.querySelector('.project-section__body');
    if (bodyEl) {
      sec.body = bodyEl.innerHTML
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
    }
    const imgEls = [...container.querySelectorAll('.project-section-images img')];
    sec.images = imgEls.map(img => ({
      src: img.getAttribute('src') || '',
      alt: img.alt || '',
    })).filter(img => img.src);
  });
}

function scheduleSync() {
  clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(syncFromDOM, 100);
}

// ── Edit mode: inject UI into iframe ─────────────────────────────────────────
let _dragImgSrc = null;
let _dragImgSection = null;

function injectEditingIntoIframe(doc) {
  const containers = [...doc.querySelectorAll('main > .container')];
  if (!containers.length) return;

  const headerContainer = containers[0];
  const sectionContainers = containers.slice(1);

  // Header: make title/subtitle contenteditable
  const titleEl = headerContainer.querySelector('.project-title');
  if (titleEl) {
    titleEl.contentEditable = 'true';
    titleEl.dataset.placeholder = 'Project title';
  }
  let subtitleEl = headerContainer.querySelector('.project-subtitle');
  if (!subtitleEl) {
    subtitleEl = doc.createElement('p');
    subtitleEl.className = 'project-subtitle';
    headerContainer.querySelector('.project-header')?.appendChild(subtitleEl);
  }
  subtitleEl.contentEditable = 'true';
  subtitleEl.dataset.placeholder = 'Project subtitle';

  // Sections
  const sections = state.currentProject?.sections || [];
  sectionContainers.forEach((container, i) => {
    const sec = sections[i];
    if (!sec) return;
    container.dataset.sectionId = sec.id;
    container.classList.add('edit-section-wrap');

    // Section bar
    const bar = doc.createElement('div');
    bar.className = 'edit-section-bar';
    const dragHandle = doc.createElement('span');
    dragHandle.className = 'edit-section-drag';
    dragHandle.title = 'Drag to reorder';
    dragHandle.textContent = '⠿';
    dragHandle.draggable = true;
    const deleteBtn = doc.createElement('button');
    deleteBtn.className = 'edit-section-delete';
    deleteBtn.title = 'Delete section';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => deleteSection(sec.id, doc));
    bar.appendChild(dragHandle);
    bar.appendChild(deleteBtn);
    container.insertBefore(bar, container.firstChild);

    // Section drag-to-reorder
    dragHandle.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-section-id', sec.id);
      requestAnimationFrame(() => container.classList.add('drag-source-section'));
    });
    dragHandle.addEventListener('dragend', () => {
      container.classList.remove('drag-source-section');
      doc.querySelectorAll('.edit-section-drop-above, .edit-section-drop-below').forEach(el => {
        el.classList.remove('edit-section-drop-above', 'edit-section-drop-below');
      });
    });
    container.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/x-section-id')) return;
      e.preventDefault();
      doc.querySelectorAll('.edit-section-drop-above, .edit-section-drop-below').forEach(el => {
        el.classList.remove('edit-section-drop-above', 'edit-section-drop-below');
      });
      const mid = container.getBoundingClientRect().top + container.offsetHeight / 2;
      container.classList.add(e.clientY < mid ? 'edit-section-drop-above' : 'edit-section-drop-below');
    });
    container.addEventListener('dragleave', e => {
      if (!container.contains(e.relatedTarget)) {
        container.classList.remove('edit-section-drop-above', 'edit-section-drop-below');
      }
    });
    container.addEventListener('drop', e => {
      const srcId = e.dataTransfer.getData('text/x-section-id');
      if (!srcId || srcId === sec.id) return;
      e.preventDefault();
      const isBefore = container.classList.contains('edit-section-drop-above');
      container.classList.remove('edit-section-drop-above', 'edit-section-drop-below');
      moveSectionInDOM(srcId, sec.id, isBefore, doc);
    });

    // Section text editing
    const sectionEl = container.querySelector('.project-section');
    if (sectionEl) {
      let headingEl = sectionEl.querySelector('.project-section__heading');
      if (!headingEl) {
        headingEl = doc.createElement('h2');
        headingEl.className = 'project-section__heading';
        sectionEl.insertBefore(headingEl, sectionEl.firstChild);
      }
      headingEl.contentEditable = 'true';
      headingEl.dataset.placeholder = 'Section heading';

      let bodyEl = sectionEl.querySelector('.project-section__body');
      if (!bodyEl) {
        bodyEl = doc.createElement('div');
        bodyEl.className = 'project-section__body';
        const firstImgCon = sectionEl.querySelector('.project-section-images');
        sectionEl.insertBefore(bodyEl, firstImgCon || null);
      }
      bodyEl.contentEditable = 'true';
      bodyEl.dataset.placeholder = 'Section body text';

      // Images
      const imgContainers = [...sectionEl.querySelectorAll('.project-section-images')];
      imgContainers.forEach(imgContainer => {
        [...imgContainer.querySelectorAll('img')].forEach(img => wrapImageForEdit(doc, img, sec.id));
        addImageButton(doc, imgContainer, sec.id);
        wireImgDropZone(imgContainer, sec.id, doc);
      });
      if (!imgContainers.length) {
        const imgCon = doc.createElement('div');
        imgCon.className = 'project-section-images';
        sectionEl.appendChild(imgCon);
        addImageButton(doc, imgCon, sec.id);
        wireImgDropZone(imgCon, sec.id, doc);
      }
    }
  });

  // Add-section buttons between and after sections
  rebuildAddSectionButtons(doc);

  // Debounced input → sync
  doc.addEventListener('input', e => {
    if (!e.target.isContentEditable) return;
    scheduleSync(doc);
  });
}

function wrapImageForEdit(doc, img, sectionId) {
  const wrap = doc.createElement('div');
  wrap.className = 'edit-img-wrap';
  wrap.draggable = true;

  const controls = doc.createElement('div');
  controls.className = 'edit-img-controls';
  const removeBtn = doc.createElement('button');
  removeBtn.className = 'edit-img-remove';
  removeBtn.title = 'Remove image';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    const src = img.getAttribute('src');
    for (const sec of (state.currentProject?.sections || [])) {
      const idx = sec.images.findIndex(i => i.src === src);
      if (idx !== -1) { sec.images.splice(idx, 1); break; }
    }
    wrap.remove();
    scheduleSync();
  });
  controls.appendChild(removeBtn);
  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(img);
  wrap.appendChild(controls);

  wrap.addEventListener('dragstart', e => {
    _dragImgSrc = img.getAttribute('src');
    _dragImgSection = sectionId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-img-drag', '1');
    requestAnimationFrame(() => wrap.classList.add('drag-source'));
  });
  wrap.addEventListener('dragend', () => {
    _dragImgSrc = null;
    _dragImgSection = null;
    wrap.classList.remove('drag-source');
  });
}

function addImageButton(doc, imgContainer, sectionId) {
  const btn = doc.createElement('button');
  btn.className = 'edit-add-img';
  btn.textContent = '+ Add image';
  imgContainer.appendChild(btn);
  btn.addEventListener('click', async () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/jpeg,image/png,image/gif,image/webp';
    inp.style.cssText = 'position:fixed;top:-200vh;left:-200vw;width:0;height:0;opacity:0;';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      const file = inp.files[0];
      inp.remove();
      if (!file) return;
      const fd = new FormData();
      fd.append('image', file);
      try {
        const res = await fetch(`/admin/upload/${encodeURIComponent(editSlug)}`, {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf() },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        const newImg = doc.createElement('img');
        newImg.src = data.path;
        newImg.alt = '';
        newImg.loading = 'lazy';
        imgContainer.insertBefore(newImg, btn);
        wrapImageForEdit(doc, newImg, sectionId);
        const filename = data.path.split('/').pop();
        state.uploadedFiles.push({
          filename,
          originalName: file.name,
          fileType: 'image',
          previewSrc: data.path,
          fromEditor: true,
          permanentPath: data.path,
          tag: '',
        });
        renderAllFiles();
        saveToStorage();
        scheduleSync(doc);
      } catch (err) {
        console.error('Image upload failed:', err.message);
      }
    });
    window.addEventListener('focus', () => setTimeout(() => inp.remove(), 300), { once: true });
    inp.click();
  });
}

function wireImgDropZone(imgContainer, sectionId, doc) {
  imgContainer.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-img-drag')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  imgContainer.addEventListener('drop', e => {
    if (!_dragImgSrc) return;
    e.preventDefault();
    const addBtn = imgContainer.querySelector('.edit-add-img');
    if (_dragImgSection !== sectionId) {
      const srcContainer = doc.querySelector(`main > .container[data-section-id="${_dragImgSection}"] .project-section-images .drag-source`);
      if (srcContainer) {
        imgContainer.insertBefore(srcContainer, addBtn || null);
        const sections = state.currentProject?.sections || [];
        const fromSec = sections.find(s => s.id === _dragImgSection);
        const toSec   = sections.find(s => s.id === sectionId);
        if (fromSec && toSec) {
          const idx = fromSec.images.findIndex(i => i.src === _dragImgSrc);
          if (idx !== -1) {
            const [imgData] = fromSec.images.splice(idx, 1);
            toSec.images.push(imgData);
          }
        }
      }
    } else {
      const draggedWrap = imgContainer.querySelector('.drag-source');
      const dropTarget  = e.target.closest?.('.edit-img-wrap');
      if (draggedWrap && dropTarget && dropTarget !== draggedWrap) {
        imgContainer.insertBefore(draggedWrap, dropTarget);
      }
    }
    scheduleSync(doc);
  });
}

function rebuildAddSectionButtons(doc) {
  doc.querySelectorAll('.edit-add-section').forEach(el => el.remove());
  const main = doc.querySelector('main');
  if (!main) return;
  const header = doc.querySelector('main > .container:not([data-section-id])');
  const sectionContainers = [...doc.querySelectorAll('main > .container[data-section-id]')];

  if (header) header.after(makeAddSectionBtn(doc, null));
  sectionContainers.forEach(container => {
    container.after(makeAddSectionBtn(doc, container.dataset.sectionId));
  });
}

function makeAddSectionBtn(doc, afterSectionId) {
  const wrap = doc.createElement('div');
  wrap.className = 'edit-add-section';
  const btn = doc.createElement('button');
  btn.className = 'edit-add-section-btn';
  btn.textContent = '+ Add section';
  wrap.appendChild(btn);
  btn.addEventListener('click', () => addSectionAfter(afterSectionId, doc));
  return wrap;
}

function addSectionAfter(prevSectionId, doc) {
  const newSec = { id: crypto.randomUUID(), heading: '', body: '', cols: 0, images: [] };
  const sections = state.currentProject?.sections;
  if (!sections) return;
  if (prevSectionId) {
    const idx = sections.findIndex(s => s.id === prevSectionId);
    sections.splice(idx !== -1 ? idx + 1 : sections.length, 0, newSec);
  } else {
    sections.unshift(newSec);
  }

  const newContainer = doc.createElement('div');
  newContainer.className = 'container edit-section-wrap';
  newContainer.dataset.sectionId = newSec.id;

  const bar = doc.createElement('div');
  bar.className = 'edit-section-bar';
  const dragHandle = doc.createElement('span');
  dragHandle.className = 'edit-section-drag';
  dragHandle.title = 'Drag to reorder';
  dragHandle.textContent = '⠿';
  dragHandle.draggable = true;
  const deleteBtn = doc.createElement('button');
  deleteBtn.className = 'edit-section-delete';
  deleteBtn.title = 'Delete section';
  deleteBtn.textContent = '✕';
  deleteBtn.addEventListener('click', () => deleteSection(newSec.id, doc));
  bar.appendChild(dragHandle);
  bar.appendChild(deleteBtn);

  const sectionEl = doc.createElement('section');
  sectionEl.className = 'project-section';

  const headingEl = doc.createElement('h2');
  headingEl.className = 'project-section__heading';
  headingEl.contentEditable = 'true';
  headingEl.dataset.placeholder = 'Section heading';

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'project-section__body';
  bodyEl.contentEditable = 'true';
  bodyEl.dataset.placeholder = 'Section body text';

  const imgCon = doc.createElement('div');
  imgCon.className = 'project-section-images';
  addImageButton(doc, imgCon, newSec.id);
  wireImgDropZone(imgCon, newSec.id, doc);

  sectionEl.appendChild(headingEl);
  sectionEl.appendChild(bodyEl);
  sectionEl.appendChild(imgCon);
  newContainer.appendChild(bar);
  newContainer.appendChild(sectionEl);

  if (prevSectionId) {
    const prevContainer = doc.querySelector(`main > .container[data-section-id="${prevSectionId}"]`);
    if (prevContainer) prevContainer.after(newContainer);
    else doc.querySelector('main').appendChild(newContainer);
  } else {
    const header = doc.querySelector('main > .container:not([data-section-id])');
    if (header) header.after(newContainer);
    else doc.querySelector('main').prepend(newContainer);
  }

  rebuildAddSectionButtons(doc);
  headingEl.focus();
  scheduleSync(doc);
}

function deleteSection(sectionId, doc) {
  const sections = state.currentProject?.sections;
  if (!sections) return;
  const idx = sections.findIndex(s => s.id === sectionId);
  if (idx !== -1) sections.splice(idx, 1);
  doc = doc || previewFrame.contentDocument;
  const container = doc?.querySelector(`main > .container[data-section-id="${sectionId}"]`);
  if (container) container.remove();
  if (doc) rebuildAddSectionButtons(doc);
  scheduleSync(doc);
}

function moveSectionInDOM(srcId, targetId, insertBefore, doc) {
  const srcContainer    = doc.querySelector(`main > .container[data-section-id="${srcId}"]`);
  const targetContainer = doc.querySelector(`main > .container[data-section-id="${targetId}"]`);
  if (!srcContainer || !targetContainer) return;
  const sections = state.currentProject?.sections || [];
  const srcIdx = sections.findIndex(s => s.id === srcId);
  const tgtIdx = sections.findIndex(s => s.id === targetId);
  if (srcIdx !== -1 && tgtIdx !== -1) {
    const [moved] = sections.splice(srcIdx, 1);
    const newTgt = sections.findIndex(s => s.id === targetId);
    sections.splice(insertBefore ? newTgt : newTgt + 1, 0, moved);
  }
  if (insertBefore) targetContainer.before(srcContainer);
  else targetContainer.after(srcContainer);
  rebuildAddSectionButtons(doc);
  scheduleSync(doc);
}

// ── Edit mode: save/publish/discard ──────────────────────────────────────────
async function saveDraftEdits() {
  syncFromDOM();
  setStatus(publishStatus, 'Saving draft…');
  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(editSlug)}/save-draft-edits`, {});
    setStatus(publishStatus, 'Draft saved.');
    setTimeout(() => setStatus(publishStatus, ''), 2500);
  } catch (err) {
    setStatus(publishStatus, err.message, true);
  }
}

async function publishEdits() {
  syncFromDOM();
  setStatus(publishStatus, 'Publishing…');
  publishBtn.disabled = true;
  draftBtn.disabled   = true;
  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(editSlug)}/publish-edits`, {});
    clearStorage();
    setStatus(publishStatus, 'Published! Redirecting…');
    setTimeout(() => { window.location.href = '/admin/dashboard?msg=Published!'; }, 900);
  } catch (err) {
    setStatus(publishStatus, err.message, true);
    publishBtn.disabled = false;
    draftBtn.disabled   = false;
  }
}

async function discardDraftEdits() {
  if (!confirm('Discard draft? The published project will be restored.')) return;
  try {
    await apiFetch(`/admin/projects/${encodeURIComponent(editSlug)}/discard-draft`, {});
    clearStorage();
    window.location.href = '/admin/dashboard';
  } catch (err) {
    setStatus(publishStatus, err.message, true);
  }
}

// ── Restore on load ───────────────────────────────────────────────────────────
// Skip localStorage restore in edit mode — project data comes from the DB via server session
if (studioMode !== 'edit') tryRestoreFromStorage();

if (studioMode === 'edit' && initialProject) {
  try {
    initEditMode(initialProject);
  } catch (e) {
    console.error('initEditMode failed:', e);
    const scope = document.getElementById('studio-preview-content');
    if (scope) {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'background:#fdd;color:#900;padding:12px;font:12px monospace;white-space:pre-wrap;border-bottom:1px solid #f88;';
      errEl.textContent = 'Edit mode init error:\n' + e.message + '\n' + (e.stack || '');
      scope.insertBefore(errEl, scope.firstChild);
      // Fallback: still make text editable even if full init failed
      activateEditing(scope);
    }
  }
}

function activateEditing(scope) {
  if (!scope) return;
  if (!scope.querySelector('.studio-edit-hint')) {
    const hint = document.createElement('div');
    hint.className = 'studio-edit-hint';
    hint.textContent = 'Click any text to edit';
    scope.insertBefore(hint, scope.firstChild);
  }
  [
    ['.project-title', 'Project title'],
    ['.project-subtitle', 'Project subtitle'],
  ].forEach(([sel, ph]) => {
    const el = scope.querySelector(sel);
    if (el) { el.contentEditable = 'true'; el.dataset.placeholder = ph; }
  });
  scope.querySelectorAll('.project-section').forEach(sec => {
    const h = sec.querySelector('.project-section__heading');
    const b = sec.querySelector('.project-section__body');
    if (h) { h.contentEditable = 'true'; h.dataset.placeholder = 'Section heading'; }
    if (b) { b.contentEditable = 'true'; b.dataset.placeholder = 'Section body'; }
  });
  if (!scope.dataset.editListening) {
    scope.dataset.editListening = '1';
    scope.addEventListener('input', scheduleSync);
  }
}
