/* UI Sandbox — sandbox.js
   Manages the session, fires API calls, and reloads the preview
   iframe after each change. All visual rendering is server-side. */
(function () {
  'use strict';

  const state = {
    sid:          null,
    undoCount:    0,
    redoCount:    0,
    loading:      false,
    styleId:      null,   // id of currently loaded saved style (null = unsaved)
    styleName:    null,   // display name of currently loaded style
    dirty:        false,  // true if unsaved changes exist since last save/load
    // Current page being previewed: null = homepage, string = project slug
    currentSlug:  null,
    // Marker state
    markers:       {},    // { 'marker': { x, y, tag, selector, cssInfo, description } }
    pickingMarker: false,
  };

  function previewURL() {
    if (state.currentSlug) {
      return '/sandbox/preview/project/' + encodeURIComponent(state.currentSlug) + '?sid=' + encodeURIComponent(state.sid);
    }
    return '/sandbox/preview?sid=' + encodeURIComponent(state.sid);
  }

  function reloadPreview() {
    document.getElementById('sb-frame').src = previewURL();
  }

  // Runs after every iframe navigation — rewrites internal links to stay in sandbox
  // and tracks which page is currently being previewed.
  function handleFrameLoad() {
    const frame = document.getElementById('sb-frame');
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;

      // Detect current page from iframe URL
      const path = frame.contentWindow.location.pathname;
      const projectMatch = path.match(/^\/sandbox\/preview\/project\/([^/?]+)/);
      const prevSlug = state.currentSlug;
      state.currentSlug = projectMatch ? decodeURIComponent(projectMatch[1]) : null;
      if (state.currentSlug !== prevSlug) {
        // Clear marker whenever the viewed page changes
        clearMarkerPins();
        syncEditorUI();
      }

      // Rewrite internal links so navigation stays within the sandbox
      doc.querySelectorAll('a[href]').forEach(function (a) {
        const href = a.getAttribute('href');
        if (!href) return;
        if (href === '/' || href === '') {
          a.setAttribute('href', '/sandbox/preview?sid=' + encodeURIComponent(state.sid));
        } else if (href.startsWith('/projects/')) {
          const slug = href.slice('/projects/'.length).split('?')[0];
          a.setAttribute('href', '/sandbox/preview/project/' + slug + '?sid=' + encodeURIComponent(state.sid));
        }
      });
    } catch (e) {
      // Cross-origin guard — should not happen since preview pages are same-origin
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────

  async function init() {
    const frame = document.getElementById('sb-frame');
    state.sid = frame.dataset.sid;

    // If the server pre-loaded a saved style (via ?load_style), record it
    if (window.__sbLoadStyleId) {
      state.styleId   = window.__sbLoadStyleId;
      state.styleName = window.__sbLoadStyleName || ('Style #' + window.__sbLoadStyleId);
      state.dirty     = false;
    }

    const res = await fetch('/api/sandbox/config?sid=' + encodeURIComponent(state.sid));
    if (!res.ok) throw new Error('Failed to load sandbox config.');
    const payload   = await res.json();
    state.undoCount = payload.undoCount;
    state.redoCount = payload.redoCount;

    syncEditorUI();
  }

  // ── Editor UI ─────────────────────────────────────────────────────

  function syncEditorUI() {
    const undoBtn = document.getElementById('sb-undo-btn');
    const redoBtn = document.getElementById('sb-redo-btn');
    undoBtn.disabled = state.undoCount === 0 || state.loading;
    redoBtn.disabled = state.redoCount === 0 || state.loading;

    const status = document.getElementById('sb-status');
    if (!state.loading) {
      const pageLabel = state.currentSlug ? 'project: ' + state.currentSlug : 'homepage';
      if (state.undoCount === 0) {
        status.textContent = (state.styleId ? 'Saved style loaded' : 'Default layout') + ' — ' + pageLabel;
      } else {
        status.textContent = state.undoCount + ' change' + (state.undoCount !== 1 ? 's' : '') + ' — ' + pageLabel;
      }
    }

    // Marker button — three explicit states
    const markerBtn = document.getElementById('sb-marker-btn');
    if (hasMarker()) {
      markerBtn.textContent = '◎ Remove Marker';
      markerBtn.title       = 'Click to remove the placed @marker';
      markerBtn.classList.remove('is-picking');
    } else if (state.pickingMarker) {
      markerBtn.textContent = '◎ Marker';
      markerBtn.title       = 'Click the preview to place @marker — click here or press Esc to cancel';
      markerBtn.classList.add('is-picking');
    } else {
      markerBtn.textContent = '◎ Marker';
      markerBtn.title       = 'Click to enter marker mode, then click any element on the preview';
      markerBtn.classList.remove('is-picking');
    }

    // Live site link follows current preview page
    const liveBtn = document.getElementById('sb-live-btn');
    if (liveBtn) {
      liveBtn.href = state.currentSlug ? '/projects/' + state.currentSlug : '/';
    }

    // Filename indicator
    const fnEl = document.getElementById('sb-filename');
    if (fnEl) {
      const name = state.styleName || 'Untitled';
      fnEl.textContent = state.dirty ? name + '*' : name;
      fnEl.classList.toggle('is-dirty', state.dirty);
      fnEl.title = state.dirty ? 'Unsaved changes' : (state.styleName ? 'Saved' : 'No style saved yet');
    }
  }

  function setLoading(on) {
    state.loading = on;
    if (on && state.pickingMarker) cancelMarkerPick();
    const applyBtn = document.getElementById('sb-apply-btn');
    const promptEl = document.getElementById('sb-prompt');
    const undoBtn  = document.getElementById('sb-undo-btn');
    const redoBtn  = document.getElementById('sb-redo-btn');
    applyBtn.disabled    = on;
    promptEl.disabled    = on;
    undoBtn.disabled     = on || state.undoCount === 0;
    redoBtn.disabled     = on || state.redoCount === 0;
    applyBtn.textContent = on ? '…' : 'Apply';
    applyBtn.classList.toggle('is-loading', on);
  }

  function setStatus(text) {
    document.getElementById('sb-status').textContent = text;
  }

  // ── Handlers ─────────────────────────────────────────────────────

  async function handlePrompt() {
    if (state.loading) return;
    const promptEl    = document.getElementById('sb-prompt');
    const instruction = promptEl.value.trim();
    if (!instruction) return;

    setLoading(true);
    setStatus('Thinking…');
    try {
      const res  = await fetch('/api/sandbox/prompt', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sid:         state.sid,
          instruction: resolveMarkers(instruction),
          currentPage: state.currentSlug ? 'project:' + state.currentSlug : 'homepage',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');

      state.undoCount = data.undoCount;
      state.redoCount = data.redoCount;
      if (data.applied && data.applied.length > 0) state.dirty = true;
      promptEl.value  = '';
      if (data.applied && data.applied.length > 0) reloadPreview();
      syncEditorUI();
      if (data.explanation) {
        setStatus('Note: ' + data.explanation);
      } else if (data.applied && data.applied.length > 0) {
        setStatus('Applied: ' + data.applied.join(', '));
      } else {
        setStatus('No changes — try rephrasing.');
      }
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUndo() {
    if (state.loading || state.undoCount === 0) return;
    setLoading(true);
    setStatus('Undoing…');
    try {
      const res  = await fetch('/api/sandbox/undo', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sid: state.sid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');
      state.undoCount = data.undoCount;
      state.redoCount = data.redoCount;
      state.dirty     = state.undoCount > 0;
      reloadPreview();
      syncEditorUI();
      setStatus('Undone.');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRedo() {
    if (state.loading || state.redoCount === 0) return;
    setLoading(true);
    setStatus('Redoing…');
    try {
      const res  = await fetch('/api/sandbox/redo', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sid: state.sid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');
      state.undoCount = data.undoCount;
      state.redoCount = data.redoCount;
      state.dirty     = true;
      reloadPreview();
      syncEditorUI();
      setStatus('Redone.');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (state.loading) return;
    if (!confirm('Reset to the default layout? All sandbox changes will be lost.')) return;
    setLoading(true);
    setStatus('Resetting…');
    try {
      const res  = await fetch('/api/sandbox/reset', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sid: state.sid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');
      state.undoCount   = 0;
      state.redoCount   = 0;
      state.styleId     = null;
      state.styleName   = null;
      state.dirty       = false;
      state.currentSlug = null;
      localStorage.removeItem('sb_style_id');
      clearMarkerPins();
      reloadPreview();
      syncEditorUI();
      setStatus('Reset to default.');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (state.loading) return;
    if (!state.styleId) { openSaveAsModal(); return; }
    setLoading(true);
    setStatus('Saving…');
    try {
      const res = await fetch('/api/sandbox/styles/' + state.styleId, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sid: state.sid }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed.');
      state.dirty = false;
      setStatus('Saved.');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
      syncEditorUI();
    }
  }

  function openSaveAsModal() {
    document.getElementById('sb-saveas-name').value = '';
    document.getElementById('sb-saveas-modal').hidden = false;
    document.getElementById('sb-saveas-name').focus();
  }

  async function handleSaveAs() {
    const name = document.getElementById('sb-saveas-name').value.trim();
    if (!name) return;
    document.getElementById('sb-saveas-modal').hidden = true;
    setLoading(true);
    setStatus('Saving…');
    try {
      const res  = await fetch('/api/sandbox/styles', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sid: state.sid, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed.');
      state.styleId   = data.id;
      state.styleName = name;
      state.dirty     = false;
      localStorage.setItem('sb_style_id', data.id);
      setStatus('Saved as "' + name + '".');
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
      syncEditorUI();
    }
  }

  // ── Import Style ──────────────────────────────────────────────────

  let importImageFile = null;
  let importHtmlFile  = null;

  function updateImportConfirmBtn() {
    const hasUrl   = !!(document.getElementById('sb-match-url').value.trim());
    const enabled  = hasUrl || !!importImageFile || !!importHtmlFile;
    document.getElementById('sb-match-confirm').disabled = !enabled;
  }

  function setImportFile(type, file) {
    const dropId  = type === 'image' ? 'sb-image-drop'       : 'sb-html-drop';
    const labelId = type === 'image' ? 'sb-image-drop-label' : 'sb-html-drop-label';
    const dropEl  = document.getElementById(dropId);
    document.getElementById(labelId).textContent = '✓ ' + file.name;
    dropEl.classList.add('sb-drop-zone--has-file');
    if (type === 'image') importImageFile = file;
    else importHtmlFile = file;
    updateImportConfirmBtn();
  }

  function clearImportFile(type) {
    const dropId     = type === 'image' ? 'sb-image-drop'       : 'sb-html-drop';
    const labelId    = type === 'image' ? 'sb-image-drop-label' : 'sb-html-drop-label';
    const defaultTxt = type === 'image' ? 'Drop image here or click to browse' : 'Drop .html or .css file here or click to browse';
    document.getElementById(labelId).textContent = defaultTxt;
    document.getElementById(dropId).classList.remove('sb-drop-zone--has-file');
    if (type === 'image') importImageFile = null;
    else importHtmlFile = null;
    updateImportConfirmBtn();
  }

  function setupDropZone(type, acceptFn) {
    const dropEl  = document.getElementById(type === 'image' ? 'sb-image-drop' : 'sb-html-drop');
    const inputEl = document.getElementById(type === 'image' ? 'sb-image-input' : 'sb-html-input');

    dropEl.addEventListener('click', function (e) {
      if (e.target !== dropEl && e.target.id !== (type === 'image' ? 'sb-image-drop-label' : 'sb-html-drop-label')) return;
      inputEl.click();
    });
    dropEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.click(); }
    });
    inputEl.addEventListener('change', function () {
      if (inputEl.files[0] && acceptFn(inputEl.files[0])) setImportFile(type, inputEl.files[0]);
      inputEl.value = '';
    });
    dropEl.addEventListener('dragover',  function (e) { e.preventDefault(); dropEl.classList.add('sb-drop-zone--drag'); });
    dropEl.addEventListener('dragleave', function ()  { dropEl.classList.remove('sb-drop-zone--drag'); });
    dropEl.addEventListener('drop', function (e) {
      e.preventDefault();
      dropEl.classList.remove('sb-drop-zone--drag');
      const file = e.dataTransfer.files[0];
      if (file && acceptFn(file)) setImportFile(type, file);
    });
  }

  function openMatchModal() {
    importImageFile = null;
    importHtmlFile  = null;
    document.getElementById('sb-match-url').value = '';
    clearImportFile('image');
    clearImportFile('html');
    document.getElementById('sb-match-modal').hidden = false;
    document.getElementById('sb-match-url').focus();
  }

  async function handleMatchStyle() {
    const url = document.getElementById('sb-match-url').value.trim();
    if (!url && !importImageFile && !importHtmlFile) return;

    document.getElementById('sb-match-modal').hidden = true;
    setLoading(true);

    let label = url ? (function () { try { return new URL(url).hostname; } catch { return url; } }()) :
                importHtmlFile ? importHtmlFile.name : 'image';
    setStatus('Analyzing ' + label + '…');

    try {
      const fd = new FormData();
      fd.append('sid', state.sid);
      if (url)             fd.append('url',       url);
      if (importImageFile) fd.append('imageFile', importImageFile);
      if (importHtmlFile)  fd.append('htmlFile',  importHtmlFile);

      const res  = await fetch('/api/sandbox/match-style', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Style import failed.');

      state.undoCount = data.undoCount;
      state.redoCount = data.redoCount;

      if (data.applied && data.applied.length > 0) {
        state.dirty = true;
        reloadPreview();
        const summary = data.applied.slice(0, 2).join(' · ') + (data.applied.length > 2 ? ' + more' : '');
        setStatus('Applied: ' + summary);
      } else if (data.explanation) {
        setStatus('Note: ' + data.explanation);
      } else {
        setStatus('No changes — try providing more inputs.');
      }
      syncEditorUI();
    } catch (err) {
      setStatus('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Marker pick ───────────────────────────────────────────────────

  function hasMarker() { return !!state.markers['marker']; }

  function startMarkerPick() {
    if (state.loading) return;
    state.pickingMarker = true;
    document.getElementById('sb-marker-overlay').classList.add('is-picking');
    syncEditorUI();
    setStatus('Click any element on the preview — Esc or Marker button to cancel');
  }

  function cancelMarkerPick() {
    state.pickingMarker = false;
    document.getElementById('sb-marker-overlay').classList.remove('is-picking');
    syncEditorUI();
  }

  function handleMarkerOverlayClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const frame = document.getElementById('sb-frame');
    const rect  = frame.getBoundingClientRect();
    const ix    = e.clientX - rect.left;
    const iy    = e.clientY - rect.top;

    cancelMarkerPick();

    if (ix < 0 || iy < 0 || ix > rect.width || iy > rect.height) return;

    let el, iframeDoc;
    try {
      iframeDoc = frame.contentDocument || frame.contentWindow.document;
      el        = iframeDoc.elementFromPoint(ix, iy);
    } catch (err) {
      setStatus('Cannot read preview — wait for it to finish loading, then try again.');
      return;
    }
    if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return;

    // Single marker — clear any existing pin first
    clearMarkerPins();

    const info = getElementInfo(el, iframeDoc);
    state.markers['marker'] = { x: ix, y: iy, ...info };

    renderMarkerPin(e.clientX, e.clientY);

    // Insert @marker at cursor in the textarea
    const ta  = document.getElementById('sb-prompt');
    const pos = (ta.selectionStart != null) ? ta.selectionStart : ta.value.length;
    ta.value  = ta.value.slice(0, pos) + '@marker' + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + 7;
    ta.focus();

    syncEditorUI();
    setStatus('@marker → ' + info.description);
  }

  function getElementInfo(el, iframeDoc) {
    const tag = el.tagName.toLowerCase();
    const id  = el.id || '';
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    const text = el.textContent
      ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)
      : '';

    // Pull computed styles from inside the iframe
    let fontFamily = '', fontSize = '', color = '', bgColor = '';
    try {
      const iframeWin = iframeDoc.defaultView || iframeDoc.parentWindow;
      if (iframeWin) {
        const cs = iframeWin.getComputedStyle(el);
        fontFamily = cs.fontFamily;
        fontSize   = cs.fontSize;
        color      = cs.color;
        bgColor    = cs.backgroundColor;
      }
    } catch (_) { /* cross-origin guard */ }

    const selector = buildSelector(el);

    // Human-readable description shown in status bar and sent to the AI
    let desc = tag;
    if (id)  desc += '#' + id;
    if (cls) desc += '.' + cls.split(/\s+/).filter(Boolean)[0];
    if (text && tag !== 'body') {
      desc += ' "' + text.slice(0, 40) + (text.length > 40 ? '…' : '') + '"';
    }

    const cssInfo = [
      fontFamily ? 'font-family: ' + fontFamily : '',
      fontSize   ? 'font-size: '   + fontSize   : '',
      color      ? 'color: '       + color      : '',
      bgColor && bgColor !== 'rgba(0, 0, 0, 0)' ? 'background: ' + bgColor : '',
    ].filter(Boolean).join('; ');

    return { tag, id, cls, text, selector, fontFamily, fontSize, color, bgColor, cssInfo, description: desc };
  }

  function buildSelector(el) {
    const parts = [];
    let cur   = el;
    let depth = 0;
    while (cur && cur.tagName && cur.tagName.toUpperCase() !== 'BODY' && depth < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(part + '#' + cur.id);
        break; // ID is unique — stop walking up
      }
      const classes = typeof cur.className === 'string'
        ? cur.className.trim().split(/\s+/).filter(Boolean)
        : [];
      if (classes.length) part += '.' + classes.join('.');
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  // Expand @marker token in a prompt string before sending to the AI
  function resolveMarkers(instruction) {
    return instruction.replace(/@marker\b/gi, function (match) {
      const m = state.markers['marker'];
      if (!m) return match;
      return (
        '[' + m.description +
        ', CSS selector: "' + m.selector + '"' +
        (m.cssInfo ? ', computed styles — ' + m.cssInfo : '') +
        ']'
      );
    });
  }

  function renderMarkerPin(screenX, screenY) {
    const pins  = document.getElementById('sb-marker-pins');
    const pin   = document.createElement('div');
    pin.className  = 'sb-marker-pin';
    pin.title      = 'Click to remove @marker';
    pin.style.left = screenX + 'px';
    pin.style.top  = screenY + 'px';
    pin.appendChild(document.createElement('span')); // badge — styled via CSS
    pin.addEventListener('click', function () {
      clearMarkerPins();
      syncEditorUI();
      setStatus('@marker removed.');
    });
    pins.appendChild(pin);
  }

  function clearMarkerPins() {
    document.getElementById('sb-marker-pins').innerHTML = '';
    state.markers = {};
  }

  // ── Wire up events ────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Track iframe navigation so link-rewriting and currentSlug stay in sync
    document.getElementById('sb-frame').addEventListener('load', handleFrameLoad);

    document.getElementById('sb-apply-btn').addEventListener('click', handlePrompt);
    document.getElementById('sb-undo-btn').addEventListener('click', handleUndo);
    document.getElementById('sb-redo-btn').addEventListener('click', handleRedo);
    document.getElementById('sb-reset-btn').addEventListener('click', handleReset);
    document.getElementById('sb-save-btn').addEventListener('click', handleSave);
    document.getElementById('sb-saveas-btn').addEventListener('click', openSaveAsModal);
    document.getElementById('sb-saveas-confirm').addEventListener('click', handleSaveAs);
    document.getElementById('sb-saveas-cancel').addEventListener('click', function () {
      document.getElementById('sb-saveas-modal').hidden = true;
    });

    // Import Style modal
    setupDropZone('image', function (f) { return f.type.startsWith('image/'); });
    setupDropZone('html',  function (f) { return /\.(html?|css)$/i.test(f.name) || f.type.startsWith('text/'); });

    document.getElementById('sb-match-btn').addEventListener('click', openMatchModal);
    document.getElementById('sb-match-cancel').addEventListener('click', function () {
      document.getElementById('sb-match-modal').hidden = true;
    });
    document.getElementById('sb-match-confirm').addEventListener('click', handleMatchStyle);
    document.getElementById('sb-match-url').addEventListener('input',   updateImportConfirmBtn);
    document.getElementById('sb-match-url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  handleMatchStyle();
      if (e.key === 'Escape') document.getElementById('sb-match-modal').hidden = true;
    });
    document.getElementById('sb-match-modal').addEventListener('click', function (e) {
      if (e.target === this) this.hidden = true;
    });

    // Save-as modal backdrop + keyboard
    document.getElementById('sb-saveas-modal').addEventListener('click', function (e) {
      if (e.target === this) this.hidden = true;
    });
    document.getElementById('sb-saveas-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  handleSaveAs();
      if (e.key === 'Escape') document.getElementById('sb-saveas-modal').hidden = true;
    });

    // Marker button: remove if placed → cancel if picking → start picking
    document.getElementById('sb-marker-btn').addEventListener('click', function () {
      if (hasMarker()) {
        clearMarkerPins();
        syncEditorUI();
        setStatus('@marker removed.');
      } else if (state.pickingMarker) {
        cancelMarkerPick();
        setStatus('Marker cancelled.');
      } else {
        startMarkerPick();
      }
    });

    // Marker overlay captures the click on the preview
    document.getElementById('sb-marker-overlay').addEventListener('click', handleMarkerOverlayClick);

    // Esc cancels pick mode
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.pickingMarker) {
        cancelMarkerPick();
        setStatus('Marker cancelled.');
      }
    });

    // Prompt submit on Enter (no Shift)
    document.getElementById('sb-prompt').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePrompt(); }
    });

    // Textarea auto-resize
    document.getElementById('sb-prompt').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 96) + 'px';
    });

    init().catch(function (err) {
      console.error('Sandbox init failed:', err);
      setStatus('Failed to load — try refreshing.');
    });
  });

}());
