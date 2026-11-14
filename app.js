/* Anota PDF — lector y anotador de PDFs para iPad (PWA).
 * Renderizado: pdf.js · Exportación: pdf-lib · Almacenamiento: IndexedDB
 */
'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  const PDF_OPTS = {
    cMapUrl: 'vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    isEvalSupported: false,
  };

  // Límite de píxeles por canvas (Safari en iPad limita la memoria de canvas).
  const MAX_CANVAS_PIXELS = 8_000_000;
  const MIN_ZOOM = 0.4, MAX_ZOOM = 5;
  const HL_ALPHA = 0.4;
  const TEXT_BASELINE = 0.88; // posición de la línea base respecto al tamaño de letra (line-height 1.2)

  const PEN_COLORS = ['#1a1a1a', '#1565c0', '#d32f2f', '#2e7d32', '#ef6c00', '#7b1fa2'];
  const HL_COLORS = ['#ffeb3b', '#a3e635', '#f9a8d4', '#7dd3fc', '#fdba74'];
  const WIDTH_RANGES = {
    pen: [0.5, 12, 0.5],
    highlighter: [4, 40, 1],
    shape: [0.5, 12, 0.5],
    text: [6, 72, 1],
    eraser: [4, 60, 1],
  };
  const DRAW_TOOLS = new Set(['pen', 'highlighter', 'eraser', 'shape', 'select']);

  // ---------------------------------------------------------------- utilidades
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const r2 = (v) => Math.round(v * 100) / 100;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  function hexToRgb01(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function invertMatrix([a, b, c, d, e, f]) {
    const det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  }

  // ---------------------------------------------------------------- IndexedDB
  const DB = {
    db: null,
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('anota-pdf', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('docs', { keyPath: 'id' });
          db.createObjectStore('files');
          db.createObjectStore('annots');
        };
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    },
    tx(store, mode, fn) {
      return new Promise((res, rej) => {
        const t = this.db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    },
    get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); },
    put(store, val, key) { return this.tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))); },
    del(store, key) { return this.tx(store, 'readwrite', (s) => s.delete(key)); },
    all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
  };

  // ---------------------------------------------------------------- ajustes
  const DEFAULT_SETTINGS = {
    tool: 'pen',
    shapeKind: 'rect',
    pencilOnly: false,
    penDetected: false,
    tools: {
      pen: { color: '#1a1a1a', width: 2 },
      highlighter: { color: '#ffeb3b', width: 14 },
      shape: { color: '#d32f2f', width: 2 },
      text: { color: '#1a1a1a', width: 16 },
      eraser: { width: 16 },
    },
  };
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('anota-pdf-settings') || 'null');
      if (s && s.tools) {
        return { ...DEFAULT_SETTINGS, ...s, tools: { ...DEFAULT_SETTINGS.tools, ...s.tools } };
      }
    } catch (_) { /* sin almacenamiento */ }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  function saveSettings() {
    try { localStorage.setItem('anota-pdf-settings', JSON.stringify(state.settings)); } catch (_) { /* nada */ }
  }

  // ---------------------------------------------------------------- estado
  const state = {
    settings: loadSettings(),
    doc: null,        // registro del documento
    bytes: null,      // ArrayBuffer del PDF original
    pdf: null,        // documento pdf.js
    pages: [],        // info de páginas
    annots: {},       // índice de página -> lista de anotaciones
    undo: [],
    redo: [],
    zoom: 1,
    baseScale: 1,
    scale: 1,         // píxeles CSS por punto PDF
    sel: null,        // { page, id }
    hidden: new Set(),// ids ocultos temporalmente (borrando / moviendo)
    textSize: new Map(),
  };

  // ---------------------------------------------------------------- elementos
  const el = {
    library: $('#library'), reader: $('#reader'),
    libGrid: $('#libGrid'), libEmpty: $('#libEmpty'), fileInput: $('#fileInput'),
    viewer: $('#viewer'), pages: $('#pages'),
    docTitle: $('#docTitle'), saveState: $('#saveState'),
    btnUndo: $('#btnUndo'), btnRedo: $('#btnRedo'),
    zoomLabel: $('#btnZoomFit'), pageLabel: $('#btnPage'),
    colors: $('#colors'), customColor: $('#customColor'),
    widthCtl: $('#widthCtl'), widthRange: $('#widthRange'), widthValue: $('#widthValue'), widthPreview: $('#widthPreview i'),
    shapeKinds: $('#shapeKinds'), selActions: $('#selActions'), btnSelEdit: $('#btnSelEdit'),
    btnPencilOnly: $('#btnPencilOnly'),
    eraserCursor: $('#eraserCursor'),
    moreMenu: $('#moreMenu'),
    toast: $('#toast'), busy: $('#busy'), busyText: $('#busyText'),
  };

  // ---------------------------------------------------------------- UI genérica
  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }
  function busy(on, text = 'Cargando…') {
    el.busyText.textContent = text;
    el.busy.hidden = !on;
  }

  /** Muestra un diálogo. buttons: [{label, value, cls}]. Devuelve el valor del botón pulsado. */
  function dialog({ title, html = '', buttons = [{ label: 'Aceptar', value: true, cls: 'primary' }], onOpen }) {
    return new Promise((resolve) => {
      const dlg = $('#dialog');
      $('#dlgTitle').textContent = title;
      $('#dlgBody').innerHTML = html;
      const actions = $('#dlgActions');
      actions.innerHTML = '';
      const close = (v) => { dlg.hidden = true; resolve(v); };
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.className = 'btn ' + (b.cls || '');
        btn.textContent = b.label;
        btn.onclick = () => close(typeof b.value === 'function' ? b.value() : b.value);
        actions.appendChild(btn);
      }
      dlg.hidden = false;
      const form = $('#dlgBody input');
      if (form) {
        form.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); actions.lastChild.click(); }
        });
      }
      if (onOpen) onOpen($('#dlgBody'));
    });
  }

  async function promptText(title, value, placeholder = '') {
    return dialog({
      title,
      html: `<input type="text" id="dlgInput" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off">`,
      buttons: [
        { label: 'Cancelar', value: null },
        { label: 'Aceptar', cls: 'primary', value: () => $('#dlgInput').value.trim() },
      ],
      onOpen: () => { const i = $('#dlgInput'); i.focus(); i.select(); },
    });
  }

  // ================================================================ BIBLIOTECA
  async function refreshLibrary() {
    const docs = (await DB.all('docs')).sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
    el.libGrid.innerHTML = '';
    el.libEmpty.hidden = docs.length > 0;
    for (const d of docs) {
      const card = document.createElement('div');
      card.className = 'lib-card';
      card.innerHTML = `
        <div class="lib-thumb"></div>
        <div class="lib-info">
          <div class="lib-name"></div>
          <div class="lib-meta">${d.pages} pág. · ${fmtSize(d.size)} · ${fmtDate(d.opened || d.added)}</div>
        </div>
        <div class="lib-card-actions">
          <button class="ren">Renombrar</button>
          <button class="del">Eliminar</button>
        </div>`;
      $('.lib-name', card).textContent = d.name;
      if (d.thumb) $('.lib-thumb', card).style.backgroundImage = `url("${d.thumb}")`;
      card.addEventListener('click', () => openDoc(d.id));
      $('.ren', card).addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = await promptText('Renombrar', d.name);
        if (name) { d.name = name; await DB.put('docs', d); refreshLibrary(); }
      });
      $('.del', card).addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await dialog({
          title: 'Eliminar documento',
          html: `<p>¿Seguro que quieres eliminar <b>${escapeHtml(d.name)}</b> y todas sus anotaciones? No se puede deshacer.</p>`,
          buttons: [{ label: 'Cancelar', value: false }, { label: 'Eliminar', value: true, cls: 'primary' }],
        });
        if (!ok) return;
        await DB.del('docs', d.id); await DB.del('files', d.id); await DB.del('annots', d.id);
        refreshLibrary();
      });
      el.libGrid.appendChild(card);
    }
  }

  async function makeThumb(pdf) {
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 320 / vp0.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const url = c.toDataURL('image/jpeg', 0.8);
    c.width = c.height = 0;
    return url;
  }

  async function addDocument(name, buf) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), ...PDF_OPTS }).promise;
    let thumb = null;
    try { thumb = await makeThumb(pdf); } catch (e) { console.warn(e); }
    const pages = pdf.numPages;
    pdf.destroy();
    const id = uid();
    const now = Date.now();
    await DB.put('files', buf, id);
    await DB.put('docs', { id, name, size: buf.byteLength, pages, thumb, added: now, opened: 0 });
    return id;
  }

  async function importFiles(files) {
    if (!files.length) return;
    busy(true, 'Importando…');
    let lastId = null, failed = 0;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        lastId = await addDocument(f.name.replace(/\.pdf$/i, ''), buf);
      } catch (e) {
        console.error(e);
        failed++;
      }
    }
    busy(false);
    await refreshLibrary();
    if (failed) toast(failed === 1 ? 'No se pudo abrir un archivo (¿es un PDF válido?)' : `No se pudieron abrir ${failed} archivos`);
    if (files.length === 1 && lastId) openDoc(lastId);
  }

  async function newNotebook() {
    const res = await dialog({
      title: 'Nueva libreta',
      html: `
        <p><input type="text" id="nbName" value="Libreta ${fmtDate(Date.now())}"></p>
        <p>
          <label><input type="radio" name="nbStyle" value="blank" checked> En blanco</label>&nbsp;&nbsp;
          <label><input type="radio" name="nbStyle" value="lined"> Rayada</label>&nbsp;&nbsp;
          <label><input type="radio" name="nbStyle" value="grid"> Cuadrícula</label>
        </p>
        <p><label>Páginas: <input type="number" id="nbPages" value="10" min="1" max="200" style="width:90px"></label></p>`,
      buttons: [
        { label: 'Cancelar', value: null },
        {
          label: 'Crear', cls: 'primary',
          value: () => ({
            name: $('#nbName').value.trim() || 'Libreta',
            style: ($('input[name=nbStyle]:checked') || {}).value || 'blank',
            pages: clamp(parseInt($('#nbPages').value, 10) || 10, 1, 200),
          }),
        },
      ],
    });
    if (!res) return;
    busy(true, 'Creando libreta…');
    try {
      const { PDFDocument, rgb } = PDFLib;
      const doc = await PDFDocument.create();
      const W = 595.28, H = 841.89;
      for (let i = 0; i < res.pages; i++) {
        const p = doc.addPage([W, H]);
        drawPaperStyle(p, res.style, W, H, rgb);
      }
      const bytes = await doc.save();
      const id = await addDocument(res.name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      busy(false);
      await refreshLibrary();
      openDoc(id);
    } catch (e) {
      busy(false);
      console.error(e);
      toast('No se pudo crear la libreta');
    }
  }

  function drawPaperStyle(p, style, W, H, rgb) {
    if (style === 'lined') {
      for (let y = H - 72; y > 40; y -= 24) {
        p.drawLine({ start: { x: 36, y }, end: { x: W - 36, y }, thickness: 0.5, color: rgb(0.75, 0.82, 0.92) });
      }
      p.drawLine({ start: { x: 72, y: 30 }, end: { x: 72, y: H - 30 }, thickness: 0.6, color: rgb(0.95, 0.6, 0.6) });
    } else if (style === 'grid') {
      const g = 14.17; // 5 mm
      for (let x = 28; x < W - 20; x += g) p.drawLine({ start: { x, y: 28 }, end: { x, y: H - 28 }, thickness: 0.35, color: rgb(0.82, 0.86, 0.92) });
      for (let y = 28; y < H - 20; y += g) p.drawLine({ start: { x: 28, y }, end: { x: W - 28, y }, thickness: 0.35, color: rgb(0.82, 0.86, 0.92) });
    }
  }

  // ================================================================ LECTOR
  let io = null; // IntersectionObserver

  async function openDoc(id, opts = {}) {
    busy(true, 'Abriendo…');
    try {
      const rec = await DB.get('docs', id);
      const buf = await DB.get('files', id);
      if (!rec || !buf) throw new Error('Documento no encontrado');
      const ann = await DB.get('annots', id);
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), ...PDF_OPTS }).promise;

      closeReaderInternals();
      state.doc = rec;
      state.bytes = buf;
      state.pdf = pdf;
      state.annots = (ann && ann.pages) || {};
      if (!opts.keepHistory) { state.undo = []; state.redo = []; }
      state.sel = null;
      state.hidden.clear();
      state.textSize.clear();

      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const p = await pdf.getPage(i);
        const vp = p.getViewport({ scale: 1 });
        pages.push({
          index: i - 1, pdfPage: p, w: vp.width, h: vp.height,
          transform: vp.transform, el: null, pdfCanvas: null, inkCanvas: null, textLayer: null,
          visible: false, renderKey: null, renderTask: null,
        });
      }
      state.pages = pages;
      buildPagesDom();

      el.docTitle.textContent = rec.name;
      el.library.hidden = true;
      el.reader.hidden = false;
      setSaveState('');

      state.zoom = opts.zoom || rec.zoom || 1;
      layout();
      const startPage = opts.page != null ? opts.page : (rec.lastPage || 0);
      if (startPage > 0 && pages[startPage]) el.viewer.scrollTop = pages[startPage].el.offsetTop - 8;
      if (opts.scrollTop != null) el.viewer.scrollTop = opts.scrollTop;
      updatePageLabel();
      updateUndoButtons();

      rec.opened = Date.now();
      rec.pages = pdf.numPages;
      DB.put('docs', rec);
    } catch (e) {
      console.error(e);
      toast('No se pudo abrir el documento');
    } finally {
      busy(false);
    }
  }

  function closeReaderInternals() {
    if (io) { io.disconnect(); io = null; }
    for (const pg of state.pages) {
      if (pg.renderTask) pg.renderTask.cancel();
      if (pg.pdfCanvas) pg.pdfCanvas.width = pg.pdfCanvas.height = 0;
      if (pg.inkCanvas) pg.inkCanvas.width = pg.inkCanvas.height = 0;
    }
    if (state.pdf) state.pdf.destroy();
    state.pdf = null;
    state.pages = [];
    el.pages.innerHTML = '';
  }

  async function closeReader() {
    endEditing();
    await flushSave();
    saveViewState();
    closeReaderInternals();
    state.doc = null;
    el.reader.hidden = true;
    el.library.hidden = false;
    refreshLibrary();
  }

  function buildPagesDom() {
    el.pages.innerHTML = '';
    io = new IntersectionObserver(onIntersect, { root: el.viewer, rootMargin: '80% 40%' });
    for (const pg of state.pages) {
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.index = pg.index;
      const pc = document.createElement('canvas'); pc.className = 'pdf';
      const ic = document.createElement('canvas'); ic.className = 'ink';
      const tl = document.createElement('div'); tl.className = 'texts';
      div.append(pc, ic, tl);
      el.pages.appendChild(div);
      pg.el = div; pg.pdfCanvas = pc; pg.inkCanvas = ic; pg.textLayer = tl;
      io.observe(div);
    }
  }

  function onIntersect(entries) {
    for (const e of entries) {
      const pg = state.pages[+e.target.dataset.index];
      if (!pg) continue;
      pg.visible = e.isIntersecting;
      if (!pg.visible) releasePage(pg);
    }
    scheduleRender();
  }

  function releasePage(pg) {
    if (pg.renderTask) { pg.renderTask.cancel(); pg.renderTask = null; }
    if (pg.pdfCanvas.width) { pg.pdfCanvas.width = 0; pg.pdfCanvas.height = 0; }
    if (pg.inkCanvas.width) { pg.inkCanvas.width = 0; pg.inkCanvas.height = 0; }
    pg.renderKey = null;
  }

  function pageDpr(pg) {
    const cssW = pg.w * state.scale, cssH = pg.h * state.scale;
    const dpr = window.devicePixelRatio || 1;
    return Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
  }
  const desiredKey = (pg) => state.scale.toFixed(4) + '@' + pageDpr(pg).toFixed(3);

  // ---- cola de renderizado
  let rendering = false;
  function scheduleRender() {
    if (!rendering && !pinch) processRender();
  }
  async function processRender() {
    rendering = true;
    try {
      for (;;) {
        if (pinch) break;
        const pg = nextPageToRender();
        if (!pg) break;
        try { await renderPage(pg); } catch (e) { console.error(e); pg.renderKey = desiredKey(pg); }
      }
    } finally {
      rendering = false;
    }
  }
  function nextPageToRender() {
    const center = el.viewer.scrollTop + el.viewer.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const pg of state.pages) {
      if (!pg.visible || pg.renderKey === desiredKey(pg)) continue;
      const d = Math.abs(pg.el.offsetTop + pg.el.offsetHeight / 2 - center);
      if (d < bestD) { bestD = d; best = pg; }
    }
    return best;
  }

  async function renderPage(pg) {
    const key = desiredKey(pg);
    const scale = state.scale;
    const dpr = pageDpr(pg);
    const cssW = pg.w * scale, cssH = pg.h * scale;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf';
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const vp = pg.pdfPage.getViewport({ scale: canvas.width / pg.w });
    const task = pg.pdfPage.render({ canvasContext: ctx, viewport: vp });
    pg.renderTask = task;
    try {
      await task.promise;
    } catch (e) {
      canvas.width = canvas.height = 0;
      if (e && e.name === 'RenderingCancelledException') return;
      throw e;
    } finally {
      if (pg.renderTask === task) pg.renderTask = null;
    }
    if (!pg.visible || key !== desiredKey(pg)) { canvas.width = canvas.height = 0; return; }
    const old = pg.pdfCanvas;
    old.replaceWith(canvas);
    old.width = old.height = 0;
    pg.pdfCanvas = canvas;
    pg.inkCanvas.width = canvas.width;
    pg.inkCanvas.height = canvas.height;
    pg.renderKey = key;
    drawInk(pg);
  }

  // ---- maquetación y zoom
  function layout() {
    if (!state.pages.length) return;
    const maxW = Math.max(...state.pages.map((p) => p.w));
    const avail = Math.max(200, el.viewer.clientWidth - 32);
    state.baseScale = avail / maxW;
    state.scale = state.baseScale * state.zoom;
    for (const pg of state.pages) {
      pg.el.style.width = Math.round(pg.w * state.scale) + 'px';
      pg.el.style.height = Math.round(pg.h * state.scale) + 'px';
      renderTexts(pg);
    }
    for (const pg of state.pages) if (pg.renderTask) { pg.renderTask.cancel(); }
    el.zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
    showSelection();
    scheduleRender();
  }

  /** Cambia el zoom manteniendo el punto de contenido P (coords de #pages) en la posición c (coords del visor). */
  function zoomAround(newZoom, P, c) {
    newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    const pg = pageAtY(P.y);
    let fx = 0.5, fy = 0;
    if (pg) {
      fx = (P.x - pg.el.offsetLeft) / pg.el.offsetWidth;
      fy = (P.y - pg.el.offsetTop) / pg.el.offsetHeight;
    }
    state.zoom = newZoom;
    layout();
    if (pg) {
      el.viewer.scrollLeft = pg.el.offsetLeft + fx * pg.el.offsetWidth - c.x;
      el.viewer.scrollTop = pg.el.offsetTop + fy * pg.el.offsetHeight - c.y;
    }
    saveViewStateSoon();
  }
  function zoomCentered(newZoom) {
    const c = { x: el.viewer.clientWidth / 2, y: el.viewer.clientHeight / 2 };
    zoomAround(newZoom, { x: el.viewer.scrollLeft + c.x, y: el.viewer.scrollTop + c.y }, c);
  }

  function pageAtY(y) {
    let best = null;
    for (const pg of state.pages) {
      if (pg.el.offsetTop <= y) best = pg; else break;
    }
    return best || state.pages[0];
  }

  function currentPageIndex() {
    const pg = pageAtY(el.viewer.scrollTop + el.viewer.clientHeight * 0.35);
    return pg ? pg.index : 0;
  }
  function updatePageLabel() {
    el.pageLabel.textContent = `${currentPageIndex() + 1} / ${state.pages.length}`;
  }

  // ---- dibujo de anotaciones
  const pressureFactor = (p) => 0.35 + 1.3 * p;

  function shapePolys(it) {
    const { x1, y1, x2, y2 } = it;
    switch (it.kind) {
      case 'line': return [[[x1, y1], [x2, y2]]];
      case 'arrow': {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const L = Math.max(8, it.width * 4);
        const h1 = [x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)];
        const h2 = [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)];
        return [[[x1, y1], [x2, y2]], [h1, [x2, y2], h2]];
      }
      case 'rect': return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]];
      case 'ellipse': {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        const pts = [];
        for (let i = 0; i <= 72; i++) {
          const t = (i / 72) * Math.PI * 2;
          pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
        return [pts];
      }
    }
    return [];
  }

  function drawInkItem(ctx, it) {
    const P = it.points;
    const n = P.length / 3;
    if (n === 1) {
      const w = it.width * (it.pressure ? pressureFactor(P[2]) : 1);
      ctx.beginPath();
      ctx.arc(P[0], P[1], w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (!it.pressure) {
      ctx.lineWidth = it.width;
      ctx.beginPath();
      ctx.moveTo(P[0], P[1]);
      for (let i = 1; i < n - 1; i++) {
        const x = P[i * 3], y = P[i * 3 + 1];
        ctx.quadraticCurveTo(x, y, (x + P[i * 3 + 3]) / 2, (y + P[i * 3 + 4]) / 2);
      }
      ctx.lineTo(P[(n - 1) * 3], P[(n - 1) * 3 + 1]);
      ctx.stroke();
      return;
    }
    let px = P[0], py = P[1];
    for (let i = 1; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1];
      ctx.lineWidth = it.width * pressureFactor(P[i * 3 + 2]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      if (i < n - 1) {
        const ex = (x + P[i * 3 + 3]) / 2, ey = (y + P[i * 3 + 4]) / 2;
        ctx.quadraticCurveTo(x, y, ex, ey);
        px = ex; py = ey;
      } else {
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function drawItem(ctx, it, dx = 0, dy = 0) {
    if (it.type === 'text') return;
    ctx.save();
    if (dx || dy) ctx.translate(dx, dy);
    ctx.strokeStyle = ctx.fillStyle = it.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (it.type === 'ink') {
      if (it.tool === 'highlighter') ctx.globalAlpha = HL_ALPHA;
      drawInkItem(ctx, it);
    } else if (it.type === 'shape') {
      ctx.lineWidth = it.width;
      for (const poly of shapePolys(it)) {
        ctx.beginPath();
        poly.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawInk(pg) {
    const c = pg.inkCanvas;
    if (!c.width) return;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const k = c.width / pg.w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const items = state.annots[pg.index] || [];
    for (const it of items) if (it.tool === 'highlighter' && !state.hidden.has(it.id)) drawItem(ctx, it);
    for (const it of items) if (it.tool !== 'highlighter' && !state.hidden.has(it.id)) drawItem(ctx, it);
  }

  function renderTexts(pg) {
    $$('.tbox:not(.editing)', pg.textLayer).forEach((e) => e.remove());
    if (editing && editing.pg === pg) {
      editing.el.style.left = editing.x * state.scale + 'px';
      editing.el.style.top = editing.y * state.scale + 'px';
      editing.el.style.fontSize = editing.size * state.scale + 'px';
    }
    const items = state.annots[pg.index] || [];
    for (const it of items) {
      if (it.type !== 'text' || (editing && editing.item && editing.item.id === it.id)) continue;
      const d = makeTextEl(it);
      if (state.hidden.has(it.id)) d.classList.add('ghost');
      pg.textLayer.appendChild(d);
      state.textSize.set(it.id, { w: d.offsetWidth / state.scale, h: d.offsetHeight / state.scale });
    }
  }

  function makeTextEl(it) {
    const d = document.createElement('div');
    d.className = 'tbox';
    d.dataset.id = it.id;
    d.style.left = it.x * state.scale + 'px';
    d.style.top = it.y * state.scale + 'px';
    d.style.fontSize = it.size * state.scale + 'px';
    d.style.color = it.color;
    d.textContent = it.text;
    return d;
  }

  function redrawPage(index) {
    const pg = state.pages[index];
    if (!pg) return;
    drawInk(pg);
    renderTexts(pg);
  }

  // ---- geometría de anotaciones
  function itemBBox(it) {
    if (it.type === 'ink') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const P = it.points;
      for (let i = 0; i < P.length; i += 3) {
        if (P[i] < x0) x0 = P[i]; if (P[i] > x1) x1 = P[i];
        if (P[i + 1] < y0) y0 = P[i + 1]; if (P[i + 1] > y1) y1 = P[i + 1];
      }
      const m = it.width * (it.pressure ? 0.9 : 0.5);
      return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
    }
    if (it.type === 'shape') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const poly of shapePolys(it)) for (const [x, y] of poly) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const m = it.width / 2;
      return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
    }
    const sz = state.textSize.get(it.id);
    const lines = it.text.split('\n');
    const w = sz ? sz.w : Math.max(...lines.map((l) => l.length)) * it.size * 0.55;
    const h = sz ? sz.h : lines.length * it.size * 1.2;
    return { x: it.x, y: it.y, w, h };
  }

  function hitItem(it, x, y, r) {
    const b = itemBBox(it);
    if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
    if (it.type === 'text') return true;
    if (it.type === 'ink') {
      const P = it.points;
      const half = it.width * (it.pressure ? 0.8 : 0.5);
      if (P.length === 3) return Math.hypot(x - P[0], y - P[1]) <= r + half;
      for (let i = 3; i < P.length; i += 3) {
        if (distToSeg(x, y, P[i - 3], P[i - 2], P[i], P[i + 1]) <= r + half) return true;
      }
      return false;
    }
    for (const poly of shapePolys(it)) {
      for (let i = 1; i < poly.length; i++) {
        if (distToSeg(x, y, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]) <= r + it.width / 2) return true;
      }
    }
    return false;
  }

  function translateItem(it, dx, dy) {
    if (it.type === 'ink') {
      const P = it.points.slice();
      for (let i = 0; i < P.length; i += 3) { P[i] += dx; P[i + 1] += dy; }
      return { ...it, points: P };
    }
    if (it.type === 'shape') return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
    return { ...it, x: it.x + dx, y: it.y + dy };
  }

  // ---- historial
  function commit(index, list) {
    const prev = state.annots[index] || [];
    state.undo.push({ page: index, prev, next: list });
    if (state.undo.length > 300) state.undo.shift();
    state.redo.length = 0;
    setPageItems(index, list);
  }
  function setPageItems(index, list) {
    if (list.length) state.annots[index] = list; else delete state.annots[index];
    redrawPage(index);
    if (state.sel && !findItem(state.sel.page, state.sel.id)) setSelection(null);
    else showSelection();
    scheduleSave();
    updateUndoButtons();
  }
  function undo() {
    endEditing();
    const e = state.undo.pop();
    if (!e) return;
    state.redo.push(e);
    setPageItems(e.page, e.prev);
    revealPage(e.page);
  }
  function redo() {
    endEditing();
    const e = state.redo.pop();
    if (!e) return;
    state.undo.push(e);
    setPageItems(e.page, e.next);
    revealPage(e.page);
  }
  function revealPage(index) {
    const pg = state.pages[index];
    if (!pg) return;
    const top = pg.el.offsetTop, bottom = top + pg.el.offsetHeight;
    const vt = el.viewer.scrollTop, vb = vt + el.viewer.clientHeight;
    if (bottom < vt || top > vb) el.viewer.scrollTop = top - 8;
  }
  function updateUndoButtons() {
    el.btnUndo.disabled = !state.undo.length;
    el.btnRedo.disabled = !state.redo.length;
  }
  const findItem = (page, id) => (state.annots[page] || []).find((i) => i.id === id);

  // ---- guardado
  let saveTimer = 0, savePending = false;
  function setSaveState(t) { el.saveState.textContent = t; }
  function scheduleSave() {
    savePending = true;
    setSaveState('Guardando…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    if (!savePending || !state.doc) return;
    savePending = false;
    try {
      await DB.put('annots', { pages: state.annots, updated: Date.now() }, state.doc.id);
      setSaveState('Guardado');
    } catch (e) {
      console.error(e);
      setSaveState('Error al guardar');
      toast('No se pudieron guardar las anotaciones (¿almacenamiento lleno?)');
    }
  }
  let viewTimer = 0;
  function saveViewStateSoon() { clearTimeout(viewTimer); viewTimer = setTimeout(saveViewState, 1000); }
  function saveViewState() {
    if (!state.doc || !state.pages.length) return;
    state.doc.zoom = state.zoom;
    state.doc.lastPage = currentPageIndex();
    DB.put('docs', state.doc).catch(() => {});
  }

  // ================================================================ HERRAMIENTAS
  function setTool(tool) {
    endEditing();
    if (tool !== 'select') setSelection(null);
    state.settings.tool = tool;
    saveSettings();
    $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    el.pages.classList.toggle('tool-text', tool === 'text');
    updateTouchAction();
    renderOptions();
  }

  function updateTouchAction() {
    const t = state.settings.tool;
    const capture = DRAW_TOOLS.has(t) && !state.settings.pencilOnly;
    el.viewer.classList.toggle('no-touch-scroll', capture);
    el.btnPencilOnly.classList.toggle('on', state.settings.pencilOnly);
  }

  function toolSettings() {
    const t = state.settings.tool;
    if (t === 'select') return null;
    return state.settings.tools[t] || null;
  }

  function renderOptions() {
    const t = state.settings.tool;
    const ts = toolSettings();
    const showColors = ['pen', 'highlighter', 'shape', 'text', 'select'].includes(t);
    const showWidth = ['pen', 'highlighter', 'shape', 'text', 'eraser'].includes(t);
    el.colors.hidden = !showColors;
    el.customColor.parentElement.hidden = !showColors;
    el.widthCtl.hidden = !showWidth;
    el.shapeKinds.hidden = t !== 'shape';
    el.selActions.hidden = !(t === 'select' && state.sel);

    if (showColors) {
      const palette = t === 'highlighter' ? HL_COLORS : PEN_COLORS;
      const selItem = state.sel ? findItem(state.sel.page, state.sel.id) : null;
      const current = ts ? ts.color : (selItem ? selItem.color : null);
      el.colors.innerHTML = '';
      for (const c of palette) {
        const b = document.createElement('button');
        b.className = 'swatch' + (current && current.toLowerCase() === c ? ' active' : '');
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', () => applyColor(c));
        el.colors.appendChild(b);
      }
      if (current) el.customColor.value = current;
    }
    if (showWidth) {
      const [mn, mx, st] = WIDTH_RANGES[t];
      el.widthRange.min = mn; el.widthRange.max = mx; el.widthRange.step = st;
      el.widthRange.value = ts.width;
      updateWidthPreview();
    }
    $$('.kind').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.settings.shapeKind));
    if (t === 'select' && state.sel) {
      const it = findItem(state.sel.page, state.sel.id);
      el.btnSelEdit.hidden = !(it && it.type === 'text');
    }
  }

  function updateWidthPreview() {
    const t = state.settings.tool;
    const ts = toolSettings();
    if (!ts) return;
    el.widthValue.textContent = ts.width;
    const px = t === 'text' ? clamp(ts.width * 0.5, 4, 26) : clamp(ts.width * 1.2, 2, 26);
    el.widthPreview.style.width = el.widthPreview.style.height = px + 'px';
    el.widthPreview.style.background = t === 'eraser' ? 'transparent' : ts.color;
    el.widthPreview.style.border = t === 'eraser' ? '1.5px solid var(--danger)' : '0';
    el.widthPreview.style.opacity = t === 'highlighter' ? HL_ALPHA + 0.2 : 1;
  }

  function applyColor(c) {
    const t = state.settings.tool;
    if (t === 'select') {
      if (!state.sel) return;
      const list = (state.annots[state.sel.page] || []).map((i) => (i.id === state.sel.id ? { ...i, color: c } : i));
      commit(state.sel.page, list);
    } else {
      state.settings.tools[t].color = c;
      saveSettings();
      if (editing) { editing.color = c; editing.el.style.color = c; }
    }
    renderOptions();
  }

  // ---- selección
  function setSelection(sel) {
    state.sel = sel;
    showSelection();
    if (state.settings.tool === 'select') renderOptions();
  }
  function showSelection(dx = 0, dy = 0) {
    $$('.selbox').forEach((e) => e.remove());
    if (!state.sel) return;
    const it = findItem(state.sel.page, state.sel.id);
    const pg = state.pages[state.sel.page];
    if (!it || !pg) return;
    const b = itemBBox(it);
    const pad = 4;
    const d = document.createElement('div');
    d.className = 'selbox';
    d.style.left = (b.x + dx) * state.scale - pad + 'px';
    d.style.top = (b.y + dy) * state.scale - pad + 'px';
    d.style.width = b.w * state.scale + 2 * pad + 'px';
    d.style.height = b.h * state.scale + 2 * pad + 'px';
    pg.el.appendChild(d);
  }
  function deleteSelection() {
    if (!state.sel) return;
    const { page, id } = state.sel;
    setSelection(null);
    commit(page, (state.annots[page] || []).filter((i) => i.id !== id));
  }
  function duplicateSelection() {
    if (!state.sel) return;
    const it = findItem(state.sel.page, state.sel.id);
    if (!it) return;
    const copy = { ...translateItem(it, 12, 12), id: uid() };
    commit(state.sel.page, [...(state.annots[state.sel.page] || []), copy]);
    setSelection({ page: state.sel.page, id: copy.id });
  }

  // ---- edición de texto
  let editing = null; // { pg, el, item, x, y, size, color }

  function startTextEdit(pg, item, x, y) {
    endEditing();
    const ts = state.settings.tools.text;
    let d;
    if (item) {
      d = $(`.tbox[data-id="${CSS.escape(item.id)}"]`, pg.textLayer) || makeTextEl(item);
      if (!d.parentNode) pg.textLayer.appendChild(d);
    } else {
      d = makeTextEl({ id: '', x, y, size: ts.width, color: ts.color, text: '' });
      pg.textLayer.appendChild(d);
    }
    editing = {
      pg, el: d, item,
      x: item ? item.x : x, y: item ? item.y : y,
      size: item ? item.size : ts.width, color: item ? item.color : ts.color,
    };
    d.classList.add('editing');
    try { d.contentEditable = 'plaintext-only'; } catch (_) { d.contentEditable = 'true'; }
    if (d.contentEditable !== 'plaintext-only') d.contentEditable = 'true';
    d.spellcheck = true;
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); endEditing(); }
      e.stopPropagation();
    });
    d.addEventListener('blur', () => { if (editing && editing.el === d) setTimeout(() => { if (editing && editing.el === d && document.activeElement !== d) endEditing(); }, 0); });
    d.focus();
    const range = document.createRange();
    range.selectNodeContents(d);
    range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }

  function endEditing() {
    if (!editing) return;
    const { pg, el: d, item, x, y, size, color } = editing;
    editing = null;
    let text = (d.innerText || '').replace(/ /g, ' ').replace(/\r/g, '');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    d.blur();
    d.remove();
    const list = (state.annots[pg.index] || []).slice();
    if (item) {
      const idx = list.findIndex((i) => i.id === item.id);
      if (idx < 0) { renderTexts(pg); return; }
      if (!text.trim()) { list.splice(idx, 1); commit(pg.index, list); }
      else if (text !== item.text || size !== item.size || color !== item.color) {
        list[idx] = { ...item, text, size, color };
        commit(pg.index, list);
      } else renderTexts(pg);
    } else if (text.trim()) {
      list.push({ id: uid(), type: 'text', x, y, text, size, color });
      commit(pg.index, list);
    } else {
      renderTexts(pg);
    }
  }

  // ================================================================ ENTRADA
  let action = null;          // gesto activo de dibujo/borrado/selección
  let pinch = null;
  let tap = null;             // posible toque (herramienta texto)
  let lastPointerType = '';
  let captureTouch = false, captureTimer = 0;
  let suppressTap = false;

  const live = document.createElement('canvas');
  live.className = 'live';
  let liveRaf = 0;

  function pointerAllowed(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'touch') return !state.settings.pencilOnly;
    return e.button === 0;
  }

  function onPenDetected() {
    if (state.settings.penDetected) return;
    state.settings.penDetected = true;
    if (!state.settings.pencilOnly) {
      state.settings.pencilOnly = true;
      updateTouchAction();
      toast('Apple Pencil detectado: activado «Solo lápiz». El dedo desplaza la página; el lápiz dibuja.', 5000);
    }
    saveSettings();
  }

  function toPage(rect, e) {
    return { x: (e.clientX - rect.left) / state.scale, y: (e.clientY - rect.top) / state.scale };
  }

  function attachLive(pg) {
    const ink = pg.inkCanvas;
    const dpr = pageDpr(pg);
    live.width = ink.width || Math.max(1, Math.floor(pg.w * state.scale * dpr));
    live.height = ink.height || Math.max(1, Math.floor(pg.h * state.scale * dpr));
    pg.el.insertBefore(live, pg.textLayer);
  }
  function detachLive() {
    cancelAnimationFrame(liveRaf);
    liveRaf = 0;
    const ctx = live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, live.width, live.height);
    if (live.parentNode) live.remove();
    live.width = live.height = 0;
  }
  function requestLive() {
    if (!liveRaf) liveRaf = requestAnimationFrame(drawLive);
  }
  function drawLive() {
    liveRaf = 0;
    if (!action) return;
    const pg = action.pg;
    const ctx = live.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, live.width, live.height);
    const k = live.width / pg.w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    if (action.type === 'ink') drawItem(ctx, action.item);
    else if (action.type === 'shape') drawItem(ctx, action.item);
    else if (action.type === 'move' && action.item.type !== 'text') drawItem(ctx, action.item, action.dx, action.dy);
  }

  function onPointerDown(e) {
    lastPointerType = e.pointerType;
    if (pinch) return;
    if (editing && !editing.el.contains(e.target)) {
      endEditing();
      suppressTap = true;
    }
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const pg = state.pages[+pageEl.dataset.index];
    const tool = state.settings.tool;

    if (tool === 'text') {
      if (e.pointerType === 'pen') onPenDetected();
      tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), pg, target: e.target };
      return;
    }
    if (tool === 'pan' || action) return;
    if (!pointerAllowed(e)) return;
    if (e.pointerType === 'pen') onPenDetected();

    const rect = pg.el.getBoundingClientRect();
    const { x, y } = toPage(rect, e);
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, pg, rect };

    if (tool === 'pen' || tool === 'highlighter') {
      const ts = state.settings.tools[tool];
      const pressure = e.pointerType === 'pen';
      const p = pressure ? (e.pressure || 0.5) : 0.5;
      action = {
        ...base, type: 'ink', lastP: p,
        item: { id: uid(), type: 'ink', tool, color: ts.color, width: ts.width, pressure, points: [x, y, p] },
      };
      attachLive(pg);
      requestLive();
    } else if (tool === 'shape') {
      const ts = state.settings.tools.shape;
      action = {
        ...base, type: 'shape',
        item: { id: uid(), type: 'shape', kind: state.settings.shapeKind, color: ts.color, width: ts.width, x1: x, y1: y, x2: x, y2: y },
      };
      attachLive(pg);
    } else if (tool === 'eraser') {
      action = { ...base, type: 'erase', removed: new Set(), lx: x, ly: y };
      showEraserCursor(e);
      eraseAt(x, y);
    } else if (tool === 'select') {
      const r = (e.pointerType === 'touch' ? 14 : 8) / state.scale;
      const items = state.annots[pg.index] || [];
      let hit = null;
      if (state.sel && state.sel.page === pg.index) {
        const cur = findItem(pg.index, state.sel.id);
        if (cur) {
          const b = itemBBox(cur);
          if (x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r) hit = cur;
        }
      }
      for (let i = items.length - 1; i >= 0 && !hit; i--) if (hitItem(items[i], x, y, r)) hit = items[i];
      if (!hit) { setSelection(null); return; }
      setSelection({ page: pg.index, id: hit.id });
      action = { ...base, type: 'move', item: hit, sx: x, sy: y, dx: 0, dy: 0, moved: false };
    }
    if (!action) return;
    e.preventDefault();
    try { el.pages.setPointerCapture(e.pointerId); } catch (_) { /* nada */ }
    captureTouch = true;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => { captureTouch = false; }, 400);
  }

  function onPointerMove(e) {
    if (action && action.type === 'erase' && e.pointerId === action.pointerId) showEraserCursor(e);
    if (!action || e.pointerId !== action.pointerId) return;
    e.preventDefault();
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    if (action.type === 'ink') {
      const it = action.item;
      const P = it.points;
      const minD = 0.6 / state.scale;
      for (const ev of evs) {
        const { x, y } = toPage(action.rect, ev);
        const lx = P[P.length - 3], ly = P[P.length - 2];
        if (Math.hypot(x - lx, y - ly) < minD) continue;
        let p = 0.5;
        if (it.pressure) {
          p = ev.pressure || action.lastP;
          p = action.lastP * 0.55 + p * 0.45;
          action.lastP = p;
        }
        P.push(x, y, p);
      }
      requestLive();
    } else if (action.type === 'shape') {
      const { x, y } = toPage(action.rect, e);
      action.item.x2 = x; action.item.y2 = y;
      requestLive();
    } else if (action.type === 'erase') {
      for (const ev of evs) {
        const { x, y } = toPage(action.rect, ev);
        // Interpola para no saltarse trazos con movimientos rápidos.
        const r = state.settings.tools.eraser.width / 2;
        const d = Math.hypot(x - action.lx, y - action.ly);
        const steps = Math.ceil(d / Math.max(1, r * 0.6));
        for (let s = 1; s <= steps; s++) {
          eraseAt(action.lx + ((x - action.lx) * s) / steps, action.ly + ((y - action.ly) * s) / steps);
        }
        action.lx = x; action.ly = y;
      }
    } else if (action.type === 'move') {
      const { x, y } = toPage(action.rect, e);
      action.dx = x - action.sx;
      action.dy = y - action.sy;
      if (!action.moved && Math.hypot(action.dx, action.dy) * state.scale > 3) {
        action.moved = true;
        state.hidden.add(action.item.id);
        drawInk(action.pg);
        if (action.item.type !== 'text') attachLive(action.pg);
      }
      if (action.moved) {
        if (action.item.type === 'text') {
          const d = $(`.tbox[data-id="${CSS.escape(action.item.id)}"]`, action.pg.textLayer);
          if (d) {
            d.classList.remove('ghost');
            d.style.transform = `translate(${action.dx * state.scale}px, ${action.dy * state.scale}px)`;
          }
        }
        showSelection(action.dx, action.dy);
        requestLive();
      }
    }
  }

  function onPointerUp(e) {
    if (tap && e.pointerId === tap.id) {
      const t = tap;
      tap = null;
      const moved = Math.hypot(e.clientX - t.x, e.clientY - t.y);
      if (e.type === 'pointerup' && moved < 12 && Date.now() - t.t < 800 && state.settings.tool === 'text') {
        if (suppressTap) { suppressTap = false; return; }
        handleTextTap(t.pg, e, t.target);
      }
      suppressTap = false;
      return;
    }
    suppressTap = false;
    if (!action || e.pointerId !== action.pointerId) return;
    finishAction(e.type === 'pointercancel');
  }

  function finishAction(cancelled) {
    const a = action;
    action = null;
    hideEraserCursor();
    if (!a) return;
    const index = a.pg.index;
    if (a.type === 'ink') {
      detachLive();
      if (a.item.points.length >= 3) commit(index, [...(state.annots[index] || []), a.item]);
    } else if (a.type === 'shape') {
      detachLive();
      const it = a.item;
      if (!cancelled && Math.hypot(it.x2 - it.x1, it.y2 - it.y1) * state.scale > 4) {
        commit(index, [...(state.annots[index] || []), it]);
      }
    } else if (a.type === 'erase') {
      const removed = a.removed;
      for (const id of removed) state.hidden.delete(id);
      if (removed.size) commit(index, (state.annots[index] || []).filter((i) => !removed.has(i.id)));
    } else if (a.type === 'move') {
      detachLive();
      state.hidden.delete(a.item.id);
      if (a.moved && !cancelled) {
        const moved = translateItem(a.item, a.dx, a.dy);
        commit(index, (state.annots[index] || []).map((i) => (i.id === a.item.id ? moved : i)));
      } else {
        redrawPage(index);
        showSelection();
      }
    }
  }

  /** Cancela el gesto actual sin guardar nada (p. ej. al empezar un pellizco). */
  function abortAction() {
    const a = action;
    action = null;
    hideEraserCursor();
    if (!a) return;
    detachLive();
    if (a.type === 'erase') for (const id of a.removed) state.hidden.delete(id);
    if (a.type === 'move') state.hidden.delete(a.item.id);
    redrawPage(a.pg.index);
    showSelection();
  }

  function eraseAt(x, y) {
    const a = action;
    const r = state.settings.tools.eraser.width / 2;
    const items = state.annots[a.pg.index] || [];
    let changed = false;
    for (const it of items) {
      if (a.removed.has(it.id)) continue;
      if (hitItem(it, x, y, r)) {
        a.removed.add(it.id);
        state.hidden.add(it.id);
        changed = true;
      }
    }
    if (changed) {
      drawInk(a.pg);
      for (const id of a.removed) {
        const d = $(`.tbox[data-id="${CSS.escape(id)}"]`, a.pg.textLayer);
        if (d) d.classList.add('ghost');
      }
    }
  }

  function showEraserCursor(e) {
    const size = state.settings.tools.eraser.width * state.scale;
    const c = el.eraserCursor;
    c.style.width = c.style.height = size + 'px';
    c.style.left = e.clientX + 'px';
    c.style.top = e.clientY + 'px';
    c.hidden = false;
  }
  function hideEraserCursor() { el.eraserCursor.hidden = true; }

  function handleTextTap(pg, e, target) {
    const tb = target && target.closest && target.closest('.tbox');
    if (tb && tb.classList.contains('editing')) return;
    if (tb && tb.dataset.id) {
      const item = findItem(pg.index, tb.dataset.id);
      if (item) { startTextEdit(pg, item); return; }
    }
    const rect = pg.el.getBoundingClientRect();
    const { x, y } = toPage(rect, e);
    const size = state.settings.tools.text.width;
    startTextEdit(pg, null, x, Math.max(0, y - size * 0.6));
  }

  // ---- gestos táctiles: pellizco para zoom y desplazamiento con dos dedos
  function touchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function touchMid(a, b) {
    const r = el.viewer.getBoundingClientRect();
    return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top };
  }

  function onTouchStart(e) {
    if (e.touches.length >= 2) {
      if (action && action.pointerType === 'pen') { e.preventDefault(); return; }
      if (action) abortAction();
      if (editing) endEditing();
      tap = null;
      e.preventDefault();
      const [a, b] = e.touches;
      const c = touchMid(a, b);
      pinch = {
        d0: touchDist(a, b), c0: c, c, k: 1,
        zoom0: state.zoom,
        P: { x: el.viewer.scrollLeft + c.x, y: el.viewer.scrollTop + c.y },
      };
      return;
    }
    const t = e.changedTouches[0];
    const stylus = t && t.touchType === 'stylus';
    if (action || captureTouch) { e.preventDefault(); captureTouch = false; return; }
    if (stylus && DRAW_TOOLS.has(state.settings.tool)) e.preventDefault();
  }

  function onTouchMove(e) {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const zoom = clamp(pinch.zoom0 * (touchDist(a, b) / pinch.d0), MIN_ZOOM, MAX_ZOOM);
      pinch.k = zoom / pinch.zoom0;
      pinch.c = touchMid(a, b);
      const tx = pinch.c.x + el.viewer.scrollLeft - pinch.P.x * pinch.k;
      const ty = pinch.c.y + el.viewer.scrollTop - pinch.P.y * pinch.k;
      el.pages.style.transform = `translate(${tx}px, ${ty}px) scale(${pinch.k})`;
      return;
    }
    if (action) e.preventDefault();
  }

  function onTouchEnd(e) {
    if (pinch && e.touches.length < 2) {
      const p = pinch;
      pinch = null;
      el.pages.style.transform = '';
      zoomAround(p.zoom0 * p.k, p.P, p.c);
    }
  }

  // ================================================================ EXPORTAR
  async function buildAnnotatedPdf() {
    const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode } = PDFLib;
    const doc = await PDFDocument.load(state.bytes.slice(0), { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const color = (hex) => rgb(...hexToRgb01(hex));
    const encodable = (s) => {
      let out = '';
      for (const ch of s.replace(/\t/g, '    ')) {
        try { font.encodeText(ch); out += ch; } catch (_) { out += '?'; }
      }
      return out;
    };

    for (const [key, items] of Object.entries(state.annots)) {
      const idx = +key;
      const pg = state.pages[idx];
      const page = pages[idx];
      if (!pg || !page || !items.length) continue;
      const inv = invertMatrix(pg.transform);
      const toU = (x, y) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];
      const S = (x, y) => { const [u, v] = toU(x, y); return r2(u) + ' ' + r2(-v); };
      const textAngle = (Math.atan2(inv[1], inv[0]) * 180) / Math.PI;

      const ordered = [...items.filter((i) => i.tool === 'highlighter'), ...items.filter((i) => i.tool !== 'highlighter')];
      for (const it of ordered) {
        if (it.type === 'ink') {
          const hl = it.tool === 'highlighter';
          const opts = { x: 0, y: 0, borderColor: color(it.color), borderLineCap: LineCapStyle.Round };
          if (hl) { opts.borderOpacity = HL_ALPHA; opts.blendMode = BlendMode.Multiply; }
          const P = it.points;
          const n = P.length / 3;
          if (n === 1) {
            const [u, v] = toU(P[0], P[1]);
            const w = it.width * (it.pressure ? pressureFactor(P[2]) : 1);
            page.drawCircle({ x: u, y: v, size: w / 2, color: color(it.color), opacity: hl ? HL_ALPHA : 1 });
            continue;
          }
          if (!it.pressure) {
            let d = 'M ' + S(P[0], P[1]);
            for (let i = 1; i < n - 1; i++) {
              const x = P[i * 3], y = P[i * 3 + 1];
              d += ' Q ' + S(x, y) + ' ' + S((x + P[i * 3 + 3]) / 2, (y + P[i * 3 + 4]) / 2);
            }
            d += ' L ' + S(P[(n - 1) * 3], P[(n - 1) * 3 + 1]);
            page.drawSvgPath(d, { ...opts, borderWidth: it.width });
          } else {
            // Trazo con presión: se agrupan segmentos con grosor similar.
            let px = P[0], py = P[1];
            let curW = null, d = '';
            const flush = () => { if (d) page.drawSvgPath(d, { ...opts, borderWidth: curW }); d = ''; };
            for (let i = 1; i < n; i++) {
              const x = P[i * 3], y = P[i * 3 + 1];
              const w = Math.max(0.2, Math.round(it.width * pressureFactor(P[i * 3 + 2]) * 4) / 4);
              if (w !== curW) { flush(); curW = w; d = 'M ' + S(px, py); }
              if (i < n - 1) {
                const ex = (x + P[i * 3 + 3]) / 2, ey = (y + P[i * 3 + 4]) / 2;
                d += ' Q ' + S(x, y) + ' ' + S(ex, ey);
                px = ex; py = ey;
              } else {
                d += ' L ' + S(x, y);
              }
            }
            flush();
          }
        } else if (it.type === 'shape') {
          let d = '';
          for (const poly of shapePolys(it)) {
            d += ' M ' + S(poly[0][0], poly[0][1]);
            for (let i = 1; i < poly.length; i++) d += ' L ' + S(poly[i][0], poly[i][1]);
          }
          page.drawSvgPath(d.trim(), { x: 0, y: 0, borderColor: color(it.color), borderWidth: it.width, borderLineCap: LineCapStyle.Round });
        } else if (it.type === 'text') {
          const lines = it.text.split('\n');
          lines.forEach((line, i) => {
            if (!line.trim()) return;
            const [u, v] = toU(it.x, it.y + it.size * (TEXT_BASELINE + 1.2 * i));
            page.drawText(encodable(line), { x: u, y: v, size: it.size, font, color: color(it.color), rotate: degrees(textAngle) });
          });
        }
      }
    }
    return doc.save();
  }

  async function exportPdf() {
    endEditing();
    await flushSave();
    busy(true, 'Generando PDF…');
    let bytes;
    try {
      bytes = await buildAnnotatedPdf();
    } catch (e) {
      console.error(e);
      busy(false);
      toast('No se pudo generar el PDF: ' + (e.message || e));
      return;
    }
    busy(false);
    const name = state.doc.name.replace(/[\\/:*?"<>|]+/g, '-') + ' (anotado).pdf';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    let file = null;
    try { file = new File([blob], name, { type: 'application/pdf' }); } catch (_) { /* Safari antiguo */ }
    const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const choice = await dialog({
      title: 'PDF listo',
      html: `<p>Se ha generado <b>${escapeHtml(name)}</b> (${fmtSize(blob.size)}) con todas tus anotaciones.</p>
             <p class="muted">${canShare ? 'Con <b>Compartir</b> puedes guardarlo en Archivos, enviarlo por correo, AirDrop, etc.' : ''}</p>`,
      buttons: [
        { label: 'Cerrar', value: null },
        { label: 'Descargar', value: 'download' },
        ...(canShare ? [{ label: 'Compartir', value: 'share', cls: 'primary' }] : []),
      ],
    });
    if (choice === 'share') {
      try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') downloadBlob(blob, name); }
    } else if (choice === 'download') {
      downloadBlob(blob, name);
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ================================================================ MENÚ "MÁS"
  async function addBlankPage() {
    endEditing();
    await flushSave();
    busy(true, 'Añadiendo página…');
    try {
      const { PDFDocument } = PDFLib;
      const doc = await PDFDocument.load(state.bytes.slice(0), { ignoreEncryption: true });
      const last = doc.getPages()[doc.getPageCount() - 1];
      const { width, height } = last ? last.getSize() : { width: 595.28, height: 841.89 };
      doc.addPage([width, height]);
      const out = await doc.save();
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      await DB.put('files', buf, state.doc.id);
      state.doc.size = buf.byteLength;
      await DB.put('docs', state.doc);
      const id = state.doc.id;
      const newIndex = state.pages.length;
      busy(false);
      await openDoc(id, { keepHistory: true, zoom: state.zoom, page: newIndex });
      toast('Página añadida al final');
    } catch (e) {
      console.error(e);
      busy(false);
      toast('No se pudo añadir la página (el PDF puede estar protegido)');
    }
  }

  function showHelp() {
    dialog({
      title: 'Ayuda y gestos',
      html: `<ul>
        <li><b>Bolígrafo / Subrayador:</b> dibuja con el Apple Pencil o con el dedo. El bolígrafo es sensible a la presión del lápiz.</li>
        <li><b>Solo lápiz:</b> si está activado, el dedo desplaza la página y solo el Apple Pencil dibuja (evita marcas con la palma). Desactívalo para dibujar con el dedo.</li>
        <li><b>Dos dedos:</b> pellizca para hacer zoom y arrastra para moverte, con cualquier herramienta.</li>
        <li><b>Texto:</b> toca donde quieras escribir. Toca un texto existente para editarlo. Ajusta el tamaño con el control deslizante.</li>
        <li><b>Selección:</b> toca una anotación para seleccionarla; arrástrala para moverla, cambia su color o elimínala/duplícala.</li>
        <li><b>Borrador:</b> pasa por encima de un trazo, forma o texto para borrarlo.</li>
        <li><b>Exportar:</b> crea un PDF con las anotaciones incrustadas para compartir o guardar en Archivos.</li>
        <li>Todo se guarda automáticamente en el iPad.</li>
      </ul>`,
    });
  }

  function toggleMenu(show) {
    const m = el.moreMenu;
    if (show === undefined) show = m.hidden;
    if (!show) { m.hidden = true; return; }
    const r = $('#btnMore').getBoundingClientRect();
    m.hidden = false;
    m.style.top = r.bottom + 6 + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
  }

  async function onMenuAction(act) {
    toggleMenu(false);
    if (act === 'addPage') addBlankPage();
    else if (act === 'clearPage') {
      const idx = currentPageIndex();
      if (!(state.annots[idx] || []).length) { toast('Esta página no tiene anotaciones'); return; }
      endEditing();
      commit(idx, []);
      toast(`Anotaciones de la página ${idx + 1} borradas (puedes deshacer)`);
    } else if (act === 'rename') {
      const name = await promptText('Renombrar documento', state.doc.name);
      if (name) {
        state.doc.name = name;
        el.docTitle.textContent = name;
        DB.put('docs', state.doc);
      }
    } else if (act === 'help') showHelp();
  }

  async function goToPage() {
    const v = await dialog({
      title: 'Ir a la página',
      html: `<input type="number" id="dlgInput" min="1" max="${state.pages.length}" value="${currentPageIndex() + 1}">`,
      buttons: [{ label: 'Cancelar', value: null }, { label: 'Ir', cls: 'primary', value: () => $('#dlgInput').value }],
      onOpen: () => { const i = $('#dlgInput'); i.focus(); i.select(); },
    });
    const n = parseInt(v, 10);
    if (!n) return;
    const pg = state.pages[clamp(n, 1, state.pages.length) - 1];
    el.viewer.scrollTop = pg.el.offsetTop - 8;
  }

  // ================================================================ EVENTOS
  function bindEvents() {
    el.fileInput.addEventListener('change', () => {
      const files = [...el.fileInput.files];
      el.fileInput.value = '';
      importFiles(files);
    });
    $('#btnNewNotebook').addEventListener('click', newNotebook);

    $('#btnBack').addEventListener('click', closeReader);
    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);
    $('#btnZoomIn').addEventListener('click', () => zoomCentered(state.zoom * 1.25));
    $('#btnZoomOut').addEventListener('click', () => zoomCentered(state.zoom / 1.25));
    el.zoomLabel.addEventListener('click', () => zoomCentered(1));
    el.pageLabel.addEventListener('click', goToPage);
    $('#btnExport').addEventListener('click', exportPdf);
    $('#btnMore').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    el.moreMenu.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-action]');
      if (b) onMenuAction(b.dataset.action);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!el.moreMenu.hidden && !el.moreMenu.contains(e.target) && !e.target.closest('#btnMore')) toggleMenu(false);
    });

    $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $$('.kind').forEach((b) => b.addEventListener('click', () => {
      state.settings.shapeKind = b.dataset.kind;
      saveSettings();
      renderOptions();
    }));
    el.customColor.addEventListener('input', () => applyColorLive(el.customColor.value));
    el.customColor.addEventListener('change', () => applyColor(el.customColor.value));
    el.widthRange.addEventListener('input', () => {
      const ts = toolSettings();
      if (!ts) return;
      ts.width = parseFloat(el.widthRange.value);
      updateWidthPreview();
      if (editing && state.settings.tool === 'text') {
        editing.size = ts.width;
        editing.el.style.fontSize = ts.width * state.scale + 'px';
      }
    });
    el.widthRange.addEventListener('change', saveSettings);
    el.btnPencilOnly.addEventListener('click', () => {
      state.settings.pencilOnly = !state.settings.pencilOnly;
      state.settings.penDetected = true; // no volver a activarlo automáticamente
      saveSettings();
      updateTouchAction();
      toast(state.settings.pencilOnly
        ? 'Solo lápiz: el dedo desplaza, el Apple Pencil dibuja'
        : 'Dedo y lápiz dibujan. Usa dos dedos para moverte y hacer zoom.');
    });
    $('#btnSelDel').addEventListener('click', deleteSelection);
    $('#btnSelDup').addEventListener('click', duplicateSelection);
    el.btnSelEdit.addEventListener('click', () => {
      if (!state.sel) return;
      const it = findItem(state.sel.page, state.sel.id);
      const pg = state.pages[state.sel.page];
      if (!it || it.type !== 'text') return;
      setTool('text');
      startTextEdit(pg, it);
    });

    // Entrada en las páginas
    el.pages.addEventListener('pointerdown', onPointerDown);
    el.pages.addEventListener('pointermove', onPointerMove);
    el.pages.addEventListener('pointerup', onPointerUp);
    el.pages.addEventListener('pointercancel', onPointerUp);
    el.pages.addEventListener('lostpointercapture', (e) => {
      if (action && e.pointerId === action.pointerId) finishAction(false);
    });
    el.viewer.addEventListener('touchstart', onTouchStart, { passive: false });
    el.viewer.addEventListener('touchmove', onTouchMove, { passive: false });
    el.viewer.addEventListener('touchend', onTouchEnd);
    el.viewer.addEventListener('touchcancel', onTouchEnd);
    // Evita el zoom nativo de Safari.
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => { if (!e.target.closest('.tbox')) e.preventDefault(); });

    // Zoom con trackpad / Ctrl + rueda (Mac, iPad con trackpad)
    el.viewer.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.viewer.getBoundingClientRect();
      const c = { x: e.clientX - r.left, y: e.clientY - r.top };
      zoomAround(state.zoom * Math.exp(-e.deltaY * 0.01), { x: el.viewer.scrollLeft + c.x, y: el.viewer.scrollTop + c.y }, c);
    }, { passive: false });

    let scrollRaf = 0;
    el.viewer.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        updatePageLabel();
        saveViewStateSoon();
      });
    }, { passive: true });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.pages.length) zoomCentered(state.zoom); }, 150);
    });

    document.addEventListener('keydown', (e) => {
      if (el.reader.hidden || editing || !$('#dialog').hidden) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) { e.preventDefault(); deleteSelection(); }
      else if (!mod) {
        const map = { h: 'pan', v: 'select', p: 'pen', m: 'highlighter', e: 'eraser', t: 'text', s: 'shape' };
        if (map[e.key]) setTool(map[e.key]);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { endEditingSafe(); flushSave(); saveViewState(); }
    });
    window.addEventListener('pagehide', () => { flushSave(); saveViewState(); });
  }

  function endEditingSafe() { try { endEditing(); } catch (e) { console.error(e); } }

  function applyColorLive(c) {
    const t = state.settings.tool;
    if (t === 'select') return;
    state.settings.tools[t].color = c;
    updateWidthPreview();
    if (editing) { editing.color = c; editing.el.style.color = c; }
  }

  // ================================================================ INICIO
  async function init() {
    try {
      await DB.open();
    } catch (e) {
      console.error(e);
      toast('No se puede acceder al almacenamiento del navegador. Sal del modo privado.', 8000);
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    bindEvents();
    setTool(state.settings.tool);
    updateTouchAction();
    await refreshLibrary();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
    }
  }

  // Exponer para pruebas automatizadas
  window.__anota = { state, openDoc, buildAnnotatedPdf, commit, setTool };

  init();
})();
