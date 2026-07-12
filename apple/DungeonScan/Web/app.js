/*
 * DungeonScan app controller. Import photo → lock grid → read (digitize) →
 * correct → export clean battle map + Universal VTT. Runs the proven DS.* core.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MAXDIM = 1600;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const S = {
    img: null, work: null, w: 0, h: 0,      // work = offscreen canvas at working res
    gray: null,
    grid: { s: 40, ox: 0, oy: 0, C: 10, R: 10 },
    walls: null, floor: null, doors: [], features: [],
    tool: 'wall', style: 'stone', ppg: 80, notes: '',
    history: [], redo: [], step: 1, dragVal: null,
    // map look
    floorTexture: 'flat', wallStyle: 'solid',
    // read tuning
    lineSensitivity: 0.5, invertPaper: false,
    // stage view: false = editable detection overlay, true = live styled-map preview
    preview: false,
    // symbol stamps: {id,x,y,size,rotation,color,label}  (x,y normalized over grid content box)
    stamps: [], selStamp: null, dragStamp: false, dragOff: null,
    // room-box drag preview
    boxStart: null, boxCur: null,
    // hex mode ('square' is the default; everything above is the square flow)
    mode: 'square',                 // 'square' | 'hex'
    hexGrid: null,                  // {size,ox,oy,cols,rows} in source-image pixels
    terrain: new Map(),             // "col,row" -> terrainId  (painted hexes)
    hexTerrain: 'plains',           // currently selected terrain brush (or 'erase')
    hexStyle: 'parchment',          // HEX_STYLES key for export
    hexReady: false,                // hex mode: step-3 "Start painting" has been clicked
    // export options (step 5)
    showLegend: false,              // draw a stamp legend onto saved maps
    gridOnExport: true,             // draw the square grid on saved maps
    gridColor: '',                  // '' = use the style palette colour; else a hex override
    gridOpacity: null,              // null = palette default; else 0..1 override
    projectName: '',                // last saved/loaded .dungeonscan filename (no ext)
    // perspective 4-corner straighten (step 2): null off, or 4 {x,y} in image px
    corners: null,                  // [{x,y}×4] TL,TR,BR,BL while perspActive
    perspActive: false,
    dragCorner: null                // index of the corner being dragged, or null
  };

  const view = $('view'), vctx = view.getContext('2d');

  // ---------- image load ----------
  function loadDataUrl(dataUrl, name) {
    const img = new Image();
    img.onload = () => setupImage(img, name);
    img.onerror = () => setStatus('Could not read that image — try a PNG or JPG.');
    img.src = dataUrl;
  }
  // Ingest a dropped File — an image loads directly; a PDF (e.g. exported from a
  // drawing app) is rasterized to PNG by the native layer first.
  function ingestFile(f) {
    if (!f) return;
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    const rd = new FileReader();
    rd.onload = async () => {
      if (isPdf) {
        setStatus('Reading your PDF…');
        const png = await DSBridge.rasterizePdf(rd.result);
        if (png) loadDataUrl(png, f.name);
        else setStatus('PDFs open inside the app — in a browser, export a PNG instead.');
      } else {
        loadDataUrl(rd.result, f.name);
      }
    };
    rd.readAsDataURL(f);
  }
  function setupImage(img, name) {
    const scale = Math.min(1, MAXDIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    let work = document.createElement('canvas'); work.width = w; work.height = h;
    work.getContext('2d').drawImage(img, 0, 0, w, h);
    // straighten a slightly-rotated phone photo before anything else
    const de = DS.autoDeskew(work); work = de.canvas; S.deskew = de.angle;
    S.img = img; S.work = work; S.w = work.width; S.h = work.height;
    S.gray = DS.toGray(work.getContext('2d').getImageData(0, 0, w, h));
    S.walls = null; S.floor = null; S.doors = []; S.features = []; S.history = []; S.redo = [];
    S.stamps = []; S.selStamp = null; S.boxStart = S.boxCur = null;
    // a fresh image always returns to the default square-dungeon flow
    S.mode = 'square'; S.hexGrid = null; S.terrain = new Map();
    S.hexReady = false; S.hexTerrain = 'plains';
    // and clears any in-progress perspective / project metadata
    S.corners = null; S.perspActive = false; S.dragCorner = null; S.projectName = '';
    syncModeChrome();
    view.width = w; view.height = h;
    $('drop').classList.add('hidden');
    hideStampBar();
    S.preview = false;
    if ($('stageToggle')) $('stageToggle').classList.add('hidden');   // hidden until a map is read
    autoGrid();
    buildGridControls();
    unlock(2); unlock(3); relock(4); relock(5);
    updateUndoRedoButtons();
    setStatus(name ? `Loaded ${name}. Now line up the grid.` : 'Loaded. Now line up the grid.');
    fitView(); render();
  }
  function fitView() {
    const box = $('stageInner'), pad = 44;
    const availW = box.clientWidth - pad, availH = box.clientHeight - pad;
    const ar = view.width / view.height;
    let dw = availW, dh = dw / ar; if (dh > availH) { dh = availH; dw = dh * ar; }
    view.style.width = Math.max(50, dw) + 'px'; view.style.height = Math.max(50, dh) + 'px';
  }
  function baseName(filename) { return String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''); }
  function clampImg(v, max) { return v < 0 ? 0 : v > max ? max : v; }

  // ---------- project save / reload ----------
  // Snapshot the full working state into the plain object DS.project.serialize
  // understands. terrain stays a Map here (serialize converts it).
  function collectProjectState() {
    return {
      mode: S.mode,
      image: S.work ? S.work.toDataURL('image/png') : null,
      grid: S.grid,
      hexGrid: S.hexGrid,
      walls: S.walls ? { v: S.walls.vEdge.map((r) => [...r]), h: S.walls.hEdge.map((r) => [...r]), C: S.walls.C, R: S.walls.R } : null,
      floor: S.floor ? [...S.floor] : null,
      doors: S.doors, features: S.features, stamps: S.stamps,
      terrain: S.terrain,
      style: S.style, floorTexture: S.floorTexture, wallStyle: S.wallStyle,
      hexStyle: S.hexStyle, hexTerrain: S.hexTerrain, hexReady: S.hexReady,
      ppg: S.ppg, lineSensitivity: S.lineSensitivity, invertPaper: S.invertPaper, deskew: S.deskew,
      showLegend: S.showLegend, gridOnExport: S.gridOnExport, gridColor: S.gridColor, gridOpacity: S.gridOpacity
    };
  }
  async function saveProject() {
    if (!S.work) { setStatus('Add a photo before saving a project.'); return; }
    setStatus('Saving project…');
    try {
      const text = DS.project.serialize(collectProjectState());
      const suggested = (S.projectName || 'dungeon') + '.dungeonscan';
      const r = await DSBridge.saveFile({ kind: 'dungeonscan', suggestedName: suggested, text });
      if (r && r.ok) { S.projectName = baseName(suggested); setStatus('Saved project.'); }
      saveNote(r, 'project (.dungeonscan)');
    } catch (e) { saveNote({ ok: false }, (e && e.message) || 'project save failed'); }
  }
  async function openProjectFile() {
    setStatus('Pick a .dungeonscan project to open…');
    const r = await DSBridge.openProject();
    if (!r || !r.text) { setStatus('Cancelled.'); return; }
    try {
      const proj = DS.project.deserialize(r.text);
      proj.name = r.name || '';
      S.projectName = baseName(proj.name);
      applyProject(proj);
    } catch (e) {
      setStatus('Could not open that project — ' + ((e && e.message) || 'invalid file.'));
    }
  }
  // Restore a deserialized project: rebuild the work canvas from its embedded
  // image (NO deskew — the saved image is already corrected), then re-seat every
  // editable field and rebuild the UI for the restored mode.
  function applyProject(proj) {
    if (!proj.image) { setStatus('Project has no image.'); return; }
    setStatus('Opening project…');
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAXDIM / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const work = document.createElement('canvas'); work.width = w; work.height = h;
      work.getContext('2d').drawImage(img, 0, 0, w, h);
      S.img = img; S.work = work; S.w = w; S.h = h;
      S.gray = DS.toGray(work.getContext('2d').getImageData(0, 0, w, h));
      // editable state
      S.mode = proj.mode || 'square';
      S.grid = proj.grid || S.grid;
      S.hexGrid = proj.hexGrid || null;
      S.walls = proj.walls ? { vEdge: proj.walls.v.map((r) => Uint8Array.from(r)), hEdge: proj.walls.h.map((r) => Uint8Array.from(r)), C: proj.walls.C, R: proj.walls.R } : null;
      S.floor = proj.floor ? Uint8Array.from(proj.floor) : null;
      S.doors = proj.doors || []; S.features = proj.features || []; S.stamps = proj.stamps || [];
      S.terrain = proj.terrain instanceof Map ? proj.terrain : new Map();
      S.style = proj.style || 'stone'; S.floorTexture = proj.floorTexture || 'flat'; S.wallStyle = proj.wallStyle || 'solid';
      S.hexStyle = proj.hexStyle || 'parchment'; S.hexTerrain = proj.hexTerrain || 'plains'; S.hexReady = !!proj.hexReady;
      S.ppg = proj.ppg || 80;
      S.lineSensitivity = proj.lineSensitivity != null ? proj.lineSensitivity : 0.5;
      S.invertPaper = !!proj.invertPaper; S.deskew = proj.deskew || 0;
      S.showLegend = !!proj.showLegend; S.gridOnExport = proj.gridOnExport !== false;
      S.gridColor = proj.gridColor || ''; S.gridOpacity = proj.gridOpacity != null ? proj.gridOpacity : null;
      S.history = []; S.redo = []; S.selStamp = null; S.boxStart = S.boxCur = null;
      S.corners = null; S.perspActive = false; S.dragCorner = null;
      // rebuild the UI for whatever mode the project was saved in
      view.width = w; view.height = h;
      $('drop').classList.add('hidden');
      hideStampBar(); hidePerspectiveBar();
      if (S.mode === 'hex') buildHexGridControls(); else buildGridControls();
      reflectMode();
      unlock(2); unlock(3);
      if (S.mode === 'hex') { if (S.hexReady) { unlock(4); unlock(5); } else { relock(4); relock(5); } }
      else { if (S.walls) { unlock(4); unlock(5); } else { relock(4); relock(5); } }
      updateUndoRedoButtons();
      setStatus(`Opened ${proj.name || 'project'}.`);
      fitView(); render();
    };
    img.onerror = () => setStatus('Could not read the project image.');
    img.src = proj.image;
  }

  // ---------- perspective 4-corner straighten (step 2) ----------
  function cornerRadius() { return Math.max(12, Math.round(Math.min(S.w, S.h) * 0.022)); }
  function cornerAt(ix, iy) {
    if (!S.corners) return -1;
    const r = cornerRadius(), r2 = r * r;
    for (let i = S.corners.length - 1; i >= 0; i--) {
      const c = S.corners[i];
      if ((ix - c.x) * (ix - c.x) + (iy - c.y) * (iy - c.y) <= r2) return i;
    }
    return -1;
  }
  function togglePerspective(force) {
    if (!S.work) { setStatus('Add a photo first.'); return; }
    const next = force != null ? force : !S.perspActive;
    if (next === S.perspActive) return;
    S.perspActive = next;
    if (next) {
      // seed the 4 corners from a best-effort page detect, clamped to the image
      const detected = DS.perspective.autoDetectPage(S.work);
      S.corners = detected.map((p) => ({ x: clampImg(p.x, S.w), y: clampImg(p.y, S.h) }));
      S.dragCorner = null;
      showPerspectiveBar();
      setStatus('Drag the 4 corners to your paper, then Apply.');
    } else {
      S.corners = null; S.dragCorner = null;
      hidePerspectiveBar();
      setStatus('Straighten cancelled.');
    }
    render();
  }
  async function applyPerspective() {
    if (!S.work || !S.corners) return;
    setStatus('Straightening…');
    await new Promise((r) => setTimeout(r, 20));
    try {
      const fixed = DS.perspective.correct(S.work, S.corners);
      // re-run deskew + grayscale + grid re-estimate on the de-warped image
      const de = DS.autoDeskew(fixed); const work = de.canvas; S.deskew = de.angle;
      S.work = work; S.w = work.width; S.h = work.height;
      S.gray = DS.toGray(work.getContext('2d').getImageData(0, 0, S.w, S.h));
      view.width = S.w; view.height = S.h;
      autoGrid(); buildGridControls();
      if (S.walls) { S.walls = null; S.floor = null; relock(4); relock(5); } // grid moved → must re-read
    } catch (e) {
      setStatus('Straighten failed — try adjusting the corners.');
    }
    S.corners = null; S.perspActive = false; S.dragCorner = null;
    hidePerspectiveBar();
    fitView(); render();
    setStatus('Straightened — re-line the grid if it shifted.');
  }
  function drawPerspectiveOverlay() {
    if (!S.perspActive || !S.corners) return;
    const cs = S.corners, r = cornerRadius();
    vctx.save();
    tracePts(vctx, cs);                              // quad fill + outline
    vctx.fillStyle = 'rgba(63,138,224,0.14)'; vctx.fill();
    vctx.strokeStyle = 'rgba(63,138,224,0.95)'; vctx.lineWidth = Math.max(2, r * 0.18); vctx.stroke();
    vctx.restore();
    for (let i = 0; i < cs.length; i++) {            // 4 draggable handles
      vctx.save();
      vctx.fillStyle = '#fff'; vctx.strokeStyle = 'rgba(63,138,224,1)'; vctx.lineWidth = Math.max(2, r * 0.16);
      vctx.beginPath(); vctx.arc(cs[i].x, cs[i].y, r, 0, Math.PI * 2); vctx.fill(); vctx.stroke();
      vctx.restore();
    }
  }
  function buildPerspectiveBar() {
    if ($('perspBar')) return;
    const bar = document.createElement('div');
    bar.id = 'perspBar'; bar.className = 'perspbar hidden';
    bar.innerHTML = '<span class="ps-l">Drag the 4 corners to the paper</span>'
      + '<div class="ps-btns">'
      + '<button id="psApply" type="button" class="ps-apply">' + DS.icon('check') + ' Apply straighten</button>'
      + '<button id="psCancel" type="button">' + DS.icon('x') + ' Cancel</button>'
      + '</div>';
    $('stageInner').appendChild(bar);
    $('psApply').addEventListener('click', applyPerspective);
    $('psCancel').addEventListener('click', () => togglePerspective(false));
  }
  function showPerspectiveBar() { if ($('perspBar')) $('perspBar').classList.remove('hidden'); }
  function hidePerspectiveBar() { if ($('perspBar')) $('perspBar').classList.add('hidden'); }

  // ---------- hex: auto-read terrain from the photo via CoreML ----------
  async function readHexTerrain() {
    if (!S.hexGrid || !S.work) return;
    const caps = S.caps || await DSBridge.capabilities();
    if (!caps.terrain && !caps.classify) { setStatus('Terrain model not available in this build.'); return; }
    const btn = $('btn-hexterrain'); if (btn) btn.disabled = true;
    pushHistory();
    setStatus('Reading terrain from the photo…');
    await new Promise((r) => setTimeout(r, 20));
    const g = S.hexGrid, cells = [];
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) cells.push({ col: c, row: r });
    // crop each hex's bounding box (DS.hex.hexBBox) to a 64×64 dataURL
    const crops = cells.map((cell) => {
      const b = DS.hex.hexBBox(cell.col, cell.row, g);
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      cv.getContext('2d').drawImage(S.work, b.x, b.y, b.w, b.h, 0, 0, 64, 64);
      return cv.toDataURL('image/png');
    });
    let painted = 0;
    try {
      const labels = await DSBridge.classify(crops, 'TerrainClassifier');
      cells.forEach((cell, i) => {
        const L = labels[i]; if (!L || L.confidence < 0.5) return;
        const id = L.label;
        if (!DS.hex.TERRAIN_BY_ID[id]) return;        // ignore unknown labels
        S.terrain.set(cell.col + ',' + cell.row, id); painted++;
      });
    } catch (_) { setStatus('Terrain read failed this time.'); }
    if (btn) btn.disabled = false;
    setStatus(painted ? `Painted ${painted} hexes — brush-correct any in step 4.`
      : 'No confident terrain found — paint it by hand in step 4.');
    render();
  }

  // ---------- square: auto-number rooms ----------
  function numberRoomsAction() {
    if (S.mode !== 'square' || !S.walls || !S.floor) { setStatus('Read the dungeon first.'); return; }
    pushHistory();
    const nums = DS.numberRooms(S.walls, S.floor, S.grid.C, S.grid.R);
    // keep non-number features, replace the auto-numbers
    S.features = S.features.filter((f) => f.kind !== 'number').concat(nums);
    setStatus(nums.length ? `Numbered ${nums.length} rooms.` : 'No enclosed rooms found — mark some floor first.');
    render();
  }


  // ---------- grid ----------
  function autoGrid() {
    const est = DS.estimateGrid(S.gray, S.w, S.h);
    S.grid = { s: est.s, ox: est.ox, oy: est.oy, C: est.C, R: est.R };
    recomputeCR();
  }
  function recomputeCR() {
    S.grid.C = Math.max(1, Math.floor((S.w - S.grid.ox) / S.grid.s));
    S.grid.R = Math.max(1, Math.floor((S.h - S.grid.oy) / S.grid.s));
  }
  function buildGridControls() {
    const el = $('gridControls'); el.innerHTML = '';
    const mk = (id, label, min, max, step, val, fmt) => {
      const w = document.createElement('div'); w.className = 'ctl';
      w.innerHTML = `<label><span>${label}</span><span class="v" id="gv-${id}">${fmt(val)}</span></label>`;
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      inp.addEventListener('input', () => {
        S.grid[id === 'cell' ? 's' : id] = Number(inp.value);
        recomputeCR(); $(`gv-${id}`).textContent = fmt(Number(inp.value));
        if (S.walls) { S.walls = null; S.floor = null; relock(4); relock(5); } // grid changed → must re-read
        render();
      });
      w.appendChild(inp); el.appendChild(w); return inp;
    };
    mk('cell', 'Square size', 12, Math.round(Math.min(S.w, S.h) / 4), 1, S.grid.s, (v) => v + 'px');
    mk('ox', 'Nudge sideways', 0, Math.max(2, Math.round(S.grid.s)), 1, S.grid.ox, (v) => v + 'px');
    mk('oy', 'Nudge up/down', 0, Math.max(2, Math.round(S.grid.s)), 1, S.grid.oy, (v) => v + 'px');
  }

  // ---------- hex grid ----------
  function recomputeHexCR() {
    const g = S.hexGrid; if (!g) return;
    const width = DS.hex.SQ3 * g.size;
    g.cols = Math.max(1, Math.floor((S.w - g.ox) / width) + 1);
    g.rows = Math.max(1, Math.floor((S.h - g.oy) / (1.5 * g.size)) + 1);
  }
  function buildHexGridControls() {
    const el = $('gridControls'); el.innerHTML = '';
    const g = S.hexGrid;
    const mk = (id, label, min, max, step, val, fmt) => {
      const w = document.createElement('div'); w.className = 'ctl';
      w.innerHTML = `<label><span>${label}</span><span class="v" id="hv-${id}">${fmt(val)}</span></label>`;
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      inp.addEventListener('input', () => {
        S.hexGrid[id] = Number(inp.value);
        recomputeHexCR(); $(`hv-${id}`).textContent = fmt(Number(inp.value));
        render();
      });
      w.appendChild(inp); el.appendChild(w);
    };
    mk('size', 'Hex size', 8, Math.max(10, Math.round(Math.min(S.w, S.h) / 3)), 1, g.size, (v) => v + 'px');
    mk('ox', 'Nudge sideways', 0, Math.max(2, S.w), 1, g.ox, (v) => v + 'px');
    mk('oy', 'Nudge up/down', 0, Math.max(2, S.h), 1, g.oy, (v) => v + 'px');
  }

  // ---------- mode switching ----------
  function syncModeChrome() {
    document.querySelectorAll('#modeToggle .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('btn-read').innerHTML = S.mode === 'hex' ? (DS.icon('floor') + ' Start painting') : (DS.icon('scan') + ' Read my dungeon');
    $('readTuning').classList.toggle('hidden', S.mode === 'hex');
    $('gridHint').textContent = S.mode === 'hex'
      ? 'Line up the hexes over your map. Auto-detect gives a starting point — nudge to fit.'
      : 'Get the blue grid sitting right on top of the squares you drew. Auto-detect usually nails it.';
  }
  // rebuild the step-4 palette + step-5 controls for the active mode
  function reflectMode() {
    syncModeChrome();
    if (S.mode === 'hex') buildHexTools(); else buildTools();
    buildExportControls();
    reflectFeatureButtons();
  }
  // Show the hex "Read terrain" button only in hex mode w/ a model, and the
  // square "Number rooms" button only in square mode.
  function reflectFeatureButtons() {
    const hexBtn = $('btn-hexterrain'), numBtn = $('btn-number');
    const terrainOk = !!(S.caps && (S.caps.terrain || S.caps.classify));
    if (hexBtn) hexBtn.classList.toggle('hidden', !(S.mode === 'hex' && terrainOk));
    if (numBtn) numBtn.classList.toggle('hidden', S.mode !== 'square');
  }
  function syncStepGating() {
    unlock(3);
    if (S.mode === 'hex') { if (S.hexReady) { unlock(4); unlock(5); } else { relock(4); relock(5); } }
    else { if (S.walls) { unlock(4); unlock(5); } else { relock(4); relock(5); } }
  }
  function setMode(mode) {
    if (mode === S.mode) return;
    if (mode === 'hex' && !S.gray) { setStatus('Add a photo first, then switch to hex.'); return; }
    S.mode = mode;
    if (mode === 'hex') {
      if (!S.hexGrid) { S.hexGrid = DS.hex.estimateHexGrid(S.gray, S.w, S.h); recomputeHexCR(); }
      buildHexGridControls();
    } else {
      buildGridControls();
    }
    syncStepGating();
    reflectMode();
    render();
    setStatus(mode === 'hex' ? 'Hex mode — line up the hexes, then Start painting.' : 'Square dungeon mode.');
  }
  // gate that says "editing is allowed right now" for whichever mode is active
  function editReady() { return S.mode === 'square' ? !!S.walls : !!S.hexReady; }

  // ---------- shared geometry helpers (work in both modes) ----------
  function tracePts(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function withAlpha(hex, a) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // bounding box of the editable region in SOURCE pixels — square grid box, or
  // the tight bounds of every hex polygon. Stamps are normalized 0..1 over it.
  function contentBox() {
    if (S.mode === 'hex') return hexContentBox();
    const { C, R, s, ox, oy } = S.grid;
    return { ox, oy, W: C * s, H: R * s };
  }
  function hexContentBox() {
    const g = S.hexGrid;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      for (const p of DS.hex.hexPolygon(c, r, g)) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!Number.isFinite(minX)) return { ox: 0, oy: 0, W: S.w, H: S.h };
    return { ox: minX, oy: minY, W: Math.max(1, maxX - minX), H: Math.max(1, maxY - minY) };
  }

  // ---------- read (digitize) ----------
  // Returns the grayscale source for wall detection — inverted when the user has
  // white-ink-on-dark-paper so "ink" is still the dark value the detector expects.
  function readGray() {
    if (!S.invertPaper) return S.gray;
    const g = new Uint8Array(S.gray.length);
    for (let i = 0; i < S.gray.length; i++) g[i] = 255 - S.gray[i];
    return g;
  }
  // Line-sensitivity (0..1) → detectWalls opts. Higher = lower threshold = picks
  // up fainter lines.
  function sensOpts() {
    const t = S.lineSensitivity;
    return { thrScale: 1.2 - 0.56 * t, minInk: Math.max(5, Math.round(85 - 90 * t)) };
  }
  function sensLabel(t) {
    return t < 0.25 ? 'strict' : t < 0.45 ? 'clean' : t < 0.65 ? 'balanced' : t < 0.85 ? 'sensitive' : 'faint lines';
  }

  async function readDungeon() {
    if (!S.gray) return;
    setStatus('Reading your dungeon…');
    await new Promise((r) => setTimeout(r, 20));
    pushHistory();
    const gray = readGray();
    const walls = DS.detectWalls(gray, S.w, S.h, S.grid, sensOpts());
    S.walls = { vEdge: walls.vEdge.map((r) => Uint8Array.from(r)), hEdge: walls.hEdge.map((r) => Uint8Array.from(r)), C: walls.C, R: walls.R };
    S.floor = DS.detectFloor(S.walls);
    S.doors = DS.detectDoorways(S.walls, S.floor);
    S.features = [];
    // optional on-device enrichment (stairs/water via CoreML, numbers via Vision OCR)
    try { await enrich(gray); } catch (_) {}
    unlock(4); unlock(5); buildTools(); buildExportControls();
    const wc = countWalls(S.walls), fc = S.floor.reduce((a, b) => a + b, 0);
    $('readInfo').innerHTML = `Found <b>${wc}</b> wall segments, <b>${fc}</b> floor squares, <b>${S.doors.length}</b> doorways`
      + (S.features.length ? `, <b>${S.features.length}</b> features` : '') + `.<br>Anything wrong? Fix it in step 4, then save.`;
    setStatus('Read it! Check step 4 to fix anything, then save your map.');
    render();
    showStageToggle();
  }

  async function enrich(gray) {
    const caps = await DSBridge.capabilities();
    // room numbers via OCR
    if (caps.ocr) {
      const res = await DSBridge.ocr(S.work.toDataURL('image/png'));
      for (const t of res || []) {
        if (!/^\d{1,3}$/.test((t.text || '').trim())) continue;
        const cx = (t.box.x + t.box.w / 2) * S.w, cy = (t.box.y + t.box.h / 2) * S.h;
        const col = Math.floor((cx - S.grid.ox) / S.grid.s), row = Math.floor((cy - S.grid.oy) / S.grid.s);
        if (col >= 0 && row >= 0 && col < S.grid.C && row < S.grid.R) S.features.push({ kind: 'number', label: t.text.trim(), col, row });
      }
    }
    // in-cell symbols via CoreML classifier
    if (caps.classify) {
      const cands = candidateCells(gray);
      if (cands.length) {
        const crops = cands.map((c) => cropCell(c.col, c.row));
        const labels = await DSBridge.classify(crops, 'DungeonCellClassifier');
        cands.forEach((c, i) => {
          const L = labels[i]; if (!L || L.confidence < 0.6) return;
          if (['stairs', 'water', 'rubble', 'column', 'statue', 'altar', 'trap', 'chest', 'pit'].includes(L.label))
            S.features.push({ kind: L.label, col: c.col, row: c.row });
        });
      }
    }
  }
  function candidateCells(gray) {
    // floor cells with notable interior ink (likely a symbol, not blank floor)
    const out = [], { s, ox, oy, C, R } = S.grid, m = Math.round(s * 0.22);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (!S.floor[r * C + c]) continue;
      let ink = 0, n = 0;
      for (let y = oy + r * s + m; y < oy + (r + 1) * s - m; y += 2) for (let x = ox + c * s + m; x < ox + (c + 1) * s - m; x += 2) {
        if (x >= 0 && y >= 0 && x < S.w && y < S.h) { ink += 255 - gray[y * S.w + x]; n++; }
      }
      if (n && ink / n > 46) out.push({ col: c, row: r });
    }
    return out;
  }
  function cropCell(col, row) {
    const { s, ox, oy } = S.grid, cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    cv.getContext('2d').drawImage(S.work, ox + col * s, oy + row * s, s, s, 0, 0, 64, 64);
    return cv.toDataURL('image/png');
  }
  function countWalls(w) { let n = 0; for (const r of w.vEdge) for (const v of r) n += v; for (const r of w.hEdge) for (const v of r) n += v; return n; }

  // ---------- correction tools ----------
  const TOOLS = [
    { id: 'wall', ic: 'wall', label: 'Wall' }, { id: 'floor', ic: 'floor', label: 'Room floor' },
    { id: 'roombox', ic: 'room', label: 'Room (box)' }, { id: 'fillroom', ic: 'fill', label: 'Fill room' },
    { id: 'door', ic: 'door', label: 'Door' }, { id: 'erase', ic: 'eraser', label: 'Erase wall' }
  ];
  function buildTools() {
    const el = $('tools'); el.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button'); b.className = 'tool' + (t.id === S.tool ? ' on' : '');
      b.innerHTML = `<span class="ic">${DS.icon(t.ic)}</span> ${t.label}`;
      b.addEventListener('click', () => { S.tool = t.id; buildTools(); updateToolHint(); if (S.preview) setStageMode('edit'); });
      el.appendChild(b);
    }
    updateToolHint();
  }
  function updateToolHint() {
    if (S.mode === 'hex') {
      const t = DS.hex.TERRAIN_BY_ID[S.hexTerrain];
      $('toolHint').textContent = S.hexTerrain === 'erase'
        ? 'Click or drag hexes to clear terrain (right-click also erases).'
        : `Click or drag to paint ${t ? t.name : 'terrain'}. Right-click erases a hex.`;
      return;
    }
    const h = {
      wall: 'Click on a grid line to add a wall; click a wall to remove it.',
      floor: 'Click a square to mark it as room floor (or clear it).',
      roombox: 'Click and drag a box — it becomes a room (floor + outer walls).',
      fillroom: 'Click inside a walled-off area to flood-fill it as floor.',
      door: 'Click on a wall to turn it into a doorway.',
      erase: 'Click a wall to erase it.'
    };
    $('toolHint').textContent = h[S.tool] || '';
  }
  // hex terrain palette: an Erase brush + one colored swatch per terrain
  function buildHexTools() {
    const el = $('tools'); el.innerHTML = '';
    const mk = (label, inner, on, onClick) => {
      const b = document.createElement('button');
      b.className = 'tool' + (on ? ' on' : '');
      b.innerHTML = inner;
      b.addEventListener('click', onClick);
      el.appendChild(b);
    };
    mk('Erase', '<span class="ic">' + DS.icon('eraser') + '</span> Erase', S.hexTerrain === 'erase', () => { S.hexTerrain = 'erase'; buildHexTools(); });
    for (const t of DS.hex.TERRAINS) {
      mk(t.name, `<span class="swatch" style="background:${t.color}"></span> ${t.name}`, S.hexTerrain === t.id, () => { S.hexTerrain = t.id; buildHexTools(); });
    }
    updateToolHint();
  }
  // hex step 3: no wall detection — just unlock painting + export
  function startHexPainting() {
    if (!S.hexGrid) return;
    S.hexReady = true;
    S.features = [];
    unlock(4); unlock(5);
    buildHexTools(); buildExportControls();
    $('readInfo').innerHTML = 'Paint terrain onto the hexes in <b>step 4</b>, then save your hex map in <b>step 5</b>.';
    setStatus('Hex map ready — paint terrain in step 4.');
    render();
    showStageToggle();
  }

  function nearestEdge(ix, iy) {
    const { s, ox, oy, C, R } = S.grid;
    const cf = (ix - ox) / s, rf = (iy - oy) / s;
    const col = Math.floor(cf), row = Math.floor(rf);
    if (col < 0 || row < 0 || col >= C || row >= R) return null;
    const fx = cf - col, fy = rf - row; // 0..1 within cell
    const dLeft = fx, dRight = 1 - fx, dTop = fy, dBot = 1 - fy;
    const m = Math.min(dLeft, dRight, dTop, dBot);
    if (m === dLeft) return { kind: 'v', col, row };
    if (m === dRight) return { kind: 'v', col: col + 1, row };
    if (m === dTop) return { kind: 'h', col, row };
    return { kind: 'h', col, row: row + 1 };
  }
  function cellAt(ix, iy) {
    const { s, ox, oy, C, R } = S.grid;
    const col = Math.floor((ix - ox) / s), row = Math.floor((iy - oy) / s);
    if (col < 0 || row < 0 || col >= C || row >= R) return null;
    return { col, row };
  }
  function getEdge(e) { return e.kind === 'v' ? S.walls.vEdge[e.row][e.col] : S.walls.hEdge[e.row][e.col]; }
  function setEdge(e, v) { if (e.kind === 'v') S.walls.vEdge[e.row][e.col] = v; else S.walls.hEdge[e.row][e.col] = v; }

  // flood the connected (non-walled) region around a seed cell → mark as floor
  function floodFillRoom(seed) {
    const { C, R } = S.grid, v = S.walls.vEdge, h = S.walls.hEdge;
    const seen = new Uint8Array(C * R);
    const stack = [seed.col + seed.row * C]; seen[seed.col + seed.row * C] = 1;
    while (stack.length) {
      const idx = stack.pop(), col = idx % C, row = (idx / C) | 0;
      if (col > 0 && !v[row][col] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
      if (col < C - 1 && !v[row][col + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
      if (row > 0 && !h[row][col] && !seen[idx - C]) { seen[idx - C] = 1; stack.push(idx - C); }
      if (row < R - 1 && !h[row + 1][col] && !seen[idx + C]) { seen[idx + C] = 1; stack.push(idx + C); }
    }
    for (let i = 0; i < seen.length; i++) if (seen[i]) S.floor[i] = 1;
  }

  // commit a dragged rectangle as a room: floor inside, walls on the perimeter
  function commitRoomBox() {
    if (!S.boxStart || !S.boxCur) return;
    const { C } = S.grid;
    const c0 = Math.min(S.boxStart.col, S.boxCur.col), c1 = Math.max(S.boxStart.col, S.boxCur.col);
    const r0 = Math.min(S.boxStart.row, S.boxCur.row), r1 = Math.max(S.boxStart.row, S.boxCur.row);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) S.floor[r * C + c] = 1;
    for (let r = r0; r <= r1; r++) { S.walls.vEdge[r][c0] = 1; S.walls.vEdge[r][c1 + 1] = 1; }
    for (let c = c0; c <= c1; c++) { S.walls.hEdge[r0][c] = 1; S.walls.hEdge[r1 + 1][c] = 1; }
    // any door sitting on the new solid perimeter is no longer an opening
    S.doors = S.doors.filter((d) => !doorOnRect(d, c0, c1, r0, r1));
  }
  function doorOnRect(d, c0, c1, r0, r1) {
    if (d.kind === 'v') return (d.col === c0 || d.col === c1 + 1) && d.row >= r0 && d.row <= r1;
    return (d.row === r0 || d.row === r1 + 1) && d.col >= c0 && d.col <= c1;
  }

  function applyTool(ix, iy, isStart) {
    if (!S.walls) return;
    if (S.tool === 'fillroom') { if (isStart) { const c = cellAt(ix, iy); if (c) floodFillRoom(c); render(); } return; }
    if (S.tool === 'roombox') return; // handled by the pointer drag in commitRoomBox
    if (S.tool === 'floor') {
      const c = cellAt(ix, iy); if (!c) return;
      if (isStart) S.dragVal = S.floor[c.row * S.grid.C + c.col] ? 0 : 1;
      S.floor[c.row * S.grid.C + c.col] = S.dragVal; render(); return;
    }
    const e = nearestEdge(ix, iy); if (!e) return;
    if (S.tool === 'wall') {
      if (isStart) S.dragVal = getEdge(e) ? 0 : 1;
      setEdge(e, S.dragVal);
      // placing/removing a wall clears any door on it
      S.doors = S.doors.filter((d) => !(d.kind === e.kind && d.col === e.col && d.row === e.row));
    } else if (S.tool === 'erase') {
      setEdge(e, 0);
      S.doors = S.doors.filter((d) => !(d.kind === e.kind && d.col === e.col && d.row === e.row));
    } else if (S.tool === 'door') {
      const has = S.doors.some((d) => d.kind === e.kind && d.col === e.col && d.row === e.row);
      if (has) S.doors = S.doors.filter((d) => !(d.kind === e.kind && d.col === e.col && d.row === e.row));
      else { setEdge(e, 1); S.doors.push({ kind: e.kind, col: e.col, row: e.row }); }
    }
    render();
  }

  // ---------- symbol stamps ----------
  function stampCenterPx(st) {
    const b = contentBox();
    return { x: b.ox + st.x * b.W, y: b.oy + st.y * b.H };
  }
  function stampRadiusPx(st) {
    const b = contentBox();
    return Math.max(10, st.size * Math.min(b.W, b.H) * 0.5);
  }
  function stampAt(ix, iy) {
    for (let i = S.stamps.length - 1; i >= 0; i--) {
      const c = stampCenterPx(S.stamps[i]);
      if ((ix - c.x) * (ix - c.x) + (iy - c.y) * (iy - c.y) <= stampRadiusPx(S.stamps[i]) ** 2) return i;
    }
    return -1;
  }
  function addStamp(id) {
    if (!editReady()) return;
    pushHistory();
    S.stamps.push({ id, x: 0.5, y: 0.5, size: 0.08, rotation: 0, color: '#1b2430', label: '' });
    S.selStamp = S.stamps.length - 1;
    DS.stamps.ensureLoaded(S.stamps).then(render);
    showStampBar(); refreshLegendHint(); render();
  }
  function mutSel(fn, reload) {
    if (S.selStamp == null || !S.stamps[S.selStamp]) return;
    fn(S.stamps[S.selStamp]);
    if (reload) DS.stamps.ensureLoaded(S.stamps).then(render); else render();
  }
  function syncStampBar() {
    const st = S.selStamp == null ? null : S.stamps[S.selStamp];
    if (!st || !$('sbSize')) return;
    $('sbSize').value = st.size;
    $('sbRot').value = st.rotation || 0;
    $('sbColor').value = /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#1b2430';
    $('sbLabel').value = st.label || '';
  }
  function showStampBar() { if ($('stampBar')) { $('stampBar').classList.remove('hidden'); syncStampBar(); } }
  function hideStampBar() { if ($('stampBar')) $('stampBar').classList.add('hidden'); }
  function buildStampBar() {
    if ($('stampBar')) return;
    const bar = document.createElement('div');
    bar.id = 'stampBar'; bar.className = 'stampbar hidden';
    bar.innerHTML =
      '<div class="sb-group"><span class="sb-l">Size</span><input id="sbSize" type="range" min="0.02" max="0.15" step="0.005" value="0.08"/></div>'
      + '<div class="sb-group"><span class="sb-l">Rotate</span><input id="sbRot" type="range" min="0" max="360" step="1" value="0"/></div>'
      + '<div class="sb-group"><span class="sb-l">Color</span><input id="sbColor" type="color" value="#1b2430"/></div>'
      + '<div class="sb-group sb-grow"><span class="sb-l">Label</span><input id="sbLabel" type="text" placeholder="label (optional)" maxlength="24"/></div>'
      + '<div class="sb-btns">'
      + '<button id="sbDup" type="button" title="Duplicate" aria-label="Duplicate">' + DS.icon('copy') + '</button>'
      + '<button id="sbDel" type="button" title="Delete" aria-label="Delete">' + DS.icon('trash') + '</button>'
      + '<button id="sbClose" type="button" title="Done" aria-label="Done">' + DS.icon('x') + '</button>'
      + '</div>';
    $('stageInner').appendChild(bar);
    $('sbSize').addEventListener('input', (e) => mutSel((st) => { st.size = Number(e.target.value); }));
    $('sbRot').addEventListener('input', (e) => mutSel((st) => { st.rotation = Number(e.target.value); }));
    $('sbColor').addEventListener('input', (e) => mutSel((st) => { st.color = e.target.value; }, true));
    $('sbLabel').addEventListener('input', (e) => mutSel((st) => { st.label = e.target.value; }));
    $('sbDup').addEventListener('click', () => {
      if (S.selStamp == null) return; pushHistory();
      const o = S.stamps[S.selStamp];
      S.stamps.push({ ...o, x: clamp01(o.x + 0.03), y: clamp01(o.y + 0.03) });
      S.selStamp = S.stamps.length - 1; syncStampBar(); refreshLegendHint(); render();
    });
    $('sbDel').addEventListener('click', () => {
      if (S.selStamp == null) return; pushHistory();
      S.stamps.splice(S.selStamp, 1); S.selStamp = null; hideStampBar(); refreshLegendHint(); render();
    });
    $('sbClose').addEventListener('click', () => { S.selStamp = null; hideStampBar(); render(); });
  }
  function buildStampPalette() {
    if (!DS.stamps || !DS.stamps.buildPalette) return;
    DS.stamps.buildPalette($('stampPalette'), (id) => addStamp(id));
  }

  // pointer handling on the view
  function toImg(ev) {
    const r = view.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (view.width / r.width), y: (ev.clientY - r.top) * (view.height / r.height) };
  }
  let painting = false;
  // hex terrain brush — paints (or erases) the hex under the cursor
  function paintHex(p, erase) {
    const h = DS.hex.hexAt(p.x, p.y, S.hexGrid); if (!h) return;
    const key = h.col + ',' + h.row;
    if (erase) S.terrain.delete(key); else S.terrain.set(key, S.hexTerrain);
  }
  view.addEventListener('pointerdown', (ev) => {
    if (S.preview) return;                  // stage is showing the styled preview, not editable
    const p = toImg(ev);
    // perspective corner-dragging swallows all stage input while active
    if (S.perspActive) {
      const ci = cornerAt(p.x, p.y);
      if (ci >= 0) { painting = true; view.setPointerCapture(ev.pointerId); S.dragCorner = ci; }
      return;
    }
    if (!editReady()) return;
    painting = true; view.setPointerCapture(ev.pointerId);
    // stamps take priority: click one to select & drag it
    const si = stampAt(p.x, p.y);
    if (si >= 0) {
      pushHistory();
      S.selStamp = si; S.dragStamp = true;
      const c = stampCenterPx(S.stamps[si]);
      S.dragOff = { x: p.x - c.x, y: p.y - c.y };
      showStampBar(); render();
      return;
    }
    // clicking empty space drops the current stamp selection
    if (S.selStamp != null) { S.selStamp = null; hideStampBar(); }
    if (S.mode === 'hex') {
      pushHistory();
      paintHex(p, ev.button === 2 || S.hexTerrain === 'erase'); // right-click erases
      render(); return;
    }
    if (S.tool === 'roombox') {
      pushHistory();
      S.boxStart = cellAt(p.x, p.y); S.boxCur = S.boxStart;
      render(); return;
    }
    pushHistory(); applyTool(p.x, p.y, true);
  });
  view.addEventListener('pointermove', (ev) => {
    if (!painting) return;
    const p = toImg(ev);
    if (S.perspActive && S.dragCorner != null && S.corners) {
      S.corners[S.dragCorner] = { x: clampImg(p.x, S.w), y: clampImg(p.y, S.h) };
      render(); return;
    }
    if (S.dragStamp && S.selStamp != null) {
      const st = S.stamps[S.selStamp];
      const b = contentBox();
      st.x = clamp01((p.x - S.dragOff.x - b.ox) / b.W);
      st.y = clamp01((p.y - S.dragOff.y - b.oy) / b.H);
      render(); return;
    }
    if (S.mode === 'hex') {
      paintHex(p, (ev.buttons & 2) === 2 || S.hexTerrain === 'erase');
      render(); return;
    }
    if (S.tool === 'roombox' && S.boxStart) {
      S.boxCur = cellAt(p.x, p.y) || S.boxCur;
      render(); return;
    }
    applyTool(p.x, p.y, false);
  });
  view.addEventListener('pointerup', () => {
    if (S.tool === 'roombox' && S.boxStart && S.boxCur) { commitRoomBox(); S.boxStart = S.boxCur = null; render(); }
    S.dragStamp = false; S.dragOff = null;
    S.dragCorner = null;
    painting = false;
  });
  // right-click is an erase stroke in hex mode — suppress the browser menu
  view.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ---------- rendering the stage ----------
  function render() {
    // render() always draws the edit view; if a preview left the canvas resized
    // (or preview flag stale), snap back to the working-image dimensions first.
    if (S.preview) { S.preview = false; syncStageToggle(); }
    view.classList.remove('viewing');
    if (S.w && (view.width !== S.w || view.height !== S.h)) { view.width = S.w; view.height = S.h; fitView(); }
    vctx.clearRect(0, 0, view.width, view.height);
    if (S.work) vctx.drawImage(S.work, 0, 0);
    if (S.mode === 'hex') { renderHexOverlay(); drawPerspectiveOverlay(); return; }
    const { s, ox, oy, C, R } = S.grid;
    // grid overlay (dim once read, bright while locking)
    vctx.strokeStyle = S.walls ? 'rgba(63,138,224,0.20)' : 'rgba(63,138,224,0.7)';
    vctx.lineWidth = 1;
    for (let c = 0; c <= C; c++) { const x = ox + c * s; vctx.beginPath(); vctx.moveTo(x, oy); vctx.lineTo(x, oy + R * s); vctx.stroke(); }
    for (let r = 0; r <= R; r++) { const y = oy + r * s; vctx.beginPath(); vctx.moveTo(ox, y); vctx.lineTo(ox + C * s, y); vctx.stroke(); }
    if (!S.walls) return;
    // floor tint
    vctx.fillStyle = 'rgba(80,200,120,0.16)';
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (S.floor[r * C + c]) vctx.fillRect(ox + c * s, oy + r * s, s, s);
    // doors set
    const dset = new Set(S.doors.map((d) => d.kind + d.col + '_' + d.row));
    // walls
    vctx.strokeStyle = 'rgba(255,90,90,0.95)'; vctx.lineWidth = Math.max(2.5, s * 0.14); vctx.lineCap = 'round';
    for (let r = 0; r < R; r++) for (let c = 0; c <= C; c++) if (S.walls.vEdge[r][c] && !dset.has('v' + c + '_' + r)) { const x = ox + c * s; vctx.beginPath(); vctx.moveTo(x, oy + r * s); vctx.lineTo(x, oy + (r + 1) * s); vctx.stroke(); }
    for (let r = 0; r <= R; r++) for (let c = 0; c < C; c++) if (S.walls.hEdge[r][c] && !dset.has('h' + c + '_' + r)) { const y = oy + r * s; vctx.beginPath(); vctx.moveTo(ox + c * s, y); vctx.lineTo(ox + (c + 1) * s, y); vctx.stroke(); }
    // doors
    vctx.strokeStyle = 'rgba(240,170,60,0.98)'; vctx.lineWidth = Math.max(3, s * 0.18);
    for (const d of S.doors) {
      if (d.kind === 'h') { const y = oy + d.row * s; vctx.beginPath(); vctx.moveTo(ox + (d.col + 0.15) * s, y); vctx.lineTo(ox + (d.col + 0.85) * s, y); vctx.stroke(); }
      else { const x = ox + d.col * s; vctx.beginPath(); vctx.moveTo(x, oy + (d.row + 0.15) * s); vctx.lineTo(x, oy + (d.row + 0.85) * s); vctx.stroke(); }
    }
    // feature dots
    vctx.fillStyle = 'rgba(120,90,220,0.9)';
    for (const f of S.features) if (f.kind !== 'number') { vctx.beginPath(); vctx.arc(ox + (f.col + 0.5) * s, oy + (f.row + 0.5) * s, s * 0.16, 0, 7); vctx.fill(); }
    // symbol stamps (normalized over the grid content box, which starts at ox,oy)
    if (S.stamps.length) {
      vctx.save();
      vctx.translate(ox, oy);
      DS.stamps.draw(vctx, S.stamps, { W: C * s, H: R * s });
      vctx.restore();
    }
    // selected-stamp halo
    if (S.selStamp != null && S.stamps[S.selStamp]) {
      const st = S.stamps[S.selStamp], cw = C * s, ch = R * s;
      const px = ox + st.x * cw, py = oy + st.y * ch, sz = st.size * Math.min(cw, ch);
      vctx.save();
      vctx.strokeStyle = 'rgba(63,138,224,0.95)'; vctx.lineWidth = 2; vctx.setLineDash([6, 4]);
      vctx.strokeRect(px - sz / 2 - 5, py - sz / 2 - 5, sz + 10, sz + 10);
      vctx.restore();
    }
    // room-box drag preview
    if (S.tool === 'roombox' && S.boxStart && S.boxCur) {
      const c0 = Math.min(S.boxStart.col, S.boxCur.col), c1 = Math.max(S.boxStart.col, S.boxCur.col);
      const r0 = Math.min(S.boxStart.row, S.boxCur.row), r1 = Math.max(S.boxStart.row, S.boxCur.row);
      vctx.save();
      vctx.fillStyle = 'rgba(80,200,120,0.18)';
      vctx.fillRect(ox + c0 * s, oy + r0 * s, (c1 - c0 + 1) * s, (r1 - r0 + 1) * s);
      vctx.strokeStyle = 'rgba(80,200,120,0.95)'; vctx.lineWidth = 2; vctx.setLineDash([5, 3]);
      vctx.strokeRect(ox + c0 * s, oy + r0 * s, (c1 - c0 + 1) * s, (r1 - r0 + 1) * s);
      vctx.restore();
    }
    drawPerspectiveOverlay();
  }

  // ---------- live styled-map preview ----------
  // The stage normally shows the editable detection overlay (walls/floor/doors on
  // the photo). Preview mode swaps in the actual styled battle-map they're about to
  // save, re-rendered live as they change any "Save your map" control — so the look
  // is never picked blind. An Edit/Preview toggle sits on the stage once a map is read.
  function buildStageToggle() {
    if ($('stageToggle')) return;
    const t = document.createElement('div');
    t.id = 'stageToggle'; t.className = 'stage-toggle hidden';
    t.innerHTML = '<button type="button" class="stg-seg on" data-view="edit">' + DS.icon('pencil') + ' Edit</button>'
      + '<button type="button" class="stg-seg" data-view="preview">' + DS.icon('eye') + ' Preview</button>';
    t.querySelectorAll('.stg-seg').forEach((b) => b.addEventListener('click', () => setStageMode(b.dataset.view)));
    $('stageInner').appendChild(t);
  }
  function showStageToggle() { buildStageToggle(); $('stageToggle').classList.remove('hidden'); syncStageToggle(); }
  function syncStageToggle() {
    const t = $('stageToggle'); if (!t) return;
    t.querySelectorAll('.stg-seg').forEach((b) => b.classList.toggle('on', (b.dataset.view === 'preview') === !!S.preview));
  }
  // switch the stage between the editable overlay and the styled preview
  function setStageMode(mode) {
    const want = mode === 'preview';
    if (want && !editReady()) return;
    S.preview = want;
    syncStageToggle();
    if (want) { renderPreviewSoon(); }
    else { view.width = S.w; view.height = S.h; fitView(); render(); setStatus('Editing — fix anything in step 4, then style + save in step 5.'); }
  }
  // coalesce bursts (e.g. dragging the opacity/color slider) into one render.
  // setTimeout (not rAF) so it fires even when the window isn't actively painting.
  let _previewTimer = null;
  function renderPreviewSoon() {
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(() => { _previewTimer = null; if (S.preview) renderPreview(); }, 30);
  }
  async function renderPreview() {
    if (!editReady()) { setStageMode('edit'); return; }
    setStatus('Preview of your saved map — change the look in step 5, or hit Edit to keep fixing.');
    const c = await cleanCanvas();
    if (!S.preview) return;                 // user flipped back to Edit during the await
    view.width = c.width; view.height = c.height;
    vctx.clearRect(0, 0, c.width, c.height);
    vctx.drawImage(c, 0, 0);
    view.classList.add('viewing');
    fitView();
    syncStageToggle();
  }
  // called by every step-5 styling control so the change shows on the stage at once
  function previewNow() { if (editReady()) setStageMode('preview'); }

  // hex overlay: photo (already drawn) + painted terrain hexes (semi-transparent)
  // + hex grid lines + stamps. Grid is bright while locking, dim once painting.
  function renderHexOverlay() {
    const g = S.hexGrid; if (!g) return;
    for (const [key, id] of S.terrain) {
      const t = DS.hex.TERRAIN_BY_ID[id]; if (!t) continue;
      const parts = String(key).split(','); const c = +parts[0], r = +parts[1];
      if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
      tracePts(vctx, DS.hex.hexPolygon(c, r, g));
      vctx.fillStyle = withAlpha(t.color, 0.6); vctx.fill();
    }
    vctx.strokeStyle = S.hexReady ? 'rgba(63,138,224,0.25)' : 'rgba(63,138,224,0.7)';
    vctx.lineWidth = 1;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) { tracePts(vctx, DS.hex.hexPolygon(c, r, g)); vctx.stroke(); }
    // stamps + selected-stamp halo (normalized over the hex content box)
    const b = contentBox();
    if (S.stamps.length) {
      vctx.save(); vctx.translate(b.ox, b.oy);
      DS.stamps.draw(vctx, S.stamps, { W: b.W, H: b.H });
      vctx.restore();
    }
    if (S.selStamp != null && S.stamps[S.selStamp]) {
      const st = S.stamps[S.selStamp];
      const px = b.ox + st.x * b.W, py = b.oy + st.y * b.H, sz = st.size * Math.min(b.W, b.H);
      vctx.save();
      vctx.strokeStyle = 'rgba(63,138,224,0.95)'; vctx.lineWidth = 2; vctx.setLineDash([6, 4]);
      vctx.strokeRect(px - sz / 2 - 5, py - sz / 2 - 5, sz + 10, sz + 10);
      vctx.restore();
    }
  }

  // ---------- export ----------
  function buildExportControls() {
    const el = $('exportControls'); el.innerHTML = '';
    if (S.mode === 'hex') return buildHexExportControls(el);
    const mkSelect = (label, list, cur, onSel) => {
      const w = document.createElement('div'); w.className = 'ctl';
      w.innerHTML = `<label><span>${label}</span></label>`;
      const sel = document.createElement('select');
      list.forEach((it) => { const o = document.createElement('option'); o.value = it.id; o.textContent = it.name; sel.appendChild(o); });
      sel.value = cur; sel.addEventListener('change', () => onSel(sel.value));
      w.appendChild(sel); el.appendChild(w);
    };
    mkSelect('Map style', DS.RENDER_STYLES, S.style, (v) => { S.style = v; previewNow(); });
    mkSelect('Floor texture', DS.FLOOR_TEXTURES, S.floorTexture, (v) => { S.floorTexture = v; previewNow(); });
    mkSelect('Wall style', DS.WALL_STYLES, S.wallStyle, (v) => { S.wallStyle = v; previewNow(); });
    const p = document.createElement('div'); p.className = 'ctl';
    p.innerHTML = `<label><span>Detail (pixels per square)</span></label>`;
    const ps = document.createElement('select');
    [[70, 'Roll20 (70)'], [80, 'Standard (80)'], [100, 'Foundry (100)'], [140, 'Print (140)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; ps.appendChild(o); });
    ps.value = S.ppg; ps.addEventListener('change', () => { S.ppg = Number(ps.value); previewNow(); });
    p.appendChild(ps); el.appendChild(p);
    buildExportOptions(el, true);
  }
  // Legend + grid-on-export controls (step 5). `withGrid` false for hex maps,
  // which have no square grid to toggle.
  // The legend lists placed symbols, so it's empty until some are dropped.
  // Show a hint when "Show legend" is on but no symbols exist yet.
  function refreshLegendHint() {
    const h = $('legendHint'); if (!h) return;
    h.classList.toggle('show', !!(S.showLegend && !(S.stamps && S.stamps.length)));
  }
  function buildExportOptions(el, withGrid) {
    const wrap = document.createElement('div'); wrap.className = 'ctl export-opts';
    const legLabel = document.createElement('label'); legLabel.className = 'check';
    legLabel.innerHTML = '<input type="checkbox"' + (S.showLegend ? ' checked' : '') + '/> Show legend (placed symbols)';
    legLabel.querySelector('input').addEventListener('change', (e) => { S.showLegend = e.target.checked; refreshLegendHint(); previewNow(); });
    wrap.appendChild(legLabel);
    const legHint = document.createElement('div'); legHint.id = 'legendHint'; legHint.className = 'opt-hint';
    legHint.textContent = 'Drop symbols on the map in step 4 first — the legend lists them.';
    wrap.appendChild(legHint);
    if (withGrid) {
      const gridLabel = document.createElement('label'); gridLabel.className = 'check';
      gridLabel.innerHTML = '<input type="checkbox"' + (S.gridOnExport ? ' checked' : '') + '/> Grid on export';
      gridLabel.querySelector('input').addEventListener('change', (e) => { S.gridOnExport = e.target.checked; previewNow(); });
      wrap.appendChild(gridLabel);
      // grid color override (color picker + "custom" toggle)
      const colorRow = document.createElement('div'); colorRow.className = 'grid-color-row';
      colorRow.innerHTML = '<label class="check"><input type="checkbox"' + (S.gridColor ? ' checked' : '') + '/> Custom grid color</label>'
        + '<input type="color" value="' + (S.gridColor || '#3c321e') + '"/>';
      const [cChk, cInp] = colorRow.querySelectorAll('input');
      cChk.addEventListener('change', () => { S.gridColor = cChk.checked ? cInp.value : ''; previewNow(); });
      cInp.addEventListener('input', () => { if (cChk.checked) { S.gridColor = cInp.value; previewNow(); } });
      wrap.appendChild(colorRow);
      // grid opacity override (range + "custom" toggle)
      const opRow = document.createElement('div'); opRow.className = 'grid-opacity-row';
      const opLbl = document.createElement('label');
      opLbl.innerHTML = '<span>Grid opacity</span><span class="v"></span>';
      const opInp = document.createElement('input'); opInp.type = 'range'; opInp.min = '0'; opInp.max = '100'; opInp.step = '5';
      opInp.value = S.gridOpacity != null ? Math.round(S.gridOpacity * 100) : 60;
      const opVal = opLbl.querySelector('.v');
      const opChk = document.createElement('label'); opChk.className = 'check sub';
      opChk.innerHTML = '<input type="checkbox"' + (S.gridOpacity != null ? ' checked' : '') + '/> custom';
      const reflectOp = () => { opVal.textContent = S.gridOpacity != null ? Math.round(S.gridOpacity * 100) + '%' : 'style'; };
      opChk.querySelector('input').addEventListener('change', (e) => { S.gridOpacity = e.target.checked ? Number(opInp.value) / 100 : null; reflectOp(); previewNow(); });
      opInp.addEventListener('input', () => { if (opChk.querySelector('input').checked) { S.gridOpacity = Number(opInp.value) / 100; reflectOp(); previewNow(); } });
      reflectOp();
      opRow.appendChild(opLbl); opRow.appendChild(opInp); opRow.appendChild(opChk);
      wrap.appendChild(opRow);
    }
    el.appendChild(wrap);
    refreshLegendHint();
  }
  // hex export controls: just a hex map style + pixels-per-hex. Floor texture /
  // wall style don't apply (hex maps have no walls).
  function buildHexExportControls(el) {
    const mkSelect = (label, list, cur, onSel) => {
      const w = document.createElement('div'); w.className = 'ctl';
      w.innerHTML = `<label><span>${label}</span></label>`;
      const sel = document.createElement('select');
      list.forEach((it) => { const o = document.createElement('option'); o.value = it.id; o.textContent = it.name; sel.appendChild(o); });
      sel.value = cur; sel.addEventListener('change', () => onSel(sel.value));
      w.appendChild(sel); el.appendChild(w);
    };
    const hexStyles = Object.keys(DS.hex.HEX_STYLES).map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
    mkSelect('Map style', hexStyles, S.hexStyle, (v) => { S.hexStyle = v; previewNow(); });
    const p = document.createElement('div'); p.className = 'ctl';
    p.innerHTML = `<label><span>Detail (pixels per hex)</span></label>`;
    const ps = document.createElement('select');
    [[48, 'Skirmish (48)'], [64, 'Standard (64)'], [80, 'Detailed (80)'], [100, 'Print (100)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; ps.appendChild(o); });
    ps.value = S.ppg; ps.addEventListener('change', () => { S.ppg = Number(ps.value); previewNow(); });
    p.appendChild(ps); el.appendChild(p);
    buildExportOptions(el, false);   // hex: legend only, no square-grid toggle
  }
  // Clean battle-map canvas (the base for every image/PDF/VTT export). Stamps are
  // drawn onto it too, so saved PNG/PDF/VTT-image all include them.
  async function cleanCanvas() {
    const drawLegendIfOn = (c) => {
      if (S.showLegend && S.stamps && S.stamps.length) {
        DS.stamps.drawLegend(c.getContext('2d'), S.stamps, { ppg: S.ppg, W: c.width, H: c.height });
      }
    };
    if (S.mode === 'hex') {
      const c = DS.hex.renderHexMap({ grid: S.hexGrid, terrain: S.terrain, features: S.features, ppg: S.ppg, style: S.hexStyle });
      if (S.stamps && S.stamps.length) {
        await DS.stamps.ensureLoaded(S.stamps);
        DS.stamps.draw(c.getContext('2d'), S.stamps, { W: c.width, H: c.height });
      }
      drawLegendIfOn(c);
      return c;
    }
    const c = DS.renderBattleMap({ walls: S.walls, floor: S.floor, doors: S.doors, C: S.grid.C, R: S.grid.R, ppg: S.ppg, style: S.style, floorTexture: S.floorTexture, wallStyle: S.wallStyle, features: S.features, showGrid: S.gridOnExport, gridColor: S.gridColor || undefined, gridOpacity: S.gridOpacity != null ? S.gridOpacity : undefined });
    if (S.stamps && S.stamps.length) {
      await DS.stamps.ensureLoaded(S.stamps);
      DS.stamps.draw(c.getContext('2d'), S.stamps, { W: c.width, H: c.height });
    }
    drawLegendIfOn(c);
    return c;
  }
  // grid dimensions for the active mode — squares use {C,R}, hex uses {cols,rows}
  function gridDims() {
    return S.mode === 'hex' && S.hexGrid ? { C: S.hexGrid.cols, R: S.hexGrid.rows } : { C: S.grid.C, R: S.grid.R };
  }
  function bytesToDataUrl(bytes, mime) {
    let bin = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return `data:${mime};base64,${btoa(bin)}`;
  }
  const SAVE_LABEL = { png: 'Save PNG', jpg: 'Save JPEG', webp: 'Save WebP', pdf: 'Save PDF', 'pdf-tiled': 'Save tiled PDF', dd2vtt: 'Save Universal VTT', 'foundry-json': 'Save Foundry scene' };
  function buildExportFormatSelect() {
    const sel = $('exportFormat'); sel.innerHTML = '';
    DS.EXPORT_FORMATS.forEach((f) => { const o = document.createElement('option'); o.value = f.id; o.textContent = f.name; sel.appendChild(o); });
    sel.value = 'png';
    const onChange = () => {
      const isPdf = sel.value === 'pdf' || sel.value === 'pdf-tiled';
      $('ipsWrap').classList.toggle('hidden', !isPdf);
      $('btn-save').innerHTML = DS.icon('download') + ' ' + (SAVE_LABEL[sel.value] || 'Save map');
    };
    sel.addEventListener('change', onChange); onChange();
  }
  async function saveMap() {
    if (!editReady()) return;
    const fmt = $('exportFormat').value;
    const ips = Math.max(0.25, Number($('ipsInput').value) || 1);
    try {
      if (fmt === 'png' || fmt === 'jpg' || fmt === 'webp') {
        const c = await cleanCanvas();
        const url = DS.canvasToDataURL(c, fmt);
        const r = await DSBridge.saveFile({ suggestedName: `battle-map.${fmt}`, kind: 'png', dataUrl: url });
        saveNote(r, `battle map (${c.width}×${c.height} ${fmt.toUpperCase()})`);
      } else if (fmt === 'pdf') {
        const c = await cleanCanvas();
        const d = gridDims();
        const bytes = DS.buildPDF(c, { C: d.C, R: d.R, ppg: S.ppg, inchesPerSquare: ips });
        const r = await DSBridge.saveFile({ suggestedName: 'battle-map.pdf', kind: 'pdf', dataUrl: bytesToDataUrl(bytes, 'application/pdf') });
        saveNote(r, `battle map (PDF, ${c.width}×${c.height})`);
      } else if (fmt === 'pdf-tiled') {
        const c = await cleanCanvas();
        const d = gridDims();
        const bytes = DS.buildTiledPDF(c, { C: d.C, R: d.R, ppg: S.ppg, inchesPerSquare: ips });
        const r = await DSBridge.saveFile({ suggestedName: 'battle-map-tiled.pdf', kind: 'pdf', dataUrl: bytesToDataUrl(bytes, 'application/pdf') });
        saveNote(r, 'tiled battle map (PDF)');
      } else if (fmt === 'dd2vtt') {
        await saveVTT();
      } else if (fmt === 'foundry-json') {
        await saveFoundry();
      }
    } catch (e) {
      saveNote({ ok: false }, (e && e.message) || 'export failed');
    }
  }
  async function saveVTT() {
    if (S.mode === 'hex') {
      const c = await cleanCanvas();
      const uvtt = DS.hex.hexToVTT({ grid: S.hexGrid, ppg: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
      const r = await DSBridge.saveFile({ suggestedName: 'hex-map.dd2vtt', kind: 'vtt', text: JSON.stringify(uvtt) });
      saveNote(r, `hex VTT (${S.hexGrid.cols}×${S.hexGrid.rows} hexes)`);
      return;
    }
    if (!S.walls) return;
    const c = await cleanCanvas();
    const uvtt = DS.buildUVTT({ walls: S.walls, doors: S.doors, pixelsPerGrid: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
    const val = DS.validateUVTT(uvtt);
    if (!val.ok) { saveNote({ ok: false }, val.errors.join(', ')); return; }
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon.dd2vtt', kind: 'vtt', text: JSON.stringify(uvtt) });
    saveNote(r, `VTT (${uvtt.line_of_sight.length} walls, ${uvtt.portals.length} doors)`);
  }
  async function saveFoundry() {
    if (S.mode === 'hex') {
      const c = await cleanCanvas();
      const uvtt = DS.hex.hexToVTT({ grid: S.hexGrid, ppg: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
      const scene = DS.toFoundryScene(uvtt, 'DungeonScan Hex Scene');
      scene.grid.type = 0;                                   // 0 = hex grid in Foundry
      scene.grid.size = Math.round(DS.hex.SQ3 * S.ppg);      // hex flat-to-flat width, px
      const r = await DSBridge.saveFile({ suggestedName: 'hex-scene.json', kind: 'json', text: JSON.stringify(scene) });
      saveNote(r, `hex Foundry scene (${S.hexGrid.cols}×${S.hexGrid.rows})`);
      return;
    }
    if (!S.walls) return;
    const c = await cleanCanvas();
    const uvtt = DS.buildUVTT({ walls: S.walls, doors: S.doors, pixelsPerGrid: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
    const scene = DS.toFoundryScene(uvtt, 'DungeonScan Scene');
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon-scene.json', kind: 'json', text: JSON.stringify(scene) });
    saveNote(r, `Foundry scene (${scene.walls.length} walls)`);
  }
  function buildRoomKeyText() {
    const { C, R } = (S.mode === 'hex' && S.hexGrid) ? { C: S.hexGrid.cols, R: S.hexGrid.rows } : S.grid, lines = ['DUNGEON ROOM KEY', '==================', ''];
    const nums = S.features.filter((f) => f.kind === 'number').sort((a, b) => Number(a.label) - Number(b.label));
    if (nums.length) {
      lines.push('Numbered rooms:');
      nums.forEach((f) => lines.push(`  ${f.label}.  grid col ${f.col + 1}, row ${f.row + 1}`));
      lines.push('');
    }
    if (S.stamps.length) {
      const M = window.MAPSMITH_ICON_META || {};
      lines.push('Markers on the map:');
      S.stamps.forEach((st) => {
        const col = Math.max(1, Math.min(C, Math.floor(st.x * C) + 1));
        const row = Math.max(1, Math.min(R, Math.floor(st.y * R) + 1));
        const name = st.label || (M[st.id] && M[st.id].label) || st.id;
        lines.push(`  • ${name}  —  near grid col ${col}, row ${row}`);
      });
      lines.push('');
    }
    if (!nums.length && !S.stamps.length) lines.push('(No numbered rooms or placed markers found.)');
    return lines.join('\n');
  }
  async function saveRoomKey() {
    if (!editReady()) return;
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon-room-key.txt', kind: 'txt', text: buildRoomKeyText() });
    saveNote(r, 'room key');
  }
  function saveNote(r, what) {
    const n = $('saveNote');
    if (r && r.ok) { n.style.color = 'var(--green)'; n.innerHTML = DS.icon('check') + ` Saved ${what}.`; }
    else if (r && r.browser === false) n.textContent = '';
    else { n.style.color = '#c05'; n.textContent = 'Could not save — ' + what; }
  }

  // ---------- optional local VLM "smart read" (Developer-ID build only) ----------
  const VLM_PROMPT = 'This is a photo of a hand-drawn tabletop-RPG dungeon map on a grid. ' +
    'Write a concise dungeon key for the Game Master: for each numbered room, one short line on what appears to be in it ' +
    '(features, monsters, stairs, water, traps, treasure). Note any labels or text you can read. Be brief and practical; skip anything unclear.';
  async function smartRead() {
    const btn = $('btn-smart'); if (!btn) return;
    btn.disabled = true; setStatus('Local AI is reading your map… (this can take a moment)');
    try {
      const notes = await DSBridge.vlm(S.work.toDataURL('image/png'), VLM_PROMPT);
      if (notes && notes.trim()) {
        S.notes = notes.trim();
        $('notesBox').textContent = S.notes; $('notesBox').classList.remove('hidden');
        $('btn-notes').classList.remove('hidden');
        setStatus('AI notes ready — save them alongside your map if you like.');
      } else setStatus('The local AI could not read it this time.');
    } catch (e) { setStatus('Smart read is unavailable right now.'); }
    btn.disabled = false;
  }
  async function saveNotes() {
    if (!S.notes) return;
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon-notes.txt', kind: 'txt', text: S.notes });
    saveNote(r, 'dungeon notes');
  }

  // ---------- history / undo / redo ----------
  function snap() {
    return JSON.stringify({
      grid: S.grid,
      walls: S.walls ? { v: S.walls.vEdge.map((r) => [...r]), h: S.walls.hEdge.map((r) => [...r]), C: S.walls.C, R: S.walls.R } : null,
      floor: S.floor ? [...S.floor] : null,
      doors: S.doors, features: S.features, stamps: S.stamps,
      terrain: [...S.terrain.entries()], mode: S.mode, hexGrid: S.hexGrid
    });
  }
  function pushHistory() {
    S.history.push(snap());
    if (S.history.length > 40) S.history.shift();
    S.redo = [];          // a new edit invalidates the redo branch
    updateUndoRedoButtons();
  }
  function restoreFrom(p) {
    S.grid = p.grid;
    S.walls = p.walls ? { vEdge: p.walls.v.map((r) => Uint8Array.from(r)), hEdge: p.walls.h.map((r) => Uint8Array.from(r)), C: p.walls.C, R: p.walls.R } : null;
    S.floor = p.floor ? Uint8Array.from(p.floor) : null;
    S.doors = p.doors; S.features = p.features; S.stamps = p.stamps || [];
    S.terrain = new Map(p.terrain || []);
    S.mode = p.mode || 'square';
    S.hexGrid = p.hexGrid || null;
    S.selStamp = null; S.boxStart = S.boxCur = null; hideStampBar();
    syncModeChrome();
    render();
  }
  function undo() {
    if (!S.history.length) return;
    S.redo.push(snap());              // current state becomes redoable
    restoreFrom(JSON.parse(S.history.pop()));
    updateUndoRedoButtons();
  }
  function redo() {
    if (!S.redo.length) return;
    S.history.push(snap());           // current state returns to the undo stack
    restoreFrom(JSON.parse(S.redo.pop()));
    updateUndoRedoButtons();
  }
  function updateUndoRedoButtons() {
    $('btn-undo').disabled = S.history.length === 0;
    $('btn-redo').disabled = S.redo.length === 0;
  }

  // ---------- step lock/unlock ----------
  function lockEl(step, locked) { const e = document.querySelector(`.step[data-step="${step}"]`); if (e) e.classList.toggle('locked', locked); }
  function unlock(step) { lockEl(step, false); }
  function relock(step) { lockEl(step, true); }
  function setStatus(t) { $('status').textContent = t; }

  // ---------- boot ----------
  function buildSamples() {
    const el = $('samples'); el.innerHTML = '';
    (window.DSSamples || []).forEach((sp) => {
      const d = document.createElement('div'); d.className = 's';
      const c = document.createElement('canvas'); c.width = 120; c.height = 52;
      const im = new Image(); im.onload = () => { const x = c.getContext('2d'); const sc = Math.min(c.width / im.width, c.height / im.height); x.drawImage(im, 0, 0, im.width * sc, im.height * sc); }; im.src = sp.dataUrl;
      d.appendChild(c); const lab = document.createElement('div'); lab.textContent = sp.name; lab.style.fontSize = '11px'; lab.style.color = 'var(--stone-600)'; d.appendChild(lab);
      d.addEventListener('click', () => loadDataUrl(sp.dataUrl, sp.name + ' (sample)'));
      el.appendChild(d);
    });
  }

  async function boot() {
    if (window.DS && DS.hydrateIcons) DS.hydrateIcons(document);   // swap data-ic placeholders for SVG icons
    [3, 4, 5].forEach(relock); relock(2);
    buildSamples();
    buildStampBar();
    buildPerspectiveBar();
    buildStampPalette();
    buildExportFormatSelect();
    updateUndoRedoButtons();
    $('sensVal').textContent = sensLabel(S.lineSensitivity);

    $('btn-open').addEventListener('click', async () => { const r = await DSBridge.openImage(); if (r) loadDataUrl(r.dataUrl, r.name); });
    $('drop').addEventListener('click', async () => { const r = await DSBridge.openImage(); if (r) loadDataUrl(r.dataUrl, r.name); });
    $('btn-auto').addEventListener('click', () => {
      if (S.mode === 'hex') {
        S.hexGrid = DS.hex.estimateHexGrid(S.gray, S.w, S.h); recomputeHexCR(); buildHexGridControls();
        render(); setStatus('Hex grid auto-detected — nudge it if needed, then Start painting.');
      } else {
        autoGrid(); buildGridControls(); if (S.walls) { S.walls = null; S.floor = null; relock(4); relock(5); }
        render(); setStatus('Grid auto-detected — nudge it if needed, then Read it.');
      }
    });
    $('btn-read').addEventListener('click', () => { if (S.mode === 'hex') startHexPainting(); else readDungeon(); });
    document.querySelectorAll('#modeToggle .seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    // read tuning (step 3) — re-run the read on change
    $('sensRange').addEventListener('input', () => {
      S.lineSensitivity = Number($('sensRange').value) / 100;
      $('sensVal').textContent = sensLabel(S.lineSensitivity);
    });
    $('sensRange').addEventListener('change', () => { if (S.gray) readDungeon(); });
    $('invertChk').addEventListener('change', () => { S.invertPaper = $('invertChk').checked; if (S.gray) readDungeon(); });

    $('btn-save').addEventListener('click', saveMap);
    $('btn-roomkey').addEventListener('click', saveRoomKey);
    $('btn-saveproj').addEventListener('click', saveProject);
    $('btn-openproj').addEventListener('click', openProjectFile);
    $('btn-persp').addEventListener('click', () => togglePerspective());
    $('btn-hexterrain').addEventListener('click', readHexTerrain);
    $('btn-number').addEventListener('click', numberRoomsAction);
    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-help').addEventListener('click', () => $('help').classList.remove('hidden'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $('help').classList.add('hidden')));
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').classList.add('hidden'); });
    const stage = $('stageInner');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('drag'); });
    stage.addEventListener('dragleave', () => $('drop').classList.remove('drag'));
    stage.addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f && (f.type.startsWith('image/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) ingestFile(f); });
    window.addEventListener('resize', () => { if (S.img) fitView(); });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
    });
    const caps = await DSBridge.capabilities();
    S.caps = caps;
    $('capBadge').innerHTML = DS.icon('shield') + ' offline · on-device' + (caps.ocr ? ' · text' : '') + (caps.classify ? ' · symbols' : '') + (caps.terrain ? ' · terrain' : '') + (caps.ollama ? ' · AI' : '');
    reflectFeatureButtons();   // terrain-button visibility depends on caps
    // optional local-VLM "smart read" — only in the Developer-ID build with Ollama
    if (caps.ollama) {
      const body = document.querySelector('.step[data-step="5"] .sbody');
      const b = document.createElement('button'); b.id = 'btn-smart'; b.className = 'primary wide'; b.innerHTML = DS.icon('sparkles') + ' AI room notes (local)'; b.style.marginTop = 'var(--sp-3)';
      b.addEventListener('click', smartRead);
      const box = document.createElement('pre'); box.id = 'notesBox'; box.className = 'notesbox hidden';
      const save = document.createElement('button'); save.id = 'btn-notes'; save.className = 'save wide hidden ai'; save.innerHTML = DS.icon('key') + ' Save AI notes (.txt)';
      save.addEventListener('click', saveNotes);
      body.appendChild(b); body.appendChild(box); body.appendChild(save);
    }
  }
  boot();
})();
