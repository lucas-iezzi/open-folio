/* Admin Panel — admin.js */
(function () {
  'use strict';

  // ── Shared utilities ─────────────────────────────────────────────
  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  async function apiFetch(url, options = {}) {
    const headers = { 'X-CSRF-Token': getCsrfToken(), ...options.headers };
    const res = await fetch(url, { ...options, headers });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
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
  initSettings();

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
    tabList.addEventListener('click', function (e) {
      const tab = e.target.closest('.admin-tab');
      if (!tab) return;
      const panelId = 'tab-' + tab.dataset.tab;
      tabList.querySelectorAll('.admin-tab').forEach(function (t) {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      document.querySelectorAll('.admin-tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === panelId);
      });
    });
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

  // ── Settings panel toggle ──────────────────────────────────────────────────
  function initSettings() {
    const btn   = document.getElementById('nav-settings-btn');
    const panel = document.getElementById('settings-panel');
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      if (panel.hasAttribute('hidden')) {
        panel.removeAttribute('hidden');
        panel.scrollIntoView({ behavior: 'smooth' });
      } else {
        panel.setAttribute('hidden', '');
      }
    });
  }

  // ── Settings: API key forms ────────────────────────────────────────────────
  document.querySelectorAll('.settings-key-form').forEach(form => {
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
          body:    JSON.stringify({ key, value }),
        });
        input.value          = '';
        input.placeholder    = '••• saved — reload to see status update •••';
        feedback.textContent = 'Saved successfully.';
        feedback.className   = 'settings-key-feedback is-success';
      } catch (err) {
        feedback.textContent = err.message;
        feedback.className   = 'settings-key-feedback is-error';
      } finally {
        btn.disabled = false;
      }
    });
  });

})();
