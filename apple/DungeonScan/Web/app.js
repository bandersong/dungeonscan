/*
 * DungeonScan app controller. Import photo → lock grid → read (digitize) →
 * correct → export clean battle map + Universal VTT. Runs the proven DS.* core.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MAXDIM = 1600;

  const S = {
    img: null, work: null, w: 0, h: 0,      // work = offscreen canvas at working res
    gray: null,
    grid: { s: 40, ox: 0, oy: 0, C: 10, R: 10 },
    walls: null, floor: null, doors: [], features: [],
    tool: 'wall', style: 'stone', ppg: 80, notes: '',
    history: [], step: 1, dragVal: null
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
    S.walls = null; S.floor = null; S.doors = []; S.features = []; S.history = [];
    view.width = w; view.height = h;
    $('drop').classList.add('hidden');
    autoGrid();
    buildGridControls();
    unlock(2); unlock(3); relock(4); relock(5);
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
  async function readDungeon() {
    if (!S.gray) return;
    setStatus('Reading your dungeon…');
    await new Promise((r) => setTimeout(r, 20));
    pushHistory();
    const walls = DS.detectWalls(S.gray, S.w, S.h, S.grid);
    S.walls = { vEdge: walls.vEdge.map((r) => Uint8Array.from(r)), hEdge: walls.hEdge.map((r) => Uint8Array.from(r)), C: walls.C, R: walls.R };
    S.floor = DS.detectFloor(S.walls);
    S.doors = DS.detectDoorways(S.walls, S.floor);
    S.features = [];
    // optional on-device enrichment (stairs/water via CoreML, numbers via Vision OCR)
    try { await enrich(); } catch (_) {}
    unlock(4); unlock(5); buildTools(); buildExportControls();
    const wc = countWalls(S.walls), fc = S.floor.reduce((a, b) => a + b, 0);
    $('readInfo').innerHTML = `Found <b>${wc}</b> wall segments, <b>${fc}</b> floor squares, <b>${S.doors.length}</b> doorways`
      + (S.features.length ? `, <b>${S.features.length}</b> features` : '') + `.<br>Anything wrong? Fix it in step 4, then save.`;
    setStatus('Read it! Check step 4 to fix anything, then save your map.');
    render();
  }

  async function enrich() {
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
      const cands = candidateCells();
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
  function candidateCells() {
    // floor cells with notable interior ink (likely a symbol, not blank floor)
    const out = [], { s, ox, oy, C, R } = S.grid, m = Math.round(s * 0.22);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (!S.floor[r * C + c]) continue;
      let ink = 0, n = 0;
      for (let y = oy + r * s + m; y < oy + (r + 1) * s - m; y += 2) for (let x = ox + c * s + m; x < ox + (c + 1) * s - m; x += 2) {
        if (x >= 0 && y >= 0 && x < S.w && y < S.h) { ink += 255 - S.gray[y * S.w + x]; n++; }
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
    const h = { wall: 'Click on a grid line to add a wall; click a wall to remove it.', floor: 'Click a square to mark it as room floor (or clear it).', door: 'Click on a wall to turn it into a doorway.', erase: 'Click a wall to erase it.' };
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

  function applyTool(ix, iy, isStart) {
    if (!S.walls) return;
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

  // pointer handling on the view
  function toImg(ev) {
    const r = view.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (view.width / r.width), y: (ev.clientY - r.top) * (view.height / r.height) };
  }
  let painting = false;
  view.addEventListener('pointerdown', (ev) => {
    if (!S.walls) return; painting = true; view.setPointerCapture(ev.pointerId);
    pushHistory(); const p = toImg(ev); applyTool(p.x, p.y, true);
  });
  view.addEventListener('pointermove', (ev) => { if (!painting) return; const p = toImg(ev); applyTool(p.x, p.y, false); });
  view.addEventListener('pointerup', () => { painting = false; });

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
  }

  // ---------- export ----------
  function buildExportControls() {
    const el = $('exportControls'); el.innerHTML = '';
    const styleCtl = document.createElement('div'); styleCtl.className = 'ctl';
    styleCtl.innerHTML = `<label><span>Map style</span></label>`;
    const sel = document.createElement('select');
    [['stone', 'Stone (classic)'], ['blueprint', 'Blueprint'], ['ink', 'Clean ink']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
    sel.value = S.style; sel.addEventListener('change', () => { S.style = sel.value; });
    styleCtl.appendChild(sel); el.appendChild(styleCtl);

    const ppgCtl = document.createElement('div'); ppgCtl.className = 'ctl';
    ppgCtl.innerHTML = `<label><span>Detail (pixels per square)</span></label>`;
    const psel = document.createElement('select');
    [[70, 'Roll20 (70)'], [80, 'Standard (80)'], [100, 'Foundry (100)'], [140, 'Print (140)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; psel.appendChild(o); });
    psel.value = S.ppg; psel.addEventListener('change', () => { S.ppg = Number(psel.value); });
    ppgCtl.appendChild(psel); el.appendChild(ppgCtl);
  }
  function cleanCanvas() {
    return DS.renderBattleMap({ walls: S.walls, floor: S.floor, doors: S.doors, C: S.grid.C, R: S.grid.R, ppg: S.ppg, style: S.style, features: S.features });
  }
  async function savePNG() {
    if (!S.walls) return;
    const c = cleanCanvas();
    const r = await DSBridge.saveFile({ suggestedName: 'battle-map.png', kind: 'png', dataUrl: c.toDataURL('image/png') });
    saveNote(r, `battle map (${c.width}×${c.height})`);
  }
  async function saveVTT() {
    if (!S.walls) return;
    const c = cleanCanvas();
    const uvtt = DS.buildUVTT({ walls: S.walls, doors: S.doors, pixelsPerGrid: S.ppg, imageBase64: c.toDataURL('image/png').split(',')[1] });
    const val = DS.validateUVTT(uvtt);
    if (!val.ok) { saveNote({ ok: false }, val.errors.join(', ')); return; }
    const r = await DSBridge.saveFile({ suggestedName: 'dungeon.dd2vtt', kind: 'vtt', text: JSON.stringify(uvtt) });
    saveNote(r, `VTT (${uvtt.line_of_sight.length} walls, ${uvtt.portals.length} doors)`);
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

  // ---------- history / undo ----------
  function snap() { return JSON.stringify({ grid: S.grid, walls: S.walls ? { v: S.walls.vEdge.map((r) => [...r]), h: S.walls.hEdge.map((r) => [...r]), C: S.walls.C, R: S.walls.R } : null, floor: S.floor ? [...S.floor] : null, doors: S.doors, features: S.features }); }
  function pushHistory() { S.history.push(snap()); if (S.history.length > 40) S.history.shift(); $('btn-undo').disabled = false; }
  function undo() {
    if (!S.history.length) return;
    const p = JSON.parse(S.history.pop());
    S.grid = p.grid;
    S.walls = p.walls ? { vEdge: p.walls.v.map((r) => Uint8Array.from(r)), hEdge: p.walls.h.map((r) => Uint8Array.from(r)), C: p.walls.C, R: p.walls.R } : null;
    S.floor = p.floor ? Uint8Array.from(p.floor) : null;
    S.doors = p.doors; S.features = p.features;
    $('btn-undo').disabled = S.history.length === 0; render();
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
    $('btn-open').addEventListener('click', async () => { const r = await DSBridge.openImage(); if (r) loadDataUrl(r.dataUrl, r.name); });
    $('drop').addEventListener('click', async () => { const r = await DSBridge.openImage(); if (r) loadDataUrl(r.dataUrl, r.name); });
    $('btn-auto').addEventListener('click', () => { autoGrid(); buildGridControls(); if (S.walls) { S.walls = null; S.floor = null; relock(4); relock(5); } render(); setStatus('Grid auto-detected — nudge it if needed, then Read it.'); });
    $('btn-read').addEventListener('click', readDungeon);
    $('btn-png').addEventListener('click', savePNG);
    $('btn-vtt').addEventListener('click', saveVTT);
    $('btn-undo').addEventListener('click', undo); $('btn-undo').disabled = true;
    $('btn-help').addEventListener('click', () => $('help').classList.remove('hidden'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $('help').classList.add('hidden')));
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').classList.add('hidden'); });
    const stage = $('stageInner');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('drag'); });
    stage.addEventListener('dragleave', () => $('drop').classList.remove('drag'));
    stage.addEventListener('drop', (e) => { e.preventDefault(); $('drop').classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) { const rd = new FileReader(); rd.onload = () => loadDataUrl(rd.result, f.name); rd.readAsDataURL(f); } });
    window.addEventListener('resize', () => { if (S.img) fitView(); });
    document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } });
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
