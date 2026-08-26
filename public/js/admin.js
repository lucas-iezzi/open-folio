/* Admin Panel — admin.js */
(function () {
  'use strict';

  // ── Shared utilities ─────────────────────────────────────────────
  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  async function apiFetch(url, options = {}) {
    const headers = { 'X-CSRF-Token': getCsrfToken(), 'Accept': 'application/json', ...options.headers };
    const res = await fetch(url, { ...options, headers });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(typeof body === 'object' ? (body?.error || `Request failed (${res.status})`) : `Request failed (${res.status})`);
    return body;
  }

  // Reads an NDJSON (one JSON object per line) streaming response, calling onEvent for
  // each parsed line as it arrives — used for long-running operations (content sync) that
  // report progress while still in flight instead of only resolving at the very end.
  async function streamNdjson(url, body, onEvent) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken(), 'Accept': 'application/x-ndjson' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      let msg = `Request failed (${res.status})`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) { try { onEvent(JSON.parse(line)); } catch { /* skip malformed line */ } }
      }
    }
    if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* skip malformed line */ } }
  }

  function toSlug(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Init both contexts — each guards itself ───────────────────────
  initDashboard();
  initProjectForm();


  function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    try {
      return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
    } catch { return ''; }
  }

  // ════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ════════════════════════════════════════════════════════════════════
  function initDashboard() {
    initTabs();
    initProjectDrag();
    initDeleteButtons();
    initImportExport();
    initToggleVisibility();
    initActivityGeo();
  }

  function initActivityGeo() {
    const activityTab = document.querySelector('.admin-tab[data-tab="activity"]');
    if (!activityTab) return;
    let loaded = false;
    activityTab.addEventListener('click', () => {
      if (loaded) return;
      loaded = true;
      fetchGeoData();
    });
  }

  async function fetchGeoData() {
    const geoCells = document.querySelectorAll('.visit-geo[data-ip]');
    const ips = [...new Set([...geoCells].map(el => el.dataset.ip).filter(Boolean))];
    if (!ips.length) {
      geoCells.forEach(el => { el.textContent = '—'; });
      return;
    }
    try {
      const res  = await fetch('/admin/geo?ips=' + ips.map(encodeURIComponent).join(','));
      const data = await res.json();
      document.querySelectorAll('.visit-geo[data-ip]').forEach(el => {
        const geo = data[el.dataset.ip];
        if (!geo || (!geo.country && !geo.city)) {
          el.textContent = '—';
        } else {
          const flag = countryFlag(geo.country_code);
          el.textContent = [flag, geo.city, geo.country].filter(Boolean).join(' ');
        }
      });
    } catch {
      geoCells.forEach(el => { el.textContent = '—'; });
    }
  }

  // ── Tab switching ────────────────────────────────────────────────
  function initTabs() {
    const tabList = document.querySelector('.admin-tabs');
    if (!tabList) return;

    function activateTab(tabName) {
      const panelId = 'tab-' + tabName;
      tabList.querySelectorAll('.admin-tab').forEach(function (t) {
        const active = t.dataset.tab === tabName;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.admin-tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === panelId);
      });
    }

    tabList.addEventListener('click', function (e) {
      const tab = e.target.closest('.admin-tab');
      if (!tab) return;
      sessionStorage.setItem('adminTab', tab.dataset.tab);
      activateTab(tab.dataset.tab);
    });

    // Restore last active tab on page load
    const saved = sessionStorage.getItem('adminTab');
    if (saved && tabList.querySelector(`[data-tab="${saved}"]`)) {
      activateTab(saved);
    }
  }

  // ── Project list drag-to-reorder ─────────────────────────────────
  function initProjectDrag() {
    const listEl = document.getElementById('project-list');
    if (!listEl) return;

    let dragItem   = null;
    let dropTarget = null;
    let dropBefore = true;

    function clearIndicators() {
      listEl.querySelectorAll('.project-list-item').forEach(i => {
        i.classList.remove('drag-over-above', 'drag-over-below');
      });
    }

    listEl.querySelectorAll('.project-list-item').forEach(item => {
      const handle = item.querySelector('.drag-handle');
      if (!handle) return;
      handle.setAttribute('draggable', 'true');

      handle.addEventListener('dragstart', e => {
        dragItem = item;
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => item.classList.add('dragging'));
      });

      handle.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        clearIndicators();
        if (dropTarget && dropTarget !== item) {
          listEl.insertBefore(item, dropBefore ? dropTarget : dropTarget.nextSibling);
          saveProjectOrder(listEl);
        }
        dragItem = null;
        dropTarget = null;
      });

      item.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragItem || dragItem === item) return;
        clearIndicators();
        const mid = item.getBoundingClientRect().top + item.offsetHeight / 2;
        dropBefore = e.clientY < mid;
        dropTarget = item;
        item.classList.add(dropBefore ? 'drag-over-above' : 'drag-over-below');
      });

      item.addEventListener('dragleave', e => {
        if (!item.contains(e.relatedTarget))
          item.classList.remove('drag-over-above', 'drag-over-below');
      });

      item.addEventListener('drop', e => {
        e.preventDefault();
        clearIndicators();
      });
    });
  }

  async function saveProjectOrder(listEl) {
    const slugs = [...listEl.querySelectorAll('.project-list-item')].map(el => el.dataset.slug);
    try {
      await apiFetch('/admin/projects/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs }),
      });
    } catch (err) {
      console.warn('Reorder save failed:', err.message);
    }
  }

  // ── Delete buttons ───────────────────────────────────────────────
  function initDeleteButtons() {
    document.querySelectorAll('.delete-project-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug  = btn.dataset.slug;
        const title = btn.dataset.title;
        if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
        try {
          await apiFetch(`/admin/projects/${encodeURIComponent(slug)}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          btn.closest('.project-list-item')?.remove();
        } catch (err) {
          alert('Could not delete: ' + err.message);
        }
      });
    });
  }

  // ── Toggle project visibility ────────────────────────────────────
  function initToggleVisibility() {
    document.querySelectorAll('.toggle-visibility-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.slug;
        try {
          const data = await apiFetch(`/admin/projects/${encodeURIComponent(slug)}/toggle-visibility`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const visible = data.visible === 1;
          btn.dataset.visible = visible ? '1' : '0';
          btn.textContent = visible ? 'Hide' : 'Show';
          btn.title = visible ? 'Hide from site' : 'Show on site';
          btn.setAttribute('aria-label', (visible ? 'Hide ' : 'Show ') + slug);
          const item = btn.closest('.project-list-item');
          item?.classList.toggle('is-hidden', !visible);
        } catch (err) {
          alert('Could not update visibility: ' + err.message);
        }
      });
    });
  }

  // ── Import / Export ──────────────────────────────────────────────
  function initImportExport() {
    const importBtn    = document.getElementById('import-btn');
    const importStatus = document.getElementById('import-status');

    importBtn?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        setImportStatus('Reading…', '');
        try {
          const text = await file.text();
          let data = JSON.parse(text);
          if (!Array.isArray(data)) data = [data];
          setImportStatus(`Importing ${data.length} project(s)…`, '');
          const result = await apiFetch('/admin/projects/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          setImportStatus(
            `✓ ${result.created} created, ${result.updated} updated — reloading…`,
            'var(--success)'
          );
          setTimeout(() => location.reload(), 1400);
        } catch (err) {
          setImportStatus('Import failed: ' + err.message, 'var(--danger)');
        }
      });
      input.click();
    });

    function setImportStatus(msg, color) {
      if (!importStatus) return;
      importStatus.textContent = msg;
      importStatus.style.color = color || 'var(--muted)';
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // PROJECT FORM
  // ════════════════════════════════════════════════════════════════════
  function initProjectForm() {
    const form = document.getElementById('project-form');
    if (!form) return;

    const titleInput     = form.querySelector('[name="title"]');
    const slugInput      = form.querySelector('[name="slug"]');
    const isEditMode     = form.dataset.mode === 'edit';
    const projectSlug    = form.dataset.slug || '';
    const sectionsWrap   = document.getElementById('sections-list');
    const addSectionBtn  = document.getElementById('add-section-btn');
    const saveBtn        = document.getElementById('save-btn');
    const statusEl       = document.getElementById('form-status');
    const thumbInput     = document.getElementById('thumb-file-input');
    const thumbPreview   = document.getElementById('thumb-preview');
    const thumbPathInput = form.querySelector('[name="thumbnail"]');
    const thumbAltInput  = form.querySelector('[name="thumbnailAlt"]');

    let sections = [];
    const existingData = document.getElementById('existing-sections-data');
    if (existingData) {
      try { sections = JSON.parse(existingData.textContent); } catch { sections = []; }
    }

    // ── Slug auto-generation ────────────────────────────────────────
    if (!isEditMode && titleInput && slugInput) {
      let slugTouched = false;
      titleInput.addEventListener('input', () => {
        if (!slugTouched) slugInput.value = toSlug(titleInput.value);
      });
      slugInput.addEventListener('input', () => {
        slugTouched = true;
        const v = slugInput.value, cursor = slugInput.selectionStart;
        const clean = v.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (clean !== v) { slugInput.value = clean; slugInput.setSelectionRange(cursor - 1, cursor - 1); }
      });
      slugInput.addEventListener('blur', () => { slugInput.value = toSlug(slugInput.value); });
    }

    // ── Thumbnail upload ────────────────────────────────────────────
    if (thumbInput) {
      thumbInput.addEventListener('change', async () => {
        const file = thumbInput.files[0];
        if (!file) return;
        const slug = isEditMode ? projectSlug : (slugInput?.value || 'temp');
        if (!slug) { alert('Please set the project slug before uploading images.'); thumbInput.value = ''; return; }
        setStatus('Uploading thumbnail…', 'saving');
        try {
          const data = await uploadFile(file, slug);
          thumbPathInput.value = data.path;
          if (thumbPreview) {
            thumbPreview.src = data.path;
            thumbPreview.style.display = 'block';
            if (thumbPreview.previousElementSibling)
              thumbPreview.previousElementSibling.style.display = 'none';
          }
          setStatus('Thumbnail uploaded.', 'ok');
        } catch (err) { setStatus('Upload failed: ' + err.message, 'error'); }
        thumbInput.value = '';
      });
    }

    // ── Upload helper ───────────────────────────────────────────────
    async function uploadFile(file, slug) {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch(`/admin/upload/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      return json;
    }

    // ── Render sections ─────────────────────────────────────────────
    function renderSections() {
      sectionsWrap.innerHTML = '';
      sections.forEach((sec, idx) => sectionsWrap.appendChild(buildSectionCard(sec, idx)));
      updateSectionLabels();
    }

    function updateSectionLabels() {
      sectionsWrap.querySelectorAll('.section-card-label').forEach((el, i) => {
        el.textContent = `Section ${i + 1}`;
      });
    }

    function getSectionIndex(card) {
      return sections.findIndex(s => s.id === card.dataset.id);
    }

    function buildSectionCard(sec, idx) {
      const card = document.createElement('div');
      card.className = 'section-card';
      card.dataset.id = sec.id;

      card.innerHTML = `
        <div class="section-card-header" aria-label="Drag to reorder section">
          <span class="section-drag-handle" draggable="true" aria-hidden="true">⠿</span>
          <span class="section-card-label">Section ${idx + 1}</span>
          <button type="button" class="btn btn-ghost btn-sm section-delete-btn" aria-label="Delete section">✕</button>
        </div>
        <div class="section-card-body">
          <div class="field">
            <label>Section heading <span class="label-hint">optional</span></label>
            <input type="text" class="sec-heading" value="${esc(sec.heading)}" placeholder="e.g. Project Overview">
          </div>
          <div class="field">
            <label>Body text</label>
            <textarea class="sec-body" rows="5" placeholder="Describe this section…">${esc(sec.body)}</textarea>
          </div>
          <div class="field">
            <label>Images</label>
            <div class="sec-cols-row">
              <label class="sec-cols-label" for="sec-cols-${esc(sec.id)}">Columns per row</label>
              <input
                type="number"
                id="sec-cols-${esc(sec.id)}"
                class="sec-cols"
                value="${sec.cols || 0}"
                min="0"
                max="20"
                aria-label="Images per row (0 = all in one row)"
              >
              <span class="sec-cols-hint">0 = all in one row</span>
            </div>
            <div class="section-images">
              ${sec.images.map(img => buildImageThumb(img.src, img.alt)).join('')}
              <button type="button" class="section-image-upload-btn" aria-label="Add image">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
                Add image
              </button>
            </div>
            <input type="file" class="sec-img-file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none" aria-hidden="true">
          </div>
        </div>`;

      card.querySelector('.sec-heading').addEventListener('input', e => {
        sections[getSectionIndex(card)].heading = e.target.value;
      });
      card.querySelector('.sec-body').addEventListener('input', e => {
        sections[getSectionIndex(card)].body = e.target.value;
      });
      card.querySelector('.sec-cols').addEventListener('input', e => {
        sections[getSectionIndex(card)].cols = Math.max(0, parseInt(e.target.value, 10) || 0);
      });

      card.querySelector('.section-delete-btn').addEventListener('click', () => {
        if (sections.length === 1 || confirm('Delete this section?')) {
          sections.splice(getSectionIndex(card), 1);
          renderSections();
        }
      });

      // Image upload
      const uploadBtn = card.querySelector('.section-image-upload-btn');
      const fileInput = card.querySelector('.sec-img-file');
      uploadBtn.addEventListener('click', () => {
        const slug = isEditMode ? projectSlug : (slugInput?.value || 'temp');
        if (!slug) { alert('Please set the project slug before uploading images.'); return; }
        fileInput.click();
      });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const slug = isEditMode ? projectSlug : (slugInput?.value || 'temp');
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = `<span class="upload-spinner" style="display:block"></span>`;
        setStatus('Uploading image…', 'saving');
        try {
          const data = await uploadFile(file, slug);
          const secIdx = getSectionIndex(card);
          sections[secIdx].images.push({ src: data.path, alt: '' });
          const thumb = document.createElement('div');
          thumb.innerHTML = buildImageThumb(data.path, '');
          const thumbEl = thumb.firstElementChild;
          card.querySelector('.section-images').insertBefore(thumbEl, uploadBtn);
          wireRemoveBtn(thumbEl, data.path);
          setStatus('Image uploaded.', 'ok');
        } catch (err) { setStatus('Upload failed: ' + err.message, 'error'); }
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg> Add image`;
        fileInput.value = '';
      });

      // Wire remove buttons on existing images
      card.querySelectorAll('.section-image-thumb').forEach(el => wireRemoveBtn(el, el.dataset.src));

      // Section drag
      setupSectionDrag(card);
      return card;
    }

    function buildImageThumb(src, alt) {
      return `<div class="section-image-thumb" data-src="${esc(src)}">
        <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">
        <button type="button" class="section-image-remove" title="Remove image" aria-label="Remove image">✕</button>
      </div>`;
    }

    function wireRemoveBtn(thumbEl, src) {
      const btn = thumbEl.querySelector('.section-image-remove');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this image?')) return;
        const card = thumbEl.closest('.section-card');
        const i = getSectionIndex(card);
        if (i !== -1) sections[i].images = sections[i].images.filter(img => img.src !== src);
        thumbEl.remove();
        try {
          await apiFetch('/admin/image/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imagePath: src }),
          });
        } catch { /* file may already be gone */ }
      });
    }

    // ── Section drag-to-reorder ─────────────────────────────────────
    let dragSrcCard = null;
    let sectionDropTarget = null;
    let sectionDropBefore = true;

    function setupSectionDrag(card) {
      const handle = card.querySelector('.section-drag-handle');
      if (!handle) return;

      handle.addEventListener('dragstart', e => {
        dragSrcCard = card;
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => card.classList.add('section-dragging'));
      });

      handle.addEventListener('dragend', () => {
        card.classList.remove('section-dragging');
        clearSectionIndicators();
        if (sectionDropTarget && sectionDropTarget !== card) {
          const fromIdx = getSectionIndex(card);
          const toIdx   = getSectionIndex(sectionDropTarget);
          if (fromIdx !== -1 && toIdx !== -1) {
            const [moved] = sections.splice(fromIdx, 1);
            const insertIdx = sectionDropBefore
              ? (toIdx > fromIdx ? toIdx - 1 : toIdx)
              : (toIdx > fromIdx ? toIdx : toIdx + 1);
            sections.splice(Math.max(0, insertIdx), 0, moved);
            renderSections();
          }
        }
        dragSrcCard = null;
        sectionDropTarget = null;
      });

      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragSrcCard || dragSrcCard === card) return;
        clearSectionIndicators();
        const mid = card.getBoundingClientRect().top + card.offsetHeight / 2;
        sectionDropBefore = e.clientY < mid;
        sectionDropTarget = card;
        card.classList.add(sectionDropBefore ? 'section-drag-over-above' : 'section-drag-over-below');
      });

      card.addEventListener('dragleave', e => {
        if (!card.contains(e.relatedTarget))
          card.classList.remove('section-drag-over-above', 'section-drag-over-below');
      });

      card.addEventListener('drop', e => {
        e.preventDefault();
        clearSectionIndicators();
      });
    }

    function clearSectionIndicators() {
      sectionsWrap.querySelectorAll('.section-card').forEach(c => {
        c.classList.remove('section-drag-over-above', 'section-drag-over-below', 'section-drag-over');
      });
    }

    // ── Add section ─────────────────────────────────────────────────
    addSectionBtn?.addEventListener('click', () => {
      sections.push({ id: crypto.randomUUID(), heading: '', body: '', cols: 0, images: [] });
      renderSections();
      sectionsWrap.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      sectionsWrap.lastElementChild?.querySelector('input')?.focus();
    });

    renderSections();

    // ── Save ────────────────────────────────────────────────────────
    saveBtn?.addEventListener('click', async () => {
      const title      = titleInput?.value.trim() || '';
      const subtitle   = form.querySelector('[name="subtitle"]')?.value.trim() || '';
      const slug       = slugInput?.value.trim() || projectSlug;
      const thumbnail  = thumbPathInput?.value || '';
      const thumbnailAlt = thumbAltInput?.value.trim() || title;

      if (!title) { setStatus('Please enter a title.', 'error'); return; }
      if (!slug)  { setStatus('Please set a slug.', 'error'); return; }

      saveBtn.disabled = true;
      setStatus('Saving…', 'saving');

      // Sync textarea values into sections array before serialising
      sectionsWrap.querySelectorAll('.section-card').forEach(card => {
        const sec = sections.find(s => s.id === card.dataset.id);
        if (sec) {
          sec.heading = card.querySelector('.sec-heading')?.value || '';
          sec.body    = card.querySelector('.sec-body')?.value    || '';
          sec.cols    = Math.max(0, parseInt(card.querySelector('.sec-cols')?.value || '0', 10) || 0);
        }
      });

      const payload = { title, subtitle, slug, thumbnail, thumbnailAlt, sectionsJson: JSON.stringify(sections), _csrf: getCsrfToken() };
      const url = isEditMode ? `/admin/projects/${encodeURIComponent(projectSlug)}/update` : '/admin/projects';

      try {
        const data = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.ok) {
          setStatus('Saved!', 'ok');
          setTimeout(() => {
            window.location.href = '/admin/dashboard?msg=' +
              encodeURIComponent(isEditMode ? 'Project updated.' : 'Project created.');
          }, 700);
        }
      } catch (err) {
        setStatus('Error: ' + err.message, 'error');
        saveBtn.disabled = false;
      }
    });

    function setStatus(msg, type) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = type === 'error' ? 'var(--danger)' : type === 'ok' ? 'var(--success)' : 'var(--muted)';
    }
  }

  // ── Settings: site identity (name + tagline) ─────────────────────────────
  const siteIdentityForm = document.getElementById('site-identity-form');
  if (siteIdentityForm) {
    siteIdentityForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const feedback = document.getElementById('site-identity-feedback');
      const btn = siteIdentityForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      feedback.textContent = 'Saving…';
      feedback.style.color = 'var(--muted)';
      try {
        await apiFetch('/admin/settings/site-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            siteName:    document.getElementById('site-name-input').value,
            siteTagline: document.getElementById('site-tagline-input').value,
          }),
        });
        feedback.textContent = 'Saved.';
        feedback.style.color = 'var(--success, green)';
      } catch (err) {
        feedback.textContent = err.message;
        feedback.style.color = 'var(--danger, red)';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── Settings: logo upload / delete ───────────────────────────────────────
  document.querySelectorAll('.logo-file-input').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const type = input.dataset.type;
      const feedback = document.querySelector(`.logo-upload-feedback[data-type="${type}"]`);
      if (!feedback) return;
      feedback.textContent = 'Uploading…';
      feedback.style.color = 'var(--muted)';

      const fd = new FormData();
      fd.append('image', file);
      fd.append('type', type);

      try {
        const res = await fetch('/admin/settings/logo', {
          method: 'POST',
          headers: { 'X-CSRF-Token': getCsrfToken() },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        feedback.textContent = 'Saved — reloading…';
        feedback.style.color = 'var(--success, green)';
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        console.error('[logo upload]', err);
        feedback.textContent = err.message;
        feedback.style.color = 'var(--danger, red)';
        input.value = '';
      }
    });
  });

  document.querySelectorAll('.logo-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const feedback = document.querySelector(`.logo-upload-feedback[data-type="${type}"]`);
      if (!feedback) return;
      btn.disabled = true;
      feedback.textContent = 'Removing…';
      feedback.style.color = 'var(--muted)';
      try {
        await apiFetch(`/admin/settings/logo/${type}`, { method: 'DELETE' });
        feedback.textContent = 'Removed — reloading…';
        feedback.style.color = 'var(--success, green)';
        setTimeout(() => location.reload(), 700);
      } catch (err) {
        console.error('[logo delete]', err);
        feedback.textContent = err.message;
        feedback.style.color = 'var(--danger, red)';
        btn.disabled = false;
      }
    });
  });

  // ── Settings: nav logo size slider ───────────────────────────────────────
  const logoSizeSlider = document.getElementById('logo-size-slider');
  if (logoSizeSlider) {
    const sizeValue    = document.getElementById('logo-size-value');
    const sizeFeedback = document.getElementById('logo-size-feedback');

    // Logarithmic mapping: slider 0→50→100 corresponds to 26px→52px→104px.
    // 52 lands exactly at center because 52 = 26 × 2^(50/50).
    function sliderToPx(v)  { return Math.round(26 * Math.pow(2, v / 50)); }
    function pxToSlider(px) { return Math.round(50 * Math.log2(px / 26)); }

    const initial = parseInt(logoSizeSlider.dataset.size) || 52;
    logoSizeSlider.value  = pxToSlider(initial);
    sizeValue.textContent = initial + 'px';

    let saveTimer;
    logoSizeSlider.addEventListener('input', () => {
      const px = sliderToPx(parseInt(logoSizeSlider.value));
      sizeValue.textContent = px + 'px';
      document.documentElement.style.setProperty('--logo-nav-size', px + 'px');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await apiFetch('/admin/settings/logo-size', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size: px }),
          });
          sizeFeedback.textContent = 'Saved.';
          sizeFeedback.style.color = 'var(--success, #2d8a4e)';
          setTimeout(() => { sizeFeedback.textContent = ''; }, 2000);
        } catch (err) {
          sizeFeedback.textContent = err.message;
          sizeFeedback.style.color = 'var(--danger, #c0392b)';
        }
      }, 500);
    });
  }

  // ── Settings: admin password change ──────────────────────────────────────
  const adminPwForm = document.getElementById('admin-password-form');
  if (adminPwForm) {
    adminPwForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const current  = document.getElementById('admin-pw-current').value;
      const newPw    = document.getElementById('admin-pw-new').value;
      const confirm  = document.getElementById('admin-pw-confirm').value;
      const feedback = document.getElementById('admin-password-feedback');
      const btn      = adminPwForm.querySelector('button[type="submit"]');

      feedback.textContent = '';

      if (newPw.length < 10) {
        feedback.textContent = 'New password must be at least 10 characters.';
        feedback.style.color = 'var(--danger, #c0392b)';
        return;
      }
      if (newPw !== confirm) {
        feedback.textContent = 'Passwords do not match.';
        feedback.style.color = 'var(--danger, #c0392b)';
        return;
      }

      btn.disabled = true;
      feedback.textContent = 'Saving…';
      feedback.style.color = 'var(--muted)';

      try {
        await apiFetch('/admin/settings/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current, newPassword: newPw }),
        });
        feedback.textContent = 'Password updated.';
        feedback.style.color = 'var(--success, #2d8a4e)';
        adminPwForm.reset();
      } catch (err) {
        feedback.textContent = err.message;
        feedback.style.color = 'var(--danger, #c0392b)';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── Settings: open the start/stop/restart terminal in a new window ─────────
  const launchTerminalBtn = document.getElementById('launch-terminal-btn');
  if (launchTerminalBtn) {
    launchTerminalBtn.addEventListener('click', async () => {
      const feedback = document.getElementById('launch-terminal-feedback');
      launchTerminalBtn.disabled = true;
      if (feedback) { feedback.textContent = 'Opening…'; feedback.style.color = 'var(--muted)'; }
      try {
        await apiFetch('/admin/local/launch-terminal', { method: 'POST' });
        if (feedback) { feedback.textContent = 'Opened in a new window.'; feedback.style.color = 'var(--success, #2d8a4e)'; }
      } catch (err) {
        if (feedback) { feedback.textContent = err.message; feedback.style.color = 'var(--danger, #c0392b)'; }
      } finally {
        launchTerminalBtn.disabled = false;
      }
    });
  }

  // ── Settings: provider key forms ──────────────────────────────────────────
  document.querySelectorAll('.provider-key-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key      = form.dataset.key;
      const input    = form.querySelector('input');
      const feedback = form.nextElementSibling;
      const btn      = form.querySelector('button[type="submit"]');
      const value    = input.value.trim();

      if (!value) return;

      btn.disabled = true;
      feedback.textContent = '';
      feedback.className   = 'settings-key-feedback';

      try {
        await apiFetch('/admin/settings/api-key', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ key, value, activate: true }),
        });
        feedback.textContent = 'Saved — reloading…';
        feedback.className   = 'settings-key-feedback is-success';
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        feedback.textContent = err.message;
        feedback.className   = 'settings-key-feedback is-error';
        btn.disabled = false;
      }
    });
  });

  // ── Settings: switch active provider ──────────────────────────────────────
  document.querySelectorAll('.provider-switch-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.provider;
      btn.disabled = true;
      btn.textContent = 'Switching…';
      const feedback = btn.previousElementSibling;
      try {
        await apiFetch('/admin/settings/api-key', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ key: 'AI_PROVIDER', value: pid }),
        });
        feedback.textContent = 'Switched — reloading…';
        feedback.className   = 'settings-key-feedback is-success';
        setTimeout(() => location.reload(), 700);
      } catch (err) {
        feedback.textContent = err.message;
        feedback.className   = 'settings-key-feedback is-error';
        btn.disabled = false;
        btn.textContent = 'Switch to this provider';
      }
    });
  });

  // -- Remote Server tab -------------------------------------------------------
  (function initRemoteServer() {
    if (!document.getElementById('rs-creds-card')) return;

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // showLog: ok=null→running, ok=true→success, ok=false→error
    function showLog(logEl, ok, text, stdout) {
      if (!logEl) return;
      logEl.className = 'rs-log rs-log--' + (ok === null ? 'running' : ok ? 'ok' : 'err');
      logEl.style.display = 'block';
      if (ok === null) {
        logEl.textContent = text;
        return;
      }
      const icon = ok ? '✓' : '✗';
      if (stdout && stdout.trim()) {
        // Auto-open on failure so the error is immediately visible
        const open = ok ? '' : ' open';
        logEl.innerHTML = `<span>${icon} ${escHtml(text)}</span><details${open} style="margin-top:.35rem"><summary class="rs-log-summary">${ok ? 'Show output' : 'Error output'}</summary><pre class="rs-log-pre">${escHtml(stdout.trim())}</pre></details>`;
      } else {
        logEl.textContent = `${icon} ${text}`;
      }
    }

    const rsConnDot  = document.getElementById('rs-conn-dot');
    const rsConnHost = document.getElementById('rs-conn-host-label');
    const rsCredsFB  = document.getElementById('rs-creds-feedback');
    const rsSshCmd   = document.getElementById('rs-ssh-cmd');
    const logSync    = document.getElementById('rs-log-sync');
    const logCmds    = document.getElementById('rs-log-cmds');
    const logSetup   = document.getElementById('rs-log-setup');

    function getCredsFromForm() {
      return {
        host:       document.getElementById('rs-host').value.trim(),
        user:       document.getElementById('rs-user').value.trim(),
        sshPort:    parseInt(document.getElementById('rs-port').value) || 22,
        remotePath: document.getElementById('rs-rpath').value.trim(),
      };
    }

    function updateSshCmd(cfg) {
      if (!rsSshCmd) return;
      if (!cfg.host || !cfg.user) { rsSshCmd.textContent = '(save credentials first)'; return; }
      const portArg = cfg.sshPort && cfg.sshPort !== 22 ? ` -p ${cfg.sshPort}` : '';
      rsSshCmd.textContent = `ssh${portArg} ${cfg.user}@${cfg.host}`;
    }

    updateSshCmd(getCredsFromForm());

    const knownHostWrap = document.getElementById('rs-knownhost-wrap');
    const clearKnownHostBtn = document.getElementById('rs-clear-knownhost');

    async function testConnection(silent) {
      if (!silent) {
        rsCredsFB.textContent = 'Testing connection…';
        rsCredsFB.style.color = 'var(--muted)';
      }
      if (rsConnDot) rsConnDot.className = 'rs-conn-dot rs-conn-dot--unknown';
      if (knownHostWrap) knownHostWrap.style.display = 'none';
      try {
        const r = await apiFetch('/admin/deploy/test', { method: 'POST' });
        if (!r.ok) {
          const raw = r.stderr || r.err || '';
          const isKeyChanged = raw.includes('IDENTIFICATION HAS CHANGED') || raw.includes('Offending');
          if (isKeyChanged && knownHostWrap) knownHostWrap.style.display = '';
          const msg = isKeyChanged
            ? 'Server host key has changed — click "Clear saved host key & retry" below'
            : raw.includes('Permission denied')
              ? 'SSH key not authorized — add your public key to the server (see SSH Key Setup below)'
              : raw.includes('Connection refused')
                ? 'Connection refused — check host and port'
                : raw || 'SSH connection failed';
          throw new Error(msg);
        }
        if (!silent) {
          rsCredsFB.textContent = 'Connected.';
          rsCredsFB.style.color = 'var(--success, #2d8a4e)';
          setTimeout(() => { rsCredsFB.textContent = ''; }, 2500);
        }
        if (rsConnDot) rsConnDot.className = 'rs-conn-dot rs-conn-dot--ok';
      } catch (err) {
        if (!silent) {
          rsCredsFB.textContent = err.message;
          rsCredsFB.style.color = 'var(--danger, #c0392b)';
        }
        if (rsConnDot) rsConnDot.className = 'rs-conn-dot rs-conn-dot--err';
      }
    }

    if (clearKnownHostBtn) {
      clearKnownHostBtn.addEventListener('click', async () => {
        clearKnownHostBtn.disabled = true;
        clearKnownHostBtn.textContent = 'Clearing…';
        try {
          await apiFetch('/admin/deploy/clear-known-host', { method: 'POST' });
        } catch {}
        clearKnownHostBtn.textContent = 'Clear saved host key & retry';
        clearKnownHostBtn.disabled = false;
        if (knownHostWrap) knownHostWrap.style.display = 'none';
        await testConnection(false);
      });
    }

    // Auto-test on load if credentials are configured; collapse creds card on success
    const cfg0 = getCredsFromForm();
    if (cfg0.host && cfg0.user) {
      testConnection(true).then(() => {
        const credsCard = document.getElementById('rs-creds-card');
        if (credsCard && rsConnDot && rsConnDot.classList.contains('rs-conn-dot--ok')) {
          credsCard.open = false;
        }
      });
    }

    // Save then immediately test connection
    const rsSaveBtn = document.getElementById('rs-save-creds');
    if (rsSaveBtn) {
      rsSaveBtn.addEventListener('click', async () => {
        const cfg = getCredsFromForm();
        rsSaveBtn.disabled = true;
        rsCredsFB.textContent = 'Saving…';
        rsCredsFB.style.color = 'var(--muted)';
        try {
          await apiFetch('/admin/deploy/config', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(cfg),
          });
          if (rsConnHost) rsConnHost.textContent = cfg.host || 'Not configured';
          updateSshCmd(cfg);
          await testConnection(false);
          loadSetupProgress(); // credentials may now point at a different (or freshly reset) server
        } catch (err) {
          rsCredsFB.textContent = err.message;
          rsCredsFB.style.color = 'var(--danger, #c0392b)';
        } finally {
          rsSaveBtn.disabled = false;
        }
      });
    }

    // ── Carousel ──
    const stepPanels    = Array.from(document.querySelectorAll('.rs-step-panel'));
    const stepDots      = Array.from(document.querySelectorAll('.rs-dot'));
    const prevBtn       = document.getElementById('rs-prev-step');
    const nextBtn       = document.getElementById('rs-next-step');
    const carouselRun   = document.getElementById('rs-carousel-run');
    const manualDoneNav = document.getElementById('rs-manual-done-nav');
    const stepStatus    = document.getElementById('rs-step-status');
    let currentStep     = 0;

    // Grays out step navigation while a command is running, so a stray click can't
    // fire off a second SSH command on top of one still in flight.
    function setNavDisabled(disabled) {
      if (disabled) {
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
      } else {
        if (prevBtn) prevBtn.disabled = currentStep === 0;
        if (nextBtn) nextBtn.disabled = currentStep === stepPanels.length - 1;
      }
      stepDots.forEach((dot) => { dot.disabled = disabled; });
    }

    // Rough expected durations for the slower setup commands, in ms — used only to
    // shape the simulated progress curve below, not a real measurement. SSH commands
    // give no actual progress signal, so this is a UX approximation: ramps up quickly,
    // then eases off and holds under 100% until the request actually resolves.
    const RS_STEP_ESTIMATES = {
      apt_update:     25000,
      node_install:   20000,
      caddy_install:  20000,
      npm_install:    15000,
      pm2_install:     8000,
      server_setup:    8000,
      git_clone:       6000,
      pm2_start:       6000,
      caddy_configure: 5000,
      ufw_setup:       4000,
    };
    // Shared show/set/hide primitives for the step-progress bar — used both by the
    // simulated curve below (opaque SSH commands give no real signal) and by the
    // "Push content" step, which drives this with genuine per-file progress instead.
    function showStepProgressUI() {
      const wrap = document.getElementById('rs-step-progress');
      if (!wrap) return;
      if (stepStatus) stepStatus.style.display = 'none';
      wrap.style.display = 'flex';
    }
    function setStepProgressPct(pct) {
      const fill = document.getElementById('rs-step-progress-fill');
      const time = document.getElementById('rs-step-progress-time');
      if (fill) fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
      if (time) time.textContent = Math.round(pct) + '%';
    }
    function hideStepProgressUI(success) {
      const wrap = document.getElementById('rs-step-progress');
      if (!wrap) return;
      const restore = () => {
        wrap.style.display = 'none';
        if (stepStatus) stepStatus.style.display = '';
      };
      if (success) { setStepProgressPct(100); setTimeout(restore, 220); }
      else restore();
    }

    let rsProgressTimer = null;

    function startStepProgress(command) {
      showStepProgressUI();
      setStepProgressPct(0);

      const estimate = RS_STEP_ESTIMATES[command] || 6000;
      const tau   = estimate / 2.5;
      const cap   = 92; // never claim "done" until the request actually resolves
      const start = Date.now();

      rsProgressTimer = setInterval(() => {
        const elapsed = Date.now() - start;
        setStepProgressPct(cap * (1 - Math.exp(-elapsed / tau)));
      }, 200);
    }

    function stopStepProgress(success) {
      if (rsProgressTimer) { clearInterval(rsProgressTimer); rsProgressTimer = null; }
      hideStepProgressUI(success);
    }

    function goToStep(n) {
      if (n < 0 || n >= stepPanels.length) return;
      stepPanels[currentStep].classList.remove('active');
      if (stepDots[currentStep]) stepDots[currentStep].classList.remove('rs-dot--active');
      currentStep = n;
      stepPanels[currentStep].classList.add('active');
      if (stepDots[currentStep]) stepDots[currentStep].classList.add('rs-dot--active');
      if (prevBtn) prevBtn.disabled = currentStep === 0;
      if (nextBtn) nextBtn.disabled = currentStep === stepPanels.length - 1;
      const cmd      = stepPanels[currentStep].dataset.cmd;
      const isManual = stepPanels[currentStep].dataset.manual === 'true';
      if (carouselRun) {
        carouselRun.style.display = cmd ? '' : 'none';
        if (cmd) {
          carouselRun.dataset.cmd            = cmd;
          carouselRun.dataset.needsDomain    = stepPanels[currentStep].dataset.needsDomain    || 'false';
          carouselRun.dataset.needsPassword  = stepPanels[currentStep].dataset.needsPassword  || 'false';
          carouselRun.dataset.needsAdminPath = stepPanels[currentStep].dataset.needsAdminPath || 'false';
          carouselRun.textContent = stepPanels[currentStep].dataset.runLabel || 'Run on server';
        }
      }
      if (manualDoneNav) manualDoneNav.style.display = isManual ? '' : 'none';
      if (stepStatus) stepStatus.textContent = '';
      if (logSetup) logSetup.style.display = 'none';
      updateRunButtonState();
    }

    // Which steps are done lives on the remote server itself (a small JSON file next to
    // the app), not in the browser — localStorage kept showing every step as "done" even
    // after the actual server was wiped and rebuilt, since nothing tied that state to a
    // specific server instance. A fresh/reset server simply won't have the file yet.
    let doneSteps = new Set();
    function updateSetupCompleteBadge() {
      const badge = document.getElementById('rs-setup-complete-badge');
      if (!badge) return;
      const allDone = stepPanels.length > 0 && stepPanels.every((_, i) => doneSteps.has(i));
      badge.style.display = allDone ? '' : 'none';
    }
    function paintDoneSteps() {
      stepDots.forEach((dot, i) => dot.classList.toggle('rs-dot--done', doneSteps.has(i)));
      updateSetupCompleteBadge();
      updateRunButtonState();
    }
    // Once a step's command has succeeded (or a manual step is marked done), its own
    // run/done button stays disabled — only Prev/Next navigation can move off of it —
    // so a stray click can't accidentally re-run a step that already succeeded.
    function updateRunButtonState() {
      const panel = stepPanels[currentStep];
      if (!panel) return;
      const isDone = doneSteps.has(currentStep);
      if (carouselRun   && panel.dataset.cmd)               carouselRun.disabled   = isDone;
      if (manualDoneNav && panel.dataset.manual === 'true') manualDoneNav.disabled = isDone;
    }
    function markStepDone(index) {
      doneSteps.add(index);
      paintDoneSteps();
      // Best-effort — if this fails (server unreachable right now), the dot still shows
      // done for this page view, and the next load will just resync from the server.
      apiFetch('/admin/deploy/mark-setup-step', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step: index }),
      }).catch(() => {});
    }
    async function loadSetupProgress() {
      try {
        const r = await apiFetch('/admin/deploy/setup-progress', { method: 'POST' });
        if (r.ok && Array.isArray(r.steps)) {
          doneSteps = new Set(r.steps);
          paintDoneSteps();
        }
      } catch { /* server not configured yet, or unreachable right now */ }
    }
    loadSetupProgress();

    if (manualDoneNav) manualDoneNav.addEventListener('click', () => {
      markStepDone(currentStep);
      if (stepStatus) { stepStatus.textContent = '✓ Marked done'; stepStatus.style.color = 'var(--success,#2d8a4e)'; }
    });

    if (prevBtn) prevBtn.addEventListener('click', () => goToStep(currentStep - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => goToStep(currentStep + 1));
    stepDots.forEach((dot, i) => dot.addEventListener('click', () => goToStep(i)));

    goToStep(0); // initialise button visibility for the starting step

    // The final setup step: pushes everything (db + all images) to a fresh server.
    // Unlike the SSH-command steps above, this reuses the same streaming sync-item
    // machinery as the Content Sync tool, so its progress bar shows real per-file
    // completion instead of the simulated curve those opaque shell commands get.
    async function runInitialContentPush() {
      // forcePerFile on the image items so a fresh/empty server (the common case here)
      // doesn't take the one-shot bulk-copy path — the wizard needs a progress event per
      // image (and, since paths are "slug/filename", per project too) not one lump transfer.
      // Images push BEFORE the database — pushing the DB first would leave the server's
      // copy referencing images that haven't landed yet if a transfer is slow or fails.
      const items = [
        { id: 'images/projects', label: 'Project images', forcePerFile: true },
        { id: 'images/logos',    label: 'Logo images',    forcePerFile: true },
        { id: 'db',              label: 'Database'       },
      ];
      if (logSetup) { logSetup.style.display = 'block'; logSetup.className = 'rs-log rs-log--running'; logSetup.textContent = ''; }
      showStepProgressUI();
      setStepProgressPct(0);

      const checklist = [];
      function render(liveLine) {
        const text = checklist.concat(liveLine ? [liveLine] : []).join('\n');
        showLog(logSetup, null, text || 'Starting…');
      }

      const total = items.length;
      let allOk = true;
      let imagesOk = true;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.id === 'db' && !imagesOk) {
          // Images didn't fully land — pushing the database now would point the server
          // at files it doesn't have yet. Leave it for a rerun once images succeed.
          checklist.push(`⏭ ${item.label} (skipped — images didn't finish syncing)`);
          allOk = false;
          render();
          continue;
        }
        const r = await syncItemWithProgress(item.id, item.label, 'push', render, (frac) => {
          setStepProgressPct(((i + frac) / total) * 100);
        }, item.forcePerFile);
        checklist.push(`${r.ok ? '✓' : '✗'} ${item.label}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ''}`);
        if (!r.ok) { allOk = false; if (item.id !== 'db') imagesOk = false; }
        render();
      }

      render('↺ Restarting server…');
      let restartOk = true;
      try {
        const rr = await apiFetch('/admin/deploy/ssh-run', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ command: 'restart' }),
        });
        restartOk = rr.ok !== false;
      } catch {
        restartOk = false;
      }
      allOk = allOk && restartOk;

      hideStepProgressUI(allOk);
      if (stepStatus) { stepStatus.textContent = allOk ? '✓ Done' : '✗ Failed'; stepStatus.style.color = allOk ? 'var(--success,#2d8a4e)' : 'var(--danger,#c0392b)'; }
      if (allOk && stepDots[currentStep]) markStepDone(currentStep);
      showLog(logSetup, allOk, `Push content: ${allOk ? 'complete' : 'finished with errors'}`, checklist.join('\n'));
    }

    if (carouselRun) {
      carouselRun.addEventListener('click', async () => {
        const command        = carouselRun.dataset.cmd;

        if (command === 'push_content') {
          carouselRun.disabled = true;
          setNavDisabled(true);
          try {
            await runInitialContentPush();
          } finally {
            updateRunButtonState();
            setNavDisabled(false);
          }
          return;
        }

        const needsDomain    = carouselRun.dataset.needsDomain    === 'true';
        const needsPassword  = carouselRun.dataset.needsPassword  === 'true';
        const needsAdminPath = carouselRun.dataset.needsAdminPath === 'true';
        const domain         = needsDomain    ? (document.getElementById('rs-domain-input')?.value.trim()    || '') : '';
        const password       = needsPassword  ? (document.getElementById('rs-setup-password')?.value          || '') : '';
        const adminPath      = needsAdminPath ? (document.getElementById('rs-setup-adminpath')?.value.trim() || '') : '';

        if (needsDomain && !domain) {
          if (stepStatus) { stepStatus.textContent = 'Enter your domain first.'; stepStatus.style.color = 'var(--danger,#c0392b)'; }
          return;
        }
        if (needsPassword && password.length < 10) {
          if (stepStatus) { stepStatus.textContent = 'Password must be at least 10 characters.'; stepStatus.style.color = 'var(--danger,#c0392b)'; }
          return;
        }

        carouselRun.disabled = true;
        setNavDisabled(true);
        startStepProgress(command);
        if (logSetup) logSetup.style.display = 'none';

        const payload = { command };
        if (command === 'git_clone') payload.repoUrl = 'https://github.com/lucas-iezzi/open-folio';
        if (domain)     payload.domain     = domain;
        if (password)   payload.password   = password;
        if (adminPath)  payload.adminPath  = adminPath;

        try {
          const r = await apiFetch('/admin/deploy/ssh-run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
          });
          const ok = r.ok !== false;
          stopStepProgress(ok);
          if (stepStatus) { stepStatus.textContent = ok ? '✓ Done' : '✗ Failed'; stepStatus.style.color = ok ? 'var(--success,#2d8a4e)' : 'var(--danger,#c0392b)'; }
          if (ok) markStepDone(currentStep);
          showLog(logSetup, ok, `Step ${currentStep + 1} ${ok ? 'complete' : 'failed'}`, r.output || r.stdout || r.stderr || '');
        } catch (err) {
          stopStepProgress(false);
          if (stepStatus) { stepStatus.textContent = '✗ Failed'; stepStatus.style.color = 'var(--danger,#c0392b)'; }
          showLog(logSetup, false, err.message);
        } finally {
          updateRunButtonState();
          setNavDisabled(false);
        }
      });
    }

    // ── Server command tiles ──
    document.querySelectorAll('.rs-cmd-tile').forEach(btn => {
      btn.addEventListener('click', async () => {
        const command = btn.dataset.cmd;
        btn.disabled  = true;
        showLog(logCmds, null, 'Running…');
        try {
          const r = await apiFetch('/admin/deploy/ssh-run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ command }),
          });
          const ok = r.ok !== false;
          const label = command.replace(/_/g, ' ');
          showLog(logCmds, ok, `${label} ${ok ? 'complete' : 'failed'}`, r.output || r.stdout || r.stderr || '');
        } catch (err) {
          showLog(logCmds, false, err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // ── Manage password (change server admin password) ──
    const rsManagePwBtn = document.getElementById('rs-manage-pw-btn');
    if (rsManagePwBtn) {
      rsManagePwBtn.addEventListener('click', async () => {
        const pwInput = document.getElementById('rs-manage-password');
        const pw = pwInput ? pwInput.value : '';
        if (!pw || pw.length < 10) {
          showLog(logCmds, false, 'Password must be at least 10 characters.');
          return;
        }
        rsManagePwBtn.disabled = true;
        showLog(logCmds, null, 'Changing server password…');
        try {
          const r = await apiFetch('/admin/deploy/ssh-run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ command: 'manage_password', password: pw }),
          });
          const ok = r.ok !== false;
          showLog(logCmds, ok, ok ? 'Server password changed and site restarted.' : 'Failed to change password.', r.output || r.stdout || r.stderr || '');
          if (ok && pwInput) pwInput.value = '';
        } catch (err) {
          showLog(logCmds, false, err.message);
        } finally {
          rsManagePwBtn.disabled = false;
        }
      });
    }

    // ── Manage admin path (change the secret word that gates /admin/login) ──
    const rsManageAdminPathBtn = document.getElementById('rs-manage-adminpath-btn');
    if (rsManageAdminPathBtn) {
      rsManageAdminPathBtn.addEventListener('click', async () => {
        const input = document.getElementById('rs-manage-adminpath');
        const val = input ? input.value.trim() : '';
        if (!val) {
          showLog(logCmds, false, 'Enter an admin path (or "admin" to reset to the default).');
          return;
        }
        rsManageAdminPathBtn.disabled = true;
        showLog(logCmds, null, 'Changing admin path…');
        try {
          const r = await apiFetch('/admin/deploy/ssh-run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ command: 'set_admin_path', adminPath: val }),
          });
          const ok = r.ok !== false;
          showLog(logCmds, ok, ok ? `Admin path changed to "${val}" and site restarted.` : 'Failed to change admin path.', r.output || r.stdout || r.stderr || '');
          if (ok && input) input.value = '';
        } catch (err) {
          showLog(logCmds, false, err.message);
        } finally {
          rsManageAdminPathBtn.disabled = false;
        }
      });
    }

    // ── Sync content ──
    const rsProgress = document.getElementById('rs-sync-progress');

    function setSyncProgress(text) {
      if (!rsProgress) return;
      rsProgress.style.display = text ? '' : 'none';
      rsProgress.textContent   = text || '';
    }

    // Drives both the Content Sync panel's progress bar and the banner's (if it's
    // showing one) — whichever elements exist in the DOM get updated, so callers don't
    // need to know which UI triggered the sync. pct === null hides both.
    function setSyncProgressBar(pct) {
      [
        ['rs-sync-progress-bar', 'rs-sync-progress-fill', 'rs-sync-progress-pct'],
        ['of-sync-progress-bar', 'of-sync-progress-fill', 'of-sync-progress-pct'],
      ].forEach(([wrapId, fillId, pctId]) => {
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;
        if (pct === null) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'flex';
        const fill = document.getElementById(fillId);
        const pctEl = document.getElementById(pctId);
        if (fill) fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(0) + '%';
        if (pctEl) pctEl.textContent = Math.round(pct) + '%';
      });
    }

    // Transfers one item (db | images/logos | images/projects[/slug]) in the given
    // direction, verified and retried server-side until it actually matches — "done"
    // here means the files are confirmed present, not just that scp exited 0. Streams
    // live progress into `render`, and reports fractional (0-1) completion for this one
    // item via `onProgress` so a caller syncing several items can show overall progress.
    async function syncItemWithProgress(itemId, label, direction, render, onProgress, forcePerFile) {
      const icon = direction === 'push' ? '↑' : '↓';
      let itemOk = false;
      let attempts = 1;
      let itemNotes = [];
      const report = (f) => { if (onProgress) onProgress(f); };

      try {
        await streamNdjson('/admin/deploy/sync-item', { itemId, direction, ...(forcePerFile ? { forcePerFile: true } : {}) }, (ev) => {
          let line = null;
          if (ev.stage === 'checking') {
            line = `🔍 ${label} — checking what's changed…`;
            report(0.05);
          } else if (ev.stage === 'diff-found') {
            line = `${icon} ${label} — ${ev.count} of ${ev.total} file${ev.total === 1 ? '' : 's'} differ`;
            report(0.15);
          } else if (ev.stage === 'transfer' && ev.mode === 'file') {
            line = `${icon} ${label} — file ${ev.index}/${ev.count}: ${ev.file}`;
            report(0.15 + 0.75 * (ev.index / ev.count));
          } else if (ev.stage === 'transfer') {
            line = `${icon} ${label} — transferring…`;
            report(0.5);
          } else if (ev.stage === 'file-failed') {
            line = `⚠ ${label} — ${ev.file} failed: ${ev.error}`;
          } else if (ev.stage === 'verify') {
            line = `🔍 ${label} — verifying…`;
            report(0.92);
          } else if (ev.stage === 'retrying') {
            attempts = ev.nextAttempt;
            line = `↻ ${label} — retrying (${ev.nextAttempt}/${ev.maxAttempts})…`;
          } else if (ev.done) {
            itemOk = ev.ok;
            report(1);
            if (ev.detail?.skipped) {
              line = `✓ ${label} — already in sync, nothing to transfer`;
            } else if (!ev.ok) {
              const missing = ev.detail?.missing;
              itemNotes = missing && missing.length ? missing : [ev.detail?.reason || ev.detail?.message || 'Sync failed.'];
            }
          }
          if (line) { setSyncProgress(line); render(line); }
        });
      } catch (err) {
        itemOk = false;
        itemNotes = [err.message];
      }
      return { ok: itemOk, attempts, notes: itemNotes };
    }

    // The main "just make it match" action: compares local vs server, then pushes or
    // pulls only what actually differs. When an item changed on *both* sides there's no
    // way to know which one should win, so it asks once per such item instead of
    // guessing. Shared by the Content Sync panel's button and the out-of-sync banner.
    async function runContentSync() {
      const btn = document.getElementById('rs-sync-btn');
      if (btn) btn.disabled = true;
      if (logSync) { logSync.style.display = 'block'; logSync.className = 'rs-log rs-log--running'; logSync.textContent = ''; }
      setSyncProgress('Checking what has changed…');
      showLog(logSync, null, 'Checking what has changed…');

      let compareData;
      try {
        compareData = await apiFetch('/admin/deploy/compare', { method: 'POST' });
      } catch (err) {
        setSyncProgress(null);
        showLog(logSync, false, 'Could not compare', err.message);
        if (btn) btn.disabled = false;
        return;
      }
      if (!compareData.ok || compareData.error) {
        setSyncProgress(null);
        showLog(logSync, false, 'Could not compare', compareData.error || '');
        if (btn) btn.disabled = false;
        return;
      }

      const items = compareData.items || [];
      if (items.length === 0) {
        setSyncProgress(null);
        showLog(logSync, true, 'Already in sync — nothing to do.', '');
        if (btn) btn.disabled = false;
        return;
      }

      // Resolve a direction for every item, asking once for any that could go either way.
      const plan = [];
      for (const item of items) {
        let direction = item.direction;
        if (direction === 'both') {
          const pushLocal = confirm(
            `"${item.label}" has changed on BOTH sides${item.hint ? ` (${item.hint})` : ''}.\n\n` +
            `Click OK to push your LOCAL copy to the server, or Cancel to pull the SERVER copy to local.`
          );
          direction = pushLocal ? 'push' : 'pull';
        }
        if (direction === 'push' || direction === 'pull') plan.push({ id: item.id, label: item.label, direction });
      }

      // A project's (or the settings') DB row references its images by path — syncing
      // the row before the images land would leave whichever side just received it
      // pointing at files that aren't there yet (a "broken reference"). Images always go
      // first, in either direction, so a row is never written ahead of what it points to.
      plan.sort((a, b) => (a.id.startsWith('images/') ? 0 : 1) - (b.id.startsWith('images/') ? 0 : 1));
      function imageDepFor(id) {
        const m = id.match(/^db-project\/(.+)$/);
        if (m) return `images/projects/${m[1]}`;
        if (id === 'db-settings') return 'images/logos';
        return null;
      }

      const checklist = [];
      function render(liveLine) {
        const text = checklist.concat(liveLine ? [liveLine] : []).join('\n');
        showLog(logSync, null, text || 'Starting…');
      }

      const total = plan.length || 1;
      setSyncProgressBar(0);
      const results = [];
      const doneOk = {};
      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        const dep = imageDepFor(item.id);
        if (dep && doneOk[dep] === false) {
          // This project's (or the site's logo) images failed to sync this run — skip the
          // DB row rather than have it reference images that didn't actually land.
          checklist.push(`⏭ ${item.label} (skipped — its images didn't finish syncing)`);
          results.push({ label: item.label, ok: false, output: 'Skipped: dependent image sync failed — fix that first, then sync again.' });
          doneOk[item.id] = false;
          render();
          continue;
        }
        const r = await syncItemWithProgress(item.id, item.label, item.direction, render, (frac) => {
          setSyncProgressBar(((i + frac) / total) * 100);
        });
        doneOk[item.id] = r.ok;
        checklist.push(`${r.ok ? '✓' : '✗'} ${item.label}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ''}`);
        results.push({ label: item.label, ok: r.ok, output: r.notes.join('\n') });
        render();
      }
      setSyncProgressBar(100);

      // Restart the server after any push so it comes back clean — a whole-file db push
      // in particular orphans the running process's own open connection to that file when
      // scp replaces it (per-project rows and images are written in place and technically
      // don't need this), but restarting after every push is cheap and one less thing to
      // second-guess. Pulls only change local data, so they don't need a remote restart.
      let restartOk = null;
      let restartOut = '';
      if (plan.some((p) => p.direction === 'push')) {
        setSyncProgress('↺ Restarting server…');
        render('↺ Restarting server…');
        try {
          const r = await apiFetch('/admin/deploy/ssh-run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ command: 'restart' }),
          });
          restartOk  = r.ok !== false;
          restartOut = r.output || r.stdout || '';
        } catch (err) {
          restartOk  = false;
          restartOut = err.message;
        }
      }

      setSyncProgress(null);
      setTimeout(() => setSyncProgressBar(null), 400);

      const allOk = results.every((x) => x.ok) && (restartOk === null || restartOk);
      const summary = results.map((x) => `${x.label}: ${x.ok ? 'OK' : 'failed'}`).join(', ') +
        (restartOk !== null ? ` — server ${restartOk ? 'restarted' : 'restart failed'}` : '');
      const stdout = results.map((x) => `[${x.label}]\n${x.output || '(no issues)'}`).join('\n\n') +
        (restartOk !== null ? `\n\n[Server restart]\n${restartOut || '(no output)'}` : '');

      showLog(logSync, allOk, `Sync content: ${summary}`, stdout);
      if (btn) btn.disabled = false;
      runCompare(); // refresh the diff view now that things have (hopefully) changed
    }

    const rsSyncBtn = document.getElementById('rs-sync-btn');
    if (rsSyncBtn) rsSyncBtn.addEventListener('click', runContentSync);

    // ── Compare ──
    const rsCompareResult = document.getElementById('rs-compare-result');

    function timeAgo(ts) {
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    }

    async function runCompare() {
      if (!rsCompareResult) return;
      rsCompareResult.innerHTML = '<p class="rs-diff-clean" style="color:var(--muted)">Comparing…</p>';
      try {
        const r = await apiFetch('/admin/deploy/compare', { method: 'POST' });
        if (!r.ok || r.error) {
          rsCompareResult.innerHTML = `<p class="rs-diff-clean" style="color:#c0392b">&#x2717; ${escHtml(r.error || 'Compare failed')}</p>`;
          return;
        }

        let html = '';

        // Renders one push/pull row for a single sync item — shared by both standalone
        // cards (db, settings, logos) and rows nested inside a per-project group.
        function diffItemRow(item, label) {
          const dir = item.direction || 'both';
          let actions = '';
          if (dir === 'push') {
            actions = `<button class="btn btn-primary btn-sm rs-diff-push" data-item-id="${escHtml(item.id)}">&#x2191; Push to server</button>`;
          } else if (dir === 'pull') {
            actions = `<button class="btn btn-primary btn-sm rs-diff-pull" data-item-id="${escHtml(item.id)}">&#x2193; Pull from server</button>`;
          } else {
            actions = `<button class="btn btn-secondary btn-sm rs-diff-push" data-item-id="${escHtml(item.id)}">&#x2191; Push</button>
                       <button class="btn btn-secondary btn-sm rs-diff-pull" data-item-id="${escHtml(item.id)}">&#x2193; Pull</button>`;
          }
          return `<div class="rs-diff-item">
            <div class="rs-diff-item-info">
              <div class="rs-diff-item-label">${escHtml(label)}</div>
              ${item.hint ? `<div class="rs-diff-item-hint">${escHtml(item.hint)}</div>` : ''}
            </div>
            <div class="rs-diff-actions">${actions}</div>
          </div>`;
        }

        if (!r.items || r.items.length === 0) {
          html += '<p class="rs-diff-clean">&#x2713; Everything is in sync.</p>';
        } else {
          // Group a project's DB row and its image folder into one card — the raw item
          // list otherwise shows "wheelchair-lift" (data) and "wheelchair-lift" (images)
          // as two disconnected rows instead of one place to see the whole project's state.
          const groups = new Map();   // slug -> { title, items: [{...item, kind}] }
          const standalone = [];
          for (const item of r.items) {
            const mData = item.id.match(/^db-project\/(.+)$/);
            const mImg  = item.id.match(/^images\/projects\/(.+)$/);
            const slug  = mData ? mData[1] : (mImg ? mImg[1] : null);
            if (!slug) { standalone.push(item); continue; }
            if (!groups.has(slug)) groups.set(slug, { title: null, items: [] });
            const g = groups.get(slug);
            g.items.push({ ...item, kind: mData ? 'data' : 'images' });
            if (mData) g.title = item.label;
          }

          const cardCount = groups.size + standalone.length;
          html += `<p class="rs-diff-header">${cardCount} out of sync:</p>`;

          for (const [slug, g] of groups) {
            const dataItem = g.items.find(i => i.kind === 'data');
            const imgItem  = g.items.find(i => i.kind === 'images');
            const subtext  = [dataItem?.hint, imgItem?.hint].filter(Boolean).join(' &middot; ');
            html += `<div class="rs-diff-group">
              <div class="rs-diff-group-header">
                <div class="rs-diff-item-label">${escHtml(g.title || slug)}</div>
                ${subtext ? `<div class="rs-diff-item-hint">${subtext}</div>` : ''}
              </div>`;
            if (dataItem) html += diffItemRow(dataItem, 'Project data');
            if (imgItem)  html += diffItemRow(imgItem, 'Images');
            html += `</div>`;
          }

          for (const item of standalone) html += diffItemRow(item, item.label);
        }

        // ── Broken references — a project/logo points at a file that isn't actually
        // there on that side. This is what "images disappearing" looks like; sync alone
        // can't fix it since the file that would need syncing doesn't exist anywhere. ──
        if (r.broken && r.broken.length) {
          html += `<p class="rs-diff-header" style="margin-top:1rem;color:#c0392b">&#x26A0; ${r.broken.length} broken image reference${r.broken.length === 1 ? '' : 's'}:</p>`;
          for (const b of r.broken) {
            html += `<div class="rs-diff-item">
              <div class="rs-diff-item-info">
                <div class="rs-diff-item-label">${escHtml(b.path)}</div>
                <div class="rs-diff-item-hint">Referenced by a project on <strong>${b.side}</strong>, but the file is missing there — re-upload it or remove it from the project.</div>
              </div>
            </div>`;
          }
        }

        // ── Orphaned files — exist on one side only, and that side's own content
        // doesn't reference them. Safe to delete; nothing else is pointing at them. ──
        if (r.orphans && r.orphans.length) {
          html += `<p class="rs-diff-header" style="margin-top:1rem">${r.orphans.length} orphaned file${r.orphans.length === 1 ? '' : 's'} (not used on any page):</p>`;
          for (const o of r.orphans) {
            html += `<div class="rs-diff-item">
              <div class="rs-diff-item-info">
                <div class="rs-diff-item-label">${escHtml(o.path)}</div>
                <div class="rs-diff-item-hint">Only on <strong>${o.side}</strong>, unused</div>
              </div>
              <div class="rs-diff-actions">
                <button class="btn btn-secondary btn-sm rs-orphan-delete" data-side="${escHtml(o.side)}" data-path="${escHtml(o.path)}">&#x1F5D1; Delete from ${o.side}</button>
              </div>
            </div>`;
          }
        }

        // ── Recent content changes — best-effort audit trail from content_log ──
        const logEntries = [
          ...(r.recentLog?.local  || []).map(e => ({ ...e, side: 'local'  })),
          ...(r.recentLog?.remote || []).map(e => ({ ...e, side: 'remote' })),
        ].sort((a, z) => z.ts - a.ts).slice(0, 20);
        if (logEntries.length) {
          html += `<details class="rs-inner-card" style="margin-top:1rem">
            <summary class="rs-inner-summary">Recent content changes</summary>
            <div class="rs-inner-body">`;
          for (const e of logEntries) {
            const icon = e.action === 'added' ? '&#x2795;' : '&#x2796;';
            html += `<div class="rs-diff-item-hint" style="padding:.15rem 0">${icon} <strong>${escHtml(e.side)}</strong> — ${e.action} ${escHtml(e.path)} <span style="opacity:.6">(${timeAgo(e.ts)})</span></div>`;
          }
          html += `</div></details>`;
        }

        rsCompareResult.innerHTML = html;

        rsCompareResult.querySelectorAll('.rs-diff-push, .rs-diff-pull').forEach(b => {
          b.addEventListener('click', async () => {
            const itemId    = b.dataset.itemId;
            const direction = b.classList.contains('rs-diff-push') ? 'push' : 'pull';
            const verb      = direction === 'push' ? 'Pushing' : 'Pulling';
            b.disabled = true;
            let finalOk = false;
            let finalDetail = null;
            try {
              await streamNdjson('/admin/deploy/sync-item', { itemId, direction }, (ev) => {
                if (ev.stage === 'checking') {
                  b.textContent = 'Checking…';
                } else if (ev.stage === 'diff-found') {
                  b.textContent = `${ev.count}/${ev.total} differ…`;
                } else if (ev.stage === 'transfer' && ev.mode === 'file') {
                  b.textContent = `${verb} ${ev.index}/${ev.count}…`;
                } else if (ev.stage === 'transfer') {
                  b.textContent = `${verb}…`;
                } else if (ev.stage === 'verify') {
                  b.textContent = 'Verifying…';
                } else if (ev.stage === 'retrying') {
                  b.textContent = `Retrying (${ev.nextAttempt}/${ev.maxAttempts})…`;
                } else if (ev.done) {
                  finalOk = ev.ok;
                  finalDetail = ev.detail;
                }
              });
            } catch (err) {
              finalDetail = { message: err.message };
            }
            if (finalOk) {
              b.closest('.rs-diff-item').style.opacity = '0.45';
              b.innerHTML = (finalDetail && finalDetail.skipped)
                ? '&#x2713; Already in sync'
                : (direction === 'push' ? '&#x2191; Pushed &amp; verified' : '&#x2193; Pulled &amp; verified');
            } else {
              const missingCount = finalDetail && finalDetail.missing ? finalDetail.missing.length : 0;
              b.textContent = missingCount ? `✗ ${missingCount} file(s) still missing` : '✗ Failed — see server';
              b.disabled = false;
            }
          });
        });

        rsCompareResult.querySelectorAll('.rs-orphan-delete').forEach(b => {
          b.addEventListener('click', async () => {
            const side = b.dataset.side;
            const p    = b.dataset.path;
            if (!confirm(`Delete "${p}" from ${side}? This file isn't used on any page, but deleting it can't be undone.`)) return;
            b.disabled = true;
            b.textContent = 'Deleting…';
            try {
              const r2 = await apiFetch('/admin/deploy/cleanup-orphans', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ side, paths: [p] }),
              });
              const result = r2.results && r2.results[0];
              if (result && result.ok) {
                b.closest('.rs-diff-item').style.opacity = '0.45';
                b.innerHTML = '&#x2713; Deleted';
              } else {
                b.textContent = `✗ ${(result && result.reason) || 'Failed'}`;
                b.disabled = false;
              }
            } catch (err) {
              b.textContent = `✗ ${err.message}`;
              b.disabled = false;
            }
          });
        });
      } catch (err) {
        if (rsCompareResult) rsCompareResult.innerHTML = `<p class="rs-diff-clean" style="color:#c0392b">&#x2717; ${escHtml(err.message)}</p>`;
      }
    }

    const comparePanel   = document.querySelector('.rs-sync-panel[data-panel="compare"]');
    const compareRefresh = document.getElementById('rs-compare-refresh');
    if (comparePanel)   comparePanel.addEventListener('toggle', () => { if (comparePanel.open) runCompare(); });
    if (compareRefresh) compareRefresh.addEventListener('click', runCompare);

    // ── Sync mismatch banner ──
    // On admin panel open, silently compares local vs server (read-only — no files are
    // touched) and, if anything differs, shows a dismissible banner with sync buttons.
    // Deliberately does NOT auto-pull: a prior heuristic used total file counts to decide
    // whether to pull images, which could miss per-project mismatches when counts matched
    // even though the actual files differed — that's how images silently went missing on
    // the live site. The exact per-file Compare check below can't make that mistake.
    function showSyncBanner(items) {
      if (document.getElementById('of-sync-banner')) return;
      const counts = { push: 0, pull: 0, both: 0 };
      items.forEach(i => { counts[i.direction || 'both']++; });
      const parts = [];
      if (counts.push) parts.push(`${counts.push} local-only`);
      if (counts.pull) parts.push(`${counts.pull} server-only`);
      if (counts.both) parts.push(`${counts.both} differing`);

      const banner = document.createElement('div');
      banner.id = 'of-sync-banner';
      banner.className = 'of-sync-banner';
      banner.innerHTML =
        `<span class="of-sync-banner-text" id="of-sync-banner-text"><strong>Local and server content are out of sync</strong> — ${escHtml(parts.join(', '))}.</span>` +
        `<span class="of-sync-banner-actions" id="of-sync-banner-actions">` +
          `<button type="button" class="btn btn-primary btn-sm" id="of-sync-now">&#x21c4; Sync content</button>` +
          `<button type="button" class="of-sync-banner-dismiss" aria-label="Dismiss">&times;</button>` +
        `</span>`;
      document.body.insertBefore(banner, document.body.firstChild);

      banner.querySelector('.of-sync-banner-dismiss').addEventListener('click', () => banner.remove());
      document.getElementById('of-sync-now').addEventListener('click', async () => {
        const textEl = document.getElementById('of-sync-banner-text');
        const actionsEl = document.getElementById('of-sync-banner-actions');
        if (textEl) textEl.innerHTML = '<strong>Syncing content…</strong>';
        if (actionsEl) {
          actionsEl.innerHTML =
            `<span id="of-sync-progress-bar" class="rs-step-progress">` +
              `<span class="rs-step-progress-track"><span class="rs-step-progress-fill" id="of-sync-progress-fill"></span></span>` +
              `<span class="rs-step-progress-time" id="of-sync-progress-pct"></span>` +
            `</span>`;
        }
        await runContentSync();
        banner.remove();
      });
    }

    (function initSyncBanner() {
      const SESSION_KEY = 'ofSyncCheckTs';
      const last = parseInt(sessionStorage.getItem(SESSION_KEY) || '0');
      if (Date.now() - last < 120000) return; // at most once every 2 minutes per tab

      setTimeout(async function () {
        sessionStorage.setItem(SESSION_KEY, String(Date.now()));
        try {
          const r = await apiFetch('/admin/deploy/compare', { method: 'POST' });
          if (!r.ok || !r.items || r.items.length === 0) return;
          showSyncBanner(r.items);
        } catch (_) { /* silent — no server configured or SSH unavailable */ }
      }, 1500);
    })();

    // ── SSH Key Setup ──
    const sshKeyDetails = document.getElementById('rs-ssh-key-details');
    let sshKeyLoaded = false;
    if (sshKeyDetails) {
      sshKeyDetails.addEventListener('toggle', async () => {
        if (!sshKeyDetails.open || sshKeyLoaded) return;
        sshKeyLoaded = true;
        const status  = document.getElementById('rs-ssh-key-status');
        const content = document.getElementById('rs-ssh-key-content');
        const errDiv  = document.getElementById('rs-ssh-key-error');
        try {
          const r = await apiFetch('/admin/deploy/local-pubkey', { method: 'GET' });
          if (!r.ok || !r.key) throw new Error(r.error || 'Could not retrieve key.');
          const key     = r.key;
          const authCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${key}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
          document.getElementById('rs-ssh-auth-cmd').textContent = authCmd;
          if (r.generated) {
            status.textContent = 'No existing key was found — a new ed25519 key was generated for you.';
          } else {
            status.style.display = 'none';
          }
          content.style.display = '';
          document.getElementById('rs-copy-authcmd').addEventListener('click', () => {
            navigator.clipboard.writeText(authCmd).then(() => {
              document.getElementById('rs-copy-authcmd').textContent = 'Copied!';
              setTimeout(() => { document.getElementById('rs-copy-authcmd').textContent = 'Copy'; }, 2000);
            });
          });
        } catch (err) {
          status.style.display = 'none';
          errDiv.textContent   = '✗ ' + err.message;
          errDiv.style.display = '';
        }
      });
    }

    // ── Backups ──
    const rsBackupBtn  = document.getElementById('rs-backup-btn');
    const rsBackupList = document.getElementById('rs-backup-list');

    async function loadBackups() {
      if (!rsBackupList) return;
      try {
        const r = await apiFetch('/admin/deploy/backups', { method: 'GET' });
        if (!r.backups || r.backups.length === 0) {
          rsBackupList.innerHTML = '<p class="rs-backup-empty">No local backups yet.</p>';
          return;
        }
        let html = '';
        for (const b of r.backups) {
          html += `<div class="rs-backup-item">
            <div class="rs-backup-date">
              <div class="rs-backup-label">${escHtml(b.label)}</div>
              <div class="rs-backup-meta">${escHtml(b.contents)}</div>
            </div>
            <button class="btn btn-secondary btn-sm rs-backup-push" data-path="${escHtml(b.path)}">&#x2191; Push to server</button>
          </div>`;
        }
        rsBackupList.innerHTML = html;
        rsBackupList.querySelectorAll('.rs-backup-push').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled    = true;
            btn.textContent = 'Pushing…';
            try {
              const r2 = await apiFetch('/admin/deploy/push-backup', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ path: btn.dataset.path }),
              });
              btn.textContent = r2.ok !== false ? '&#x2713; Done' : '&#x2717; Failed';
            } catch (err) {
              btn.textContent = '&#x2717; Error';
            } finally {
              setTimeout(() => { btn.disabled = false; btn.innerHTML = '&#x2191; Push to server'; }, 2200);
            }
          });
        });
      } catch (err) {
        if (rsBackupList) rsBackupList.innerHTML = `<p class="rs-backup-empty" style="color:#c0392b">${escHtml(err.message)}</p>`;
      }
    }

    // Load backup list when panel opens
    const backupPanel = document.querySelector('.rs-sync-panel[data-panel="backup"]');
    if (backupPanel) backupPanel.addEventListener('toggle', () => { if (backupPanel.open) loadBackups(); });

    if (rsBackupBtn) rsBackupBtn.addEventListener('click', async () => {
      rsBackupBtn.disabled    = true;
      rsBackupBtn.textContent = 'Downloading…';
      try {
        const r = await apiFetch('/admin/deploy/backup', { method: 'POST' });
        rsBackupBtn.textContent = r.ok !== false ? '&#x2713; Downloaded' : '&#x2717; Failed';
        loadBackups();
      } catch (err) {
        rsBackupBtn.textContent = '&#x2717; ' + err.message.slice(0, 28);
      } finally {
        rsBackupBtn.disabled = false;
        setTimeout(() => { rsBackupBtn.innerHTML = 'Download backup from server'; }, 2500);
      }
    });

    // ── Clear content (destructive — backs up first, requires typed confirmation) ──
    const logClear = document.getElementById('rs-log-clear');

    async function confirmDestructive(message) {
      if (!confirm(message)) return false;
      const typed = prompt('Type DELETE to confirm — this cannot be undone from within the app:');
      return typed === 'DELETE';
    }

    const rsClearServerBtn = document.getElementById('rs-clear-server-btn');
    if (rsClearServerBtn) {
      rsClearServerBtn.addEventListener('click', async () => {
        const ok = await confirmDestructive(
          'This will permanently delete ALL projects and project images on the LIVE SERVER ' +
          '(logos and site settings are kept). A backup will be downloaded first, but the server ' +
          'itself cannot be restored from within the app afterward. Continue?'
        );
        if (!ok) return;
        rsClearServerBtn.disabled = true;
        showLog(logClear, null, 'Backing up the server, then clearing its content…');
        try {
          const r = await apiFetch('/admin/deploy/clear-remote', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          const ok2 = r.ok !== false;
          showLog(logClear, ok2,
            ok2 ? `Server content cleared. Backup saved to ${r.backupPath}.` : 'Failed to clear server content.',
            r.output || r.error || '');
          if (ok2) runCompare();
        } catch (err) {
          showLog(logClear, false, err.message);
        } finally {
          rsClearServerBtn.disabled = false;
        }
      });
    }

    const rsClearLocalBtn = document.getElementById('rs-clear-local-btn');
    if (rsClearLocalBtn) {
      rsClearLocalBtn.addEventListener('click', async () => {
        const ok = await confirmDestructive(
          'This will permanently delete ALL projects and project images on THIS LOCAL MACHINE ' +
          '(logos and site settings are kept). A backup will be saved to data/backups/ first. Continue?'
        );
        if (!ok) return;
        rsClearLocalBtn.disabled = true;
        showLog(logClear, null, 'Backing up local content, then clearing it…');
        try {
          const r = await apiFetch('/admin/deploy/clear-local', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          const ok2 = r.ok !== false;
          showLog(logClear, ok2,
            ok2 ? `Local content cleared. Backup saved to ${r.backupPath}.` : 'Failed to clear local content.',
            r.error || '');
          if (ok2) runCompare();
        } catch (err) {
          showLog(logClear, false, err.message);
        } finally {
          rsClearLocalBtn.disabled = false;
        }
      });
    }

    // ── Open SSH terminal ──
    const rsOpenTermBtn = document.getElementById('rs-open-terminal');
    if (rsOpenTermBtn) {
      rsOpenTermBtn.addEventListener('click', async () => {
        rsOpenTermBtn.disabled = true;
        showLog(logCmds, null, 'Opening terminal…');
        try {
          await apiFetch('/admin/deploy/open-terminal', { method: 'POST' });
          showLog(logCmds, true, 'SSH terminal opened in your system terminal app.');
        } catch (err) {
          showLog(logCmds, false, err.message);
        } finally {
          rsOpenTermBtn.disabled = false;
        }
      });
    }

    // ── Copy SSH command ──
    const rsCopyBtn = document.getElementById('rs-copy-ssh');
    if (rsCopyBtn) {
      rsCopyBtn.addEventListener('click', () => {
        const cmd = rsSshCmd?.textContent || '';
        if (!cmd || cmd.startsWith('(')) return;
        navigator.clipboard.writeText(cmd).then(() => {
          rsCopyBtn.textContent = 'Copied!';
          setTimeout(() => { rsCopyBtn.textContent = 'Copy'; }, 1500);
        });
      });
    }
  })();

})();
