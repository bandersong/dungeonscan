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
    // symbol stamps: {id,x,y,size,rotation,color,label}  (x,y normalized over grid content box)
    stamps: [], selStamp: null, dragStamp: false, dragOff: null,
    // room-box drag preview
    boxStart: null, boxCur: null
  };

  const view = $('view'), vctx = view.getContext('2d');

  // ---------- image load ----------
  function loadDataUrl(dataUrl, name) {
    const img = new Image();
    img.onload = () => setupImage(img, name);
    img.onerror = () => setStatus('Could not read that image — try a PNG or JPG.');
    img.src = dataUrl;
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
    view.width = w; view.height = h;
    $('drop').classList.add('hidden');
    hideStampBar();
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
    { id: 'wall', ic: '🧱', label: 'Wall' }, { id: 'floor', ic: '🟫', label: 'Room floor' },
    { id: 'roombox', ic: '▭', label: 'Room (box)' }, { id: 'fillroom', ic: '🪣', label: 'Fill room' },
    { id: 'door', ic: '🚪', label: 'Door' }, { id: 'erase', ic: '🧽', label: 'Erase wall' }
  ];
  function buildTools() {
    const el = $('tools'); el.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button'); b.className = 'tool' + (t.id === S.tool ? ' on' : '');
      b.innerHTML = `<span class="ic">${t.ic}</span> ${t.label}`;
      b.addEventListener('click', () => { S.tool = t.id; buildTools(); updateToolHint(); });
      el.appendChild(b);
    }
    updateToolHint();
  }
  function updateToolHint() {
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
    const { C, R, s, ox, oy } = S.grid;
    return { x: ox + st.x * (C * s), y: oy + st.y * (R * s) };
  }
  function stampRadiusPx(st) {
    const { C, R, s } = S.grid;
    return Math.max(10, st.size * Math.min(C * s, R * s) * 0.5);
  }
  function stampAt(ix, iy) {
    for (let i = S.stamps.length - 1; i >= 0; i--) {
      const c = stampCenterPx(S.stamps[i]);
      if ((ix - c.x) * (ix - c.x) + (iy - c.y) * (iy - c.y) <= stampRadiusPx(S.stamps[i]) ** 2) return i;
    }
    return -1;
  }
  function addStamp(id) {
    if (!S.walls) return;
    pushHistory();
    S.stamps.push({ id, x: 0.5, y: 0.5, size: 0.08, rotation: 0, color: '#1b2430', label: '' });
    S.selStamp = S.stamps.length - 1;
    DS.stamps.ensureLoaded(S.stamps).then(render);
    showStampBar(); render();
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
      + '<button id="sbDup" type="button" title="Duplicate">⧉</button>'
      + '<button id="sbDel" type="button" title="Delete">🗑</button>'
      + '<button id="sbClose" type="button" title="Done">✕</button>'
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
      S.selStamp = S.stamps.length - 1; syncStampBar(); render();
    });
    $('sbDel').addEventListener('click', () => {
      if (S.selStamp == null) return; pushHistory();
      S.stamps.splice(S.selStamp, 1); S.selStamp = null; hideStampBar(); render();
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
  view.addEventListener('pointerdown', (ev) => {
    if (!S.walls) return;
    painting = true; view.setPointerCapture(ev.pointerId);
    const p = toImg(ev);
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
    if (S.dragStamp && S.selStamp != null) {
      const st = S.stamps[S.selStamp];
      const { C, R, s, ox, oy } = S.grid;
      st.x = clamp01((p.x - S.dragOff.x - ox) / (C * s));
      st.y = clamp01((p.y - S.dragOff.y - oy) / (R * s));
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
    painting = false;
  });

  // ---------- rendering the stage ----------
  function render() {
    vctx.clearRect(0, 0, view.width, view.height);
    if (S.work) vctx.drawImage(S.work, 0, 0);
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
  }

  // ---------- export ----------
  function buildExportControls() {
    const el = $('exportControls'); el.innerHTML = '';
    const mkSelect = (label, list, cur, onSel) => {
      const w = document.createElement('div'); w.className = 'ctl';
      w.innerHTML = `<label><span>${label}</span></label>`;
      const sel = document.createElement('select');
      list.forEach((it) => { const o = document.createElement('option'); o.value = it.id; o.textContent = it.name; sel.appendChild(o); });
      sel.value = cur; sel.addEventListener('change', () => onSel(sel.value));
      w.appendChild(sel); el.appendChild(w);
    };
    mkSelect('Map style', DS.RENDER_STYLES, S.style, (v) => { S.style = v; });
    mkSelect('Floor texture', DS.FLOOR_TEXTURES, S.floorTexture, (v) => { S.floorTexture = v; });
    mkSelect('Wall style', DS.WALL_STYLES, S.wallStyle, (v) => { S.wallStyle = v; });
    const p = document.createElement('div'); p.className = 'ctl';
    p.innerHTML = `<label><span>Detail (pixels per square)</span></label>`;
    const ps = document.createElement('select');
    [[70, 'Roll20 (70)'], [80, 'Standard (80)'], [100, 'Foundry (100)'], [140, 'Print (140)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; ps.appendChild(o); });
    ps.value = S.ppg; ps.addEventListener('change', () => { S.ppg = Number(ps.value); });
    p.appendChild(ps); el.appendChild(p);
  }
  // Clean battle-map canvas (the base for every image/PDF/VTT export). Stamps are
  // drawn onto it too, so saved PNG/PDF/VTT-image all include them.
  async function cleanCanvas() {
    const c = DS.renderBattleMap({ walls: S.walls, floor: S.floor, doors: S.doors, C: S.grid.C, R: S.grid.R, ppg: S.ppg, style: S.style, floorTexture: S.floorTexture, wallStyle: S.wallStyle, features: S.features });
    if (S.stamps && S.stamps.length) {
      await DS.stamps.ensureLoaded(S.stamps);
      DS.stamps.draw(c.getContext('2d'), S.stamps, { W: c.width, H: c.height });
    }
    return c;
  }
  function bytesToDataUrl(bytes, mime) {
    let bin = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return `data:${mime};base64,${btoa(bin)}`;
  }
  const SAVE_LABEL = { png: '💾 Save PNG', jpg: '💾 Save JPEG', webp: '💾 Save WebP', pdf: '💾 Save PDF', 'pdf-tiled': '💾 Save tiled PDF', dd2vtt: '💾 Save Universal VTT', 'foundry-json': '💾 Save Foundry scene' };
  function buildExportFormatSelect() {
    const sel = $('exportFormat'); sel.innerHTML = '';
    DS.EXPORT_FORMATS.forEach((f) => { const o = document.createElement('option'); o.value = f.id; o.textContent = f.name; sel.appendChild(o); });
    sel.value = 'png';
    const onChange = () => {
      const isPdf = sel.value === 'pdf' || sel.value === 'pdf-tiled';
      $('ipsWrap').classList.toggle('hidden', !isPdf);
      $('btn-save').textContent = SAVE_LABEL[sel.value] || '💾 Save map';
    };
    sel.addEventListener('change', onChange); onChange();
  }
  async function saveMap() {
    if (!S.walls) return;
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
        const bytes = DS.buildPDF(c, { C: S.grid.C, R: S.grid.R, ppg: S.ppg, inchesPerSquare: ips });
        const r = await DSBridge.saveFile({ suggestedName: 'battle-map.pdf', kind: 'pdf', dataUrl: bytesToDataUrl(bytes, 'application/pdf') });
        saveNote(r, `battle map (PDF, ${c.width}×${c.height})`);
      } else if (fmt === 'pdf-tiled') {
        const c = await cleanCanvas();
        const bytes = DS.buildTiledPDF(c, { C: S.grid.C, R: S.grid.R, ppg: S.ppg, inchesPerSquare: ips });
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
    if (!S.walls) return;
    const c = await cleanCanvas();
    const uvtt = DS.buildUVTT({ walls: S.walls, doors: S.doors, pixelsPerGrid: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
    const val = DS.validateUVTT(uvtt);
    if (!val.ok) { saveNote({ ok: false }, val.errors.join(', ')); return; }
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon.dd2vtt', kind: 'vtt', text: JSON.stringify(uvtt) });
    saveNote(r, `VTT (${uvtt.line_of_sight.length} walls, ${uvtt.portals.length} doors)`);
  }
  async function saveFoundry() {
    if (!S.walls) return;
    const c = await cleanCanvas();
    const uvtt = DS.buildUVTT({ walls: S.walls, doors: S.doors, pixelsPerGrid: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
    const scene = DS.toFoundryScene(uvtt, 'DungeonScan Scene');
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon-scene.json', kind: 'json', text: JSON.stringify(scene) });
    saveNote(r, `Foundry scene (${scene.walls.length} walls)`);
  }
  function buildRoomKeyText() {
    const { C, R } = S.grid, lines = ['DUNGEON ROOM KEY', '==================', ''];
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
    if (!S.walls) return;
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon-room-key.txt', kind: 'txt', text: buildRoomKeyText() });
    saveNote(r, 'room key');
  }
  function saveNote(r, what) {
    const n = $('saveNote');
    if (r && r.ok) { n.style.color = 'var(--green)'; n.textContent = `✅ Saved ${what}.`; }
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
      doors: S.doors, features: S.features, stamps: S.stamps
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
    S.selStamp = null; S.boxStart = S.boxCur = null; hideStampBar();
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
      d.appendChild(c); const lab = document.createElement('div'); lab.textContent = sp.name; lab.style.fontSize = '11px'; lab.style.color = '#5f6f7d'; d.appendChild(lab);
      d.addEventListener('click', () => loadDataUrl(sp.dataUrl, sp.name + ' (sample)'));
      el.appendChild(d);
    });
  }

  async function boot() {
    [3, 4, 5].forEach(relock); relock(2);
    buildSamples();
    buildStampBar();
    buildStampPalette();
    buildExportFormatSelect();
    updateUndoRedoButtons();
    $('sensVal').textContent = sensLabel(S.lineSensitivity);

    $('btn-open').addEventListener('click', async () => { const r = await DSBridge.openImage(); if (r) loadDataUrl(r.dataUrl, r.name); });
    $('drop').addEventListener('click', async () => { const r = await DSBridge.openImage(); if (r) loadDataUrl(r.dataUrl, r.name); });
    $('btn-auto').addEventListener('click', () => { autoGrid(); buildGridControls(); if (S.walls) { S.walls = null; S.floor = null; relock(4); relock(5); } render(); setStatus('Grid auto-detected — nudge it if needed, then Read it.'); });
    $('btn-read').addEventListener('click', readDungeon);

    // read tuning (step 3) — re-run the read on change
    $('sensRange').addEventListener('input', () => {
      S.lineSensitivity = Number($('sensRange').value) / 100;
      $('sensVal').textContent = sensLabel(S.lineSensitivity);
    });
    $('sensRange').addEventListener('change', () => { if (S.gray) readDungeon(); });
    $('invertChk').addEventListener('change', () => { S.invertPaper = $('invertChk').checked; if (S.gray) readDungeon(); });

    $('btn-save').addEventListener('click', saveMap);
    $('btn-roomkey').addEventListener('click', saveRoomKey);
    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-help').addEventListener('click', () => $('help').classList.remove('hidden'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $('help').classList.add('hidden')));
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').classList.add('hidden'); });
    const stage = $('stageInner');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('drag'); });
    stage.addEventListener('dragleave', () => $('drop').classList.remove('drag'));
    stage.addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) { const rd = new FileReader(); rd.onload = () => loadDataUrl(rd.result, f.name); rd.readAsDataURL(f); } });
    window.addEventListener('resize', () => { if (S.img) fitView(); });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
    });
    const caps = await DSBridge.capabilities();
    $('capBadge').textContent = '● offline · on-device' + (caps.ocr ? ' · text ✓' : '') + (caps.classify ? ' · symbols ✓' : '') + (caps.ollama ? ' · AI ✓' : '');
    // optional local-VLM "smart read" — only in the Developer-ID build with Ollama
    if (caps.ollama) {
      const body = document.querySelector('.step[data-step="5"] .sbody');
      const b = document.createElement('button'); b.id = 'btn-smart'; b.className = 'primary wide'; b.textContent = '🧠 AI room notes (local)'; b.style.marginTop = '4px';
      b.addEventListener('click', smartRead);
      const box = document.createElement('pre'); box.id = 'notesBox'; box.className = 'notesbox hidden';
      const save = document.createElement('button'); save.id = 'btn-notes'; save.className = 'save wide hidden'; save.textContent = '📝 Save AI notes (.txt)'; save.style.background = 'linear-gradient(180deg,#c98a3a,#a8701f)';
      save.addEventListener('click', saveNotes);
      body.appendChild(b); body.appendChild(box); body.appendChild(save);
    }
  }
  boot();
})();
