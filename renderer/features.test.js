/*
 * Headless verification for the new DungeonScan feature paths. Runs under plain
 * Node with canvas shims (no native deps), the same approach as perspective.test.js.
 *
 *   A. PROJECT   — DS.project.serialize → deserialize round-trips the full state
 *                   (terrain Map revived) and rejects foreign/corrupt documents.
 *   B. NUMBER    — DS.numberRooms flood-fills connected floor regions, drops tiny
 *                   ones (minSize), and numbers centroids in reading order.
 *   C. GRID OPTS — DS.resolveGridStyle honours gridColor/gridOpacity overrides.
 *   D. RENDER    — DS.renderBattleMap skips the grid pass when showGrid:false and
 *                   uses the resolved grid style otherwise (recording context).
 *   E. LEGEND    — DS.stamps.drawLegend de-dups stamps and draws a box + labels.
 *   F. PERSPECTIVE — DS.perspective.correct returns a real de-warped canvas (the
 *                   "apply" step of the straighten flow).
 *   G. HEX CROP  — DS.hex.hexBBox bounds a hex polygon; every terrain label the
 *                   CoreML model emits maps to a known DS.hex terrain id (the
 *                   classify→paint wiring shape).
 *
 *   node renderer/features.test.js   (exit 0 = pass)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// --------------------------- canvas shims ---------------------------
function parseColor(c) {
  if (c === '#fff' || c === '#ffffff') return [255, 255, 255];
  if (c === '#000' || c === '#000000') return [0, 0, 0];
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  return [255, 255, 255];
}
// REAL shim: getImageData/createImageData/putImageData + nearest-neighbour
// drawImage + fillRect (enough for perspective.correct + autoDetectPage).
function makeRealCanvas(w, h) {
  const cv = { _img: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } };
  Object.defineProperty(cv, 'width', { get() { return cv._img.width; }, set(v) { cv._img = { width: v, height: cv._img.height, data: new Uint8ClampedArray(v * cv._img.height * 4) }; } });
  Object.defineProperty(cv, 'height', { get() { return cv._img.height; }, set(v) { cv._img = { width: cv._img.width, height: v, data: new Uint8ClampedArray(cv._img.width * v * 4) }; } });
  cv.getContext = () => ({
    fillStyle: '#fff',
    fillRect() { const [r, g, b] = parseColor(this.fillStyle); const d = cv._img.data; for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } },
    drawImage(src, dx, dy, dw, dh) {
      const sd = src._img.data, sw = src.width, sh = src.height, d = cv._img.data;
      for (let y = 0; y < cv.height; y++) { const sy = Math.min(sh - 1, Math.floor(y / cv.height * sh));
        for (let xi = 0; xi < cv.width; xi++) { const sx = Math.min(sw - 1, Math.floor(xi / cv.width * sw));
          const si = (sy * sw + sx) * 4, di = (y * cv.width + xi) * 4; d[di] = sd[si]; d[di + 1] = sd[si + 1]; d[di + 2] = sd[si + 2]; d[di + 3] = sd[si + 3]; } }
    },
    getImageData() { return { width: cv.width, height: cv.height, data: new Uint8ClampedArray(cv._img.data) }; },
    createImageData(w2, h2) { return { width: w2, height: h2, data: new Uint8ClampedArray(w2 * h2 * 4) }; },
    putImageData(img) { cv._img = img; },
  });
  return cv;
}
// RECORD shim: a Proxy 2D context that logs every draw call (op + current
// stroke/fill style). Used to assert render.js drew (or skipped) the grid. No
// method returns are consumed by render.js under a 'flat' texture, so every
// method can be a recording no-op.
function makeRecordCanvas(w, h) {
  const cv = { width: w, height: h, _log: null };
  cv.getContext = function () {
    if (cv._ctx) return cv._ctx;
    const state = { canvas: cv };
    const log = []; cv._log = log;
    cv._ctx = new Proxy(state, {
      get(t, prop) {
        if (prop === 'log') return log;
        if (prop === 'canvas') return t.canvas;
        if (prop in t) return t[prop];
        return function () { log.push({ op: String(prop), strokeStyle: t.strokeStyle, fillStyle: t.fillStyle }); };
      },
      set(t, prop, val) { t[prop] = val; return true; }
    });
    return cv._ctx;
  };
  return cv;
}

global.window = {};
global.Image = function () { this.complete = false; this.naturalWidth = 0; };  // stamps.image() stays decode-pending
let _create = (t) => makeRealCanvas(1, 1);   // default; swapped per phase
global.document = { createElement: (t) => _create(t) };

function load(file) { eval(fs.readFileSync(path.join(__dirname, file), 'utf8')); }
// Order doesn't matter — each attaches to window.DS and only touches the DOM at
// call time, so we can swap document.createElement between phases below.
load('digitize.js');
load('render.js');
load('hexgrid.js');
load('stamps.js');
load('project.js');
load('perspective.js');

let failures = 0;
function assert(ok, msg) { if (!ok) { failures++; console.log('  FAIL: ' + msg); } else console.log('  ok:   ' + msg); }
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// --------------------------- A. project round-trip ---------------------------
console.log('\n[A] project serialize/deserialize — full-state round-trip');
{
  const terrain = new Map([['0,0', 'forest'], ['1,2', 'water'], ['3,3', 'mountains']]);
  const state = {
    mode: 'hex', image: 'data:image/png;base64,QUFBQQ==',
    grid: { s: 40, ox: 5, oy: 6, C: 10, R: 10 },
    hexGrid: { size: 20, ox: 1, oy: 2, cols: 5, rows: 4 },
    walls: { v: [[0, 1], [0, 0]], h: [[1, 0]], C: 2, R: 1 },
    floor: [1, 0],
    doors: [{ kind: 'h', col: 0, row: 1 }],
    features: [{ kind: 'number', label: '1', col: 0, row: 0 }],
    stamps: [{ id: 'tree', x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: '#000', label: '' }],
    terrain,
    style: 'stone', floorTexture: 'wood', wallStyle: 'double',
    hexStyle: 'blueprint', hexTerrain: 'forest', hexReady: true,
    ppg: 100, lineSensitivity: 0.7, invertPaper: true, deskew: 1.5,
    showLegend: true, gridOnExport: false, gridColor: '#ff0000', gridOpacity: 0.3
  };
  const text = window.DS.project.serialize(state);
  assert(typeof text === 'string' && text.indexOf('DungeonScan') >= 0, 'serialize produces a JSON string tagged DungeonScan');
  const back = window.DS.project.deserialize(text);
  assert(back.mode === 'hex' && back.image === state.image, 'mode + embedded image survive');
  assert(deepEq(back.grid, state.grid) && deepEq(back.hexGrid, state.hexGrid), 'grid + hexGrid survive');
  assert(deepEq(back.walls, state.walls) && deepEq(back.floor, state.floor), 'walls + floor survive');
  assert(deepEq(back.doors, state.doors) && deepEq(back.features, state.features), 'doors + features survive');
  assert(back.terrain instanceof Map && deepEq([...back.terrain.entries()], [...terrain.entries()]), 'terrain revived as an equal Map');
  assert(back.showLegend === true && back.gridOnExport === false && back.gridColor === '#ff0000' && back.gridOpacity === 0.3, 'export options survive');
  // minimal doc: missing optionals get DEFAULTS so callers can read them raw
  const min = window.DS.project.deserialize(window.DS.project.serialize({ mode: 'square', image: 'data:x' }));
  assert(min.showLegend === false && min.gridOnExport === true && min.gridColor === '' && min.gridOpacity === null, 'defaults filled for missing optionals');
  let threw = 0;
  try { window.DS.project.deserialize(JSON.stringify({ app: 'OtherApp' })); } catch (e) { threw++; }
  try { window.DS.project.deserialize('not json'); } catch (e) { threw++; }
  assert(threw === 2, 'foreign + corrupt documents are rejected (2 throws)');
}

// --------------------------- B. numberRooms ---------------------------
console.log('\n[B] numberRooms — connected regions, minSize, reading order');
{
  // 1×5 grid: floor [1,1,0,1,1], no internal walls → two rooms split by the
  // non-floor gap. centroids col 0.5→1 and 3.5→4, numbered left-to-right.
  const walls = { vEdge: [new Uint8Array([0, 0, 0, 0, 0, 0])], hEdge: [new Uint8Array([0, 0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0, 0])], C: 5, R: 1 };
  const floor = new Uint8Array([1, 1, 0, 1, 1]);
  const rooms = window.DS.numberRooms(walls, floor, 5, 1);
  assert(rooms.length === 2, 'found 2 rooms (split by the non-floor cell)');
  assert(deepEq(rooms, [{ kind: 'number', label: '1', col: 1, row: 0 }, { kind: 'number', label: '2', col: 4, row: 0 }]), 'labels 1,2 at centroids in reading order');
  // a lone 1-cell floor speck is below minSize 2 → ignored
  const walls2 = { vEdge: [new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 0])], hEdge: [new Uint8Array([0, 0]), new Uint8Array([0, 0]), new Uint8Array([0, 0])], C: 2, R: 2 };
  const floor2 = new Uint8Array([1, 0, 0, 0]); // only cell (0,0), size 1
  assert(window.DS.numberRooms(walls2, floor2, 2, 2).length === 0, 'minSize=2 drops a lone floor cell');
}

// --------------------------- C. resolveGridStyle ---------------------------
console.log('\n[C] resolveGridStyle — gridColor/gridOpacity overrides');
{
  const pal = { grid: 'rgba(60,50,30,0.20)' };
  const R = window.DS.resolveGridStyle;
  assert(R(pal, {}) === 'rgba(60,50,30,0.20)', 'no overrides → palette colour');
  assert(R(pal, { gridColor: '#ff0000' }) === 'rgba(255,0,0,1)', 'gridColor override, full opacity');
  assert(R(pal, { gridColor: '#0a0b0c', gridOpacity: 0.25 }) === 'rgba(10,11,12,0.25)', 'gridColor + gridOpacity');
  assert(R(pal, { gridOpacity: 0.5 }) === 'rgba(60,50,30,0.5)', 'gridOpacity swaps the palette alpha');
}

// --------------------------- D. renderBattleMap grid options ---------------------------
console.log('\n[D] renderBattleMap — grid on/off + custom style (recording ctx)');
_create = (t) => makeRecordCanvas(1, 1);   // render.js uses the recording ctx
{
  const C = 4, R = 3, ppg = 40;
  const walls = { vEdge: [], hEdge: [] };
  for (let r = 0; r < R; r++) { walls.vEdge[r] = new Uint8Array(C + 1); }
  for (let r = 0; r <= R; r++) { walls.hEdge[r] = new Uint8Array(C); }
  const floor = new Uint8Array(C * R); for (let i = 0; i < floor.length; i++) floor[i] = 1;
  const base = { walls, floor, doors: [], C, R, ppg, style: 'stone', floorTexture: 'flat', wallStyle: 'solid', features: [] };

  function gridStrokes(canvas) {
    const log = canvas._log || [];
    // drawGrid sets strokeStyle = gridStyle before each stroke; capture that
    return log.filter((e) => e.op === 'stroke').map((e) => e.strokeStyle);
  }

  const on = window.DS.renderBattleMap(Object.assign({}, base));
  const onGrid = gridStrokes(on).filter((s) => s === 'rgba(60,50,30,0.20)');
  assert(on.width === C * ppg && on.height === R * ppg, `canvas sized ${C * ppg}×${R * ppg}`);
  assert(onGrid.length > 0, 'default (grid on) strokes the grid');

  const off = window.DS.renderBattleMap(Object.assign({}, base, { showGrid: false }));
  const offGrid = gridStrokes(off).filter((s) => s === 'rgba(60,50,30,0.20)');
  assert(offGrid.length === 0, 'showGrid:false skips the grid pass entirely');

  const custom = window.DS.renderBattleMap(Object.assign({}, base, { gridColor: '#112233', gridOpacity: 0.4 }));
  const customGrid = gridStrokes(custom).filter((s) => s === 'rgba(17,34,51,0.4)');
  assert(customGrid.length > 0, 'custom gridColor+opacity is the style actually stroked');
}

// --------------------------- E. legend ---------------------------
console.log('\n[E] drawLegend — dedup + box + labels (recording ctx)');
{
  window.MAPSMITH_ICON_META = { tree: { label: 'Tree' }, chest: { label: 'Chest' } };
  const cv = makeRecordCanvas(800, 600);
  const stamps = [
    { id: 'tree', label: '', color: '#000' },
    { id: 'chest', label: 'Gold', color: '#000' },
    { id: 'tree', label: 'duplicate', color: '#000' }
  ];
  window.DS.stamps.drawLegend(cv.getContext(), stamps, { ppg: 80, W: 800, H: 600 });
  const log = cv._log || [];
  const fills = log.filter((e) => e.op === 'fill').length;     // box fill + per-row bullet dots
  const texts = log.filter((e) => e.op === 'fillText').length; // one label per UNIQUE stamp
  const rect = log.filter((e) => e.op === 'arcTo').length;     // _roundRect → 4 arcTo
  assert(texts === 2, `2 unique labels drawn (got ${texts})`);
  assert(rect === 4, 'rounded legend box outlined');
  assert(fills >= 1, 'legend panel filled');
}

// --------------------------- F. perspective apply ---------------------------
console.log('\n[F] perspective.correct — apply step returns a de-warped canvas');
_create = (t) => makeRealCanvas(1, 1);   // correct()/autoDetectPage need the real shim
{
  const W = 200, H = 200;
  const src = makeRealCanvas(W, H); src.getContext().fillStyle = '#fff'; src.getContext().fillRect();
  // paint a black square in the centre so the warp has structure to sample
  const d = src._img.data;
  for (let y = 60; y < 140; y++) for (let x = 60; x < 140; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = 255; }
  const corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const fixed = window.DS.perspective.correct(src, corners);
  assert(fixed && fixed.width > 0 && fixed.height > 0, `correct() returns a canvas (${fixed.width}×${fixed.height})`);
  const quad = window.DS.perspective.autoDetectPage(src);
  assert(Array.isArray(quad) && quad.length === 4, 'autoDetectPage seeds 4 corners (handle seeding)');
}

// --------------------------- G. hex crop wiring shape ---------------------------
console.log('\n[G] hex crop — hexBBox bounds + label→terrain mapping');
{
  const grid = { size: 30, ox: 0, oy: 0, cols: 5, rows: 5 };
  const ctr = window.DS.hex.hexCenter(2, 2, grid);
  const bb = window.DS.hex.hexBBox(2, 2, grid);
  // pointy-top hex: width √3·size, height 2·size; bbox must contain the centre
  assert(bb.w > 0 && bb.h > 0 && bb.w <= window.DS.hex.SQ3 * grid.size + 1 && bb.h <= 2 * grid.size + 1, `hexBBox dims sane (${bb.w.toFixed(1)}×${bb.h.toFixed(1)})`);
  assert(ctr.x >= bb.x && ctr.x <= bb.x + bb.w && ctr.y >= bb.y && ctr.y <= bb.y + bb.h, 'hex centre lies inside its bbox (crop window covers the hex)');
  // the wiring shape: every label the TerrainClassifier emits is a known terrain
  // id, so classify→paint maps cleanly (and 'unknown'/junk is dropped). This is
  // the predicate readHexTerrain applies per hex.
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'models', 'terrain_labels.json'), 'utf8'));
  const allKnown = labels.every((id) => !!window.DS.hex.TERRAIN_BY_ID[id]);
  const junkDropped = !window.DS.hex.TERRAIN_BY_ID['unknown'];
  assert(allKnown && labels.length === 13, `all ${labels.length} CoreML terrain labels map to a terrain id`);
  assert(junkDropped, 'unknown/junk labels are not paintable (dropped by the wiring)');
}

// --------------------------- summary ---------------------------
console.log('\n────────────────────────────────────────');
console.log(failures === 0 ? 'RESULT: PASS ✅' : `RESULT: FAIL ❌ (${failures} assertion(s))`);
process.exit(failures === 0 ? 0 : 1);
