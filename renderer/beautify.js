/*
 * MapSmith rendering engine.
 * Pure client-side Canvas 2D. No libraries, no network.
 *
 * The whole map is drawn by render(canvas, state). Everything scales off the
 * canvas width, so the exact same code makes a small live preview and a big
 * print-resolution export — just pass a bigger canvas.
 *
 * Layer order (bottom -> top):
 *   paper -> grain -> stains -> the drawing's inked lines -> grid/hexes ->
 *   stamps -> border -> compass -> scale bar -> title -> legend ->
 *   vignette/edge-burn -> torn edges
 */
(function () {
  'use strict';

  // ---------- small helpers ----------

  // Seeded PRNG so grain/stains look identical in preview and export.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#000000');
    return m
      ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
      : { r: 0, g: 0, b: 0 };
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Paper palettes. base = fill, edge = darker for aging, printGrid = built-in
  // graph/hex lines (graph paper), inkHint = a sensible default ink color.
  const PAPERS = {
    parchment: { base: '#e7d6ac', edge: '#b79a63', warm: 1.0, inkHint: '#2a1c0e' },
    oldVellum: { base: '#f2e8cf', edge: '#cdb98c', warm: 0.7, inkHint: '#3a2a16' },
    antique:   { base: '#d8c194', edge: '#9c7e4c', warm: 1.2, inkHint: '#2a1a0b' },
    sepia:     { base: '#e3c9a0', edge: '#a9825a', warm: 1.4, inkHint: '#3d2412' },
    graph:     { base: '#eef1ea', edge: '#c9d2c4', warm: 0.2, inkHint: '#243b53', printGrid: '#9fb6c6' },
    blueprint: { base: '#123a63', edge: '#0a2545', warm: -1, inkHint: '#eaf3ff', printGrid: '#3a6ea5' },
    blank:     { base: '#fbfbf7', edge: '#e2e2d8', warm: 0.0, inkHint: '#1c1c1c' }
  };

  // ---------- offscreen canvas cache for the source drawing's inked lines ----------
  const state_cache = { inkKey: null, inkCanvas: null };

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /*
   * Turn the user's drawing into clean inked lines on a transparent layer.
   * Dark pixels become the ink color; light paper drops away. Returns a canvas
   * the size of the content box (drawW x drawH) with the art centered.
   */
  let autoSrcId = 0;
  function buildInk(src, drawW, drawH, st) {
    if (!src.__id) src.__id = 'auto-' + (++autoSrcId); // never share cache entries
    const key = [src.__id, drawW | 0, drawH | 0, st.inkColor, st.inkStrength,
      st.lineBoldness, st.inkBleed, st.keepColors, st.dropBackground].join('|');
    if (state_cache.inkKey === key && state_cache.inkCanvas) return state_cache.inkCanvas;

    // Fit the source inside the content box (contain), centered.
    // Works for both <img> (naturalWidth) and <canvas> (width) sources.
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if (!(sw > 0) || !(sh > 0)) return makeCanvas(drawW, drawH); // broken image
    const scale = Math.min(drawW / sw, drawH / sh);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const ox = Math.round((drawW - w) / 2);
    const oy = Math.round((drawH - h) / 2);

    const work = makeCanvas(drawW, drawH);
    const wx = work.getContext('2d', { willReadFrequently: true });
    wx.imageSmoothingQuality = 'high';
    wx.drawImage(src, ox, oy, w, h);

    const img = wx.getImageData(0, 0, drawW, drawH);
    const d = img.data;
    const ink = hexToRgb(st.inkColor);

    if (st.keepColors) {
      // Keep the artist's own colors. Optionally knock out near-white paper.
      if (st.dropBackground) {
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum > 236) d[i + 3] = 0;
          else if (lum > 200) d[i + 3] = Math.round(d[i + 3] * (236 - lum) / 36);
        }
      }
    } else {
      // Re-ink: dark strokes -> ink color, everything lighter -> transparent.
      const cutoff = lerp(60, 232, clamp(st.inkStrength, 0, 100) / 100);
      const soft = 34;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        let a = (cutoff - lum) / soft;
        a = a <= 0 ? 0 : a >= 1 ? 1 : a;
        // respect the source's own transparency
        a *= d[i + 3] / 255;
        d[i] = ink.r; d[i + 1] = ink.g; d[i + 2] = ink.b;
        d[i + 3] = Math.round(a * 255);
      }
    }
    // Reuse the work canvas as the processed layer (saves one full-size canvas
    // on big print exports where each one can be 100+ MB).
    wx.putImageData(img, 0, 0);
    const base = work;

    // Compose bleed (soft underlay) + boldness (offset stamps) + crisp top.
    const out = makeCanvas(drawW, drawH);
    const ox2 = out.getContext('2d');

    if (st.inkBleed > 0) {
      ox2.save();
      ox2.globalAlpha = clamp(st.inkBleed / 100, 0, 1) * 0.5;
      ox2.filter = `blur(${1 + st.inkBleed / 22}px)`;
      ox2.drawImage(base, 0, 0);
      ox2.restore();
    }
    const bold = Math.round(st.lineBoldness);
    if (bold > 0) {
      ox2.save();
      ox2.globalAlpha = 0.9;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        ox2.drawImage(base, Math.cos(a) * bold, Math.sin(a) * bold);
      }
      ox2.restore();
    }
    ox2.drawImage(base, 0, 0);

    state_cache.inkKey = key;
    state_cache.inkCanvas = out;
    return out;
  }

  // ---------- paper, grain, stains ----------

  function drawPaper(ctx, W, H, st) {
    const p = PAPERS[st.paperStyle] || PAPERS.parchment;
    // Tint shifts warm (amber) <-> cool (grey-blue).
    const tint = clamp(st.paperTint, -100, 100) / 100;
    const base = shiftTint(p.base, tint);
    const edge = shiftTint(p.edge, tint);

    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // Broad soft radial so the middle glows and the edges settle darker.
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15,
      W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, rgba(base, 0));
    g.addColorStop(1, rgba(edge, clamp(st.ageAmount / 100, 0, 1) * 0.55));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function shiftTint(hex, t) {
    const c = hexToRgb(hex);
    // t>0 warmer (more red, less blue); t<0 cooler.
    const r = clamp(c.r + t * 20, 0, 255);
    const g = clamp(c.g + t * 4, 0, 255);
    const b = clamp(c.b - t * 22, 0, 255);
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  }

  // Procedural fiber grain: low-res noise scaled up and multiplied on.
  // The noise canvas is cached — rebuilding it every slider tick was the
  // single biggest per-frame cost in the whole render.
  const grainCache = { key: null, canvas: null };
  function drawGrain(ctx, W, H, st) {
    if (st.grain <= 0) return;
    const nw = Math.max(2, Math.round(W / 3));
    const nh = Math.max(2, Math.round(H / 3));
    const key = st.seed + '|' + nw + 'x' + nh;
    let nc = grainCache.key === key ? grainCache.canvas : null;
    if (!nc) {
      const rnd = mulberry32(st.seed ^ 0x9e3779b1);
      nc = makeCanvas(nw, nh);
      const nctx = nc.getContext('2d');
      const nd = nctx.createImageData(nw, nh);
      for (let i = 0; i < nd.data.length; i += 4) {
        const v = 120 + rnd() * 135;
        nd.data[i] = nd.data[i + 1] = nd.data[i + 2] = v;
        nd.data[i + 3] = 255;
      }
      nctx.putImageData(nd, 0, 0);
      grainCache.key = key; grainCache.canvas = nc;
    }
    ctx.save();
    ctx.globalAlpha = clamp(st.grain / 100, 0, 1) * 0.5;
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(nc, 0, 0, W, H);
    ctx.restore();
  }

  // Coffee-stain blotches + a few darker rings.
  function drawStains(ctx, W, H, st) {
    if (st.stains <= 0) return;
    const rnd = mulberry32(st.seed ^ 0x51ed270b);
    const count = Math.round(2 + (st.stains / 100) * 9);
    const p = PAPERS[st.paperStyle] || PAPERS.parchment;
    const stain = shiftTint(p.edge, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < count; i++) {
      const x = rnd() * W, y = rnd() * H;
      const r = (0.04 + rnd() * 0.12) * Math.min(W, H);
      const a = (0.05 + rnd() * 0.12) * clamp(st.stains / 100, 0, 1);
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
      g.addColorStop(0, rgba(stain, a * 0.7));
      g.addColorStop(0.7, rgba(stain, a));
      g.addColorStop(1, rgba(stain, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (rnd() > 0.6) { // occasional ring
        ctx.strokeStyle = rgba(stain, a * 1.2);
        ctx.lineWidth = Math.max(1, r * 0.03);
        ctx.beginPath(); ctx.arc(x, y, r * 0.9, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------- grids ----------

  function contentBox(W, H, st) {
    const m = (st.borderStyle && st.borderStyle !== 'none' ? 0.055 : 0.03) * Math.min(W, H);
    return { x: m, y: m, w: W - m * 2, h: H - m * 2, m };
  }

  function drawGrid(ctx, box, st) {
    if (st.gridType === 'none') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.strokeStyle = rgba(st.gridColor, clamp(st.gridOpacity / 100, 0, 1));
    ctx.lineWidth = Math.max(0.5, box.w / 2400 * 2);
    const cols = clamp(st.gridSize, 4, 80);
    const cell = box.w / cols;
    const offx = (st.gridOffsetX / 100) * cell;
    const offy = (st.gridOffsetY / 100) * cell;

    if (st.gridType === 'square') {
      for (let x = box.x + offx; x <= box.x + box.w + 0.5; x += cell) {
        ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke();
      }
      for (let y = box.y + offy; y <= box.y + box.h + 0.5; y += cell) {
        ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke();
      }
    } else if (st.gridType === 'hex') {
      drawHexGrid(ctx, box, cell, offx, offy);
    }
    ctx.restore();
  }

  // Pointy-top hex grid.
  function drawHexGrid(ctx, box, size, offx, offy) {
    const r = size / 2;                 // circumradius-ish
    const w = Math.sqrt(3) * r;          // horizontal spacing
    const vert = 1.5 * r;                // vertical spacing
    for (let row = -1, y = box.y + offy; y < box.y + box.h + vert; row++, y += vert) {
      const xoff = (row & 1) ? w / 2 : 0;
      for (let x = box.x + offx - w; x < box.x + box.w + w; x += w) {
        hexPath(ctx, x + xoff, y, r);
        ctx.stroke();
      }
    }
  }
  function hexPath(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 90);
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  // Built-in graph/blueprint paper lines (independent of the overlay grid).
  function drawPrintGrid(ctx, W, H, st) {
    const p = PAPERS[st.paperStyle];
    if (!p || !p.printGrid) return;
    ctx.save();
    ctx.strokeStyle = rgba(p.printGrid, 0.5);
    ctx.lineWidth = Math.max(0.5, W / 2600);
    const cell = W / 46;
    for (let x = 0; x <= W; x += cell) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += cell) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }

  // ---------- stamps (icons) ----------

  const imgCache = new Map();
  function stampImage(id, color) {
    const key = id + '|' + color;
    if (imgCache.has(key)) return imgCache.get(key);
    const raw = (window.MAPSMITH_ICONS || {})[id];
    if (!raw) return null;
    // Dragging the color picker mints one entry per hue — keep the cache sane.
    if (imgCache.size > 300) {
      const keys = imgCache.keys();
      for (let i = 0; i < 150; i++) imgCache.delete(keys.next().value);
    }
    const svg = raw.replace(/currentColor/g, color);
    const img = new Image();
    img.decoding = 'async';
    // One shared promise per image so concurrent renders don't clobber each
    // other's onload handler (that bug left some thumbnails blank).
    const entry = { img, ready: false, promise: null };
    entry.promise = new Promise((res) => {
      img.onload = () => { entry.ready = true; res(); };
      img.onerror = () => { entry.ready = true; res(); };
    });
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    imgCache.set(key, entry);
    return entry;
  }

  // Make sure every placed stamp's colored image is decoded before we draw.
  function ensureStamps(st) {
    const jobs = [];
    for (const s of st.stamps || []) {
      const e = stampImage(s.id, s.color || st.inkColor);
      if (e && !e.ready && e.promise) jobs.push(e.promise);
    }
    return Promise.all(jobs);
  }

  // Numbered room marker (old-school dungeon keying): a small circle with the
  // room's number inside. Stored as a stamp with id '__room', number in .label.
  function drawRoomNumber(ctx, s, box, st) {
    const size = (s.size || 6) / 100 * box.w;
    const cx = box.x + s.x * box.w;
    const cy = box.y + s.y * box.h;
    const r = size / 2;
    const ink = s.color || st.inkColor;
    ctx.save();
    ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(ink, 0.12); ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.strokeStyle = ink; ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = `bold ${Math.round(r * 1.15)}px "MapsmithBody", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s.label || '?', cx, cy + r * 0.04);
    ctx.restore();
  }

  function drawStamps(ctx, box, W, st) {
    for (const s of st.stamps || []) {
      if (s.id === '__room') { drawRoomNumber(ctx, s, box, st); continue; }
      const e = stampImage(s.id, s.color || st.inkColor);
      if (!e || !e.ready) continue;
      const size = (s.size || 6) / 100 * box.w;
      const cx = box.x + s.x * box.w;
      const cy = box.y + s.y * box.h;
      ctx.save();
      ctx.translate(cx, cy);
      if (s.rotation) ctx.rotate(s.rotation * Math.PI / 180);
      ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
      ctx.drawImage(e.img, -size / 2, -size / 2, size, size);
      ctx.restore();
      if (s.label) {
        ctx.save();
        ctx.fillStyle = s.color || st.inkColor;
        ctx.font = `${Math.round(size * 0.34)}px "MapsmithLabel", serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(s.label, cx, cy + size / 2 + size * 0.06);
        ctx.restore();
      }
    }
  }

  // ---------- decorative border ----------

  function drawBorder(ctx, box, W, H, st) {
    if (!st.borderStyle || st.borderStyle === 'none') return;
    const u = W / 1000;
    const ink = st.inkColor;
    const x = box.x, y = box.y, w = box.w, h = box.h;
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineJoin = 'miter';

    const rect = (inset, lw) => {
      ctx.lineWidth = lw;
      ctx.strokeRect(x - inset, y - inset, w + inset * 2, h + inset * 2);
    };

    if (st.borderStyle === 'thin') {
      rect(0, 1.6 * u);
    } else if (st.borderStyle === 'double') {
      rect(0, 3 * u);
      rect(-5 * u, 1.4 * u);
    } else if (st.borderStyle === 'rope') {
      rect(0, 2 * u);
      ctx.lineWidth = 5 * u;
      ctx.setLineDash([7 * u, 5 * u]);
      ctx.strokeRect(x - 4 * u, y - 4 * u, w + 8 * u, h + 8 * u);
      ctx.setLineDash([]);
    } else if (st.borderStyle === 'dungeon') {
      rect(0, 5 * u);
      const c = 16 * u;
      [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([px, py]) => {
        ctx.fillRect(px - c / 2, py - c / 2, c, c);
      });
    } else if (st.borderStyle === 'ornate') {
      rect(0, 3 * u);
      rect(-6 * u, 1.3 * u);
      const s = 26 * u;
      const corners = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
      ctx.lineWidth = 2 * u;
      for (const [px, py, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(px + sx * 2 * u, py + sy * s);
        ctx.quadraticCurveTo(px + sx * 2 * u, py + sy * 2 * u, px + sx * s, py + sy * 2 * u);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px + sx * s * 0.5, py + sy * s * 0.5, 2.4 * u, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------- compass rose ----------

  function drawCompass(ctx, box, W, st) {
    if (!st.compassStyle || st.compassStyle === 'none') return;
    const r = box.w * 0.075;
    const pad = r + box.w * 0.03;
    const pos = {
      'top-left': [box.x + pad, box.y + pad],
      'top-right': [box.x + box.w - pad, box.y + pad],
      'bottom-left': [box.x + pad, box.y + box.h - pad],
      'bottom-right': [box.x + box.w - pad, box.y + box.h - pad]
    }[st.compassCorner || 'bottom-right'];
    const [cx, cy] = pos;
    const ink = st.inkColor;
    const u = W / 1000;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1.2 * u;

    const star = (points, len, wid) => {
      for (let i = 0; i < points; i++) {
        const a = (Math.PI * 2 / points) * i - Math.PI / 2;
        const long = (i % 2 === 0);
        const L = long ? len : len * 0.45;
        const Wd = long ? wid : wid * 0.6;
        ctx.save(); ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(Wd, -L * 0.35); ctx.lineTo(0, -L);
        ctx.lineTo(-Wd, -L * 0.35); ctx.closePath();
        ctx.fillStyle = long ? ink : rgba(ink, 0.55);
        ctx.fill();
        ctx.restore();
      }
    };

    if (st.compassStyle === 'simple') {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      star(4, r * 0.92, r * 0.14);
    } else if (st.compassStyle === 'classic') {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.stroke();
      star(8, r * 0.8, r * 0.13);
    } else if (st.compassStyle === 'ornate') {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 0.8 * u;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 16; i++) {           // tick ring
        const a = (Math.PI * 2 / 16) * i;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
      star(8, r * 0.72, r * 0.16);
      star(8, r * 0.4, r * 0.09);
    }
    // North label
    ctx.fillStyle = ink;
    ctx.font = `${Math.round(r * 0.4)}px "MapsmithTitle", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -r - r * 0.28);
    ctx.restore();
  }

  // ---------- scale bar ----------

  function drawScaleBar(ctx, box, W, st) {
    if (!st.scaleBar) return;
    const u = W / 1000;
    const barW = box.w * 0.2;
    const barH = 7 * u;
    // Slide right if the compass occupies the bottom-left corner.
    const compassInCorner = st.compassStyle && st.compassStyle !== 'none' &&
      st.compassCorner === 'bottom-left';
    const x = box.x + box.w * 0.04 + (compassInCorner ? box.w * 0.21 : 0);
    const y = box.y + box.h - box.h * 0.04 - barH;
    const seg = 4;
    const sw = barW / seg;
    ctx.save();
    ctx.strokeStyle = st.inkColor;
    ctx.lineWidth = 1.2 * u;
    for (let i = 0; i < seg; i++) {
      if (i % 2 === 0) { ctx.fillStyle = st.inkColor; ctx.fillRect(x + i * sw, y, sw, barH); }
      ctx.strokeRect(x + i * sw, y, sw, barH);
    }
    ctx.fillStyle = st.inkColor;
    ctx.font = `${Math.round(13 * u)}px "MapsmithLabel", serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(st.scaleLabel || '', x, y - 4 * u);
    ctx.restore();
  }

  // ---------- title cartouche ----------

  function drawTitle(ctx, box, W, st) {
    const text = (st.title || '').trim();
    if (!text) return;
    const u = W / 1000;
    let fontPx = Math.round(34 * u);
    const fam = st.titleFont === 'Pirata' ? 'MapsmithBlack'
      : st.titleFont === 'Medieval' ? 'MapsmithLabel'
      : st.titleFont === 'Fell' ? 'MapsmithFell'
      : 'MapsmithTitle';
    ctx.save();
    ctx.font = `${fontPx}px "${fam}", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let tw = ctx.measureText(text).width;
    // Long titles shrink to fit instead of spilling over the border.
    const maxW = box.w * 0.62;
    if (tw > maxW) {
      fontPx = Math.max(Math.round(14 * u), Math.floor(fontPx * maxW / tw));
      ctx.font = `${fontPx}px "${fam}", serif`;
      tw = ctx.measureText(text).width;
    }
    const padX = 26 * u, padY = 14 * u;
    const bw = tw + padX * 2, bh = fontPx + padY * 2;
    const cx = box.x + box.w / 2;
    const cy = box.y + bh / 2 + box.h * 0.02;

    // ribbon
    ctx.fillStyle = rgba(st.inkColor, 0.14);
    ctx.strokeStyle = st.inkColor;
    ctx.lineWidth = 2 * u;
    roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 6 * u);
    ctx.fill(); ctx.stroke();
    // little end notches
    ctx.beginPath();
    ctx.moveTo(cx - bw / 2, cy - bh / 2);
    ctx.lineTo(cx - bw / 2 - 14 * u, cy);
    ctx.lineTo(cx - bw / 2, cy + bh / 2);
    ctx.moveTo(cx + bw / 2, cy - bh / 2);
    ctx.lineTo(cx + bw / 2 + 14 * u, cy);
    ctx.lineTo(cx + bw / 2, cy + bh / 2);
    ctx.stroke();

    ctx.fillStyle = st.inkColor;
    ctx.fillText(text, cx, cy + 1 * u);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- legend ----------

  function drawLegend(ctx, box, W, st) {
    if (!st.legend) return;
    const used = [];
    const seen = new Set();
    for (const s of st.stamps || []) {
      if (s.id === '__room') continue; // numbered rooms aren't legend entries
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      used.push(s);
    }
    if (!used.length) return;
    const u = W / 1000;
    const rowH = 26 * u;
    const iconSz = 18 * u;
    const padded = 12 * u;
    ctx.font = `${Math.round(14 * u)}px "MapsmithBody", serif`;
    let maxLabel = 0;
    for (const s of used) maxLabel = Math.max(maxLabel, ctx.measureText(labelFor(s)).width);
    const bw = iconSz + 10 * u + maxLabel + padded * 2;
    const bh = rowH * used.length + padded * 2 + 22 * u;
    // Sit in a top corner so we never fight the compass (usually bottom) or the
    // scale bar (bottom-left). Flip to top-left only if the compass is top-right.
    const compassCorner = (st.compassStyle && st.compassStyle !== 'none') ? st.compassCorner : null;
    const onRight = compassCorner !== 'top-right';
    const x = onRight ? box.x + box.w - bw - box.w * 0.03 : box.x + box.w * 0.03;
    const y = box.y + box.h * 0.03;

    ctx.save();
    ctx.fillStyle = rgba('#000000', 0.06);
    ctx.strokeStyle = st.inkColor; ctx.lineWidth = 1.6 * u;
    roundRect(ctx, x, y, bw, bh, 5 * u); ctx.fill(); ctx.stroke();
    ctx.fillStyle = st.inkColor;
    ctx.font = `${Math.round(17 * u)}px "MapsmithTitle", serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Legend', x + padded, y + padded);
    ctx.font = `${Math.round(14 * u)}px "MapsmithBody", serif`;
    used.forEach((s, i) => {
      const ry = y + padded + 22 * u + i * rowH;
      const e = stampImage(s.id, st.inkColor);
      if (e && e.ready) ctx.drawImage(e.img, x + padded, ry, iconSz, iconSz);
      ctx.textBaseline = 'middle';
      ctx.fillText(labelFor(s), x + padded + iconSz + 8 * u, ry + iconSz / 2);
    });
    ctx.restore();
  }
  function labelFor(s) {
    return s.label || (window.MAPSMITH_ICON_META && window.MAPSMITH_ICON_META[s.id]
      && window.MAPSMITH_ICON_META[s.id].label) || s.id.replace(/-/g, ' ');
  }

  // ---------- finish: vignette + torn edges ----------

  function drawVignette(ctx, W, H, st) {
    if (st.vignette <= 0 && st.edgeBurn <= 0) return;
    const p = PAPERS[st.paperStyle] || PAPERS.parchment;
    // soft radial vignette
    if (st.vignette > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35,
        W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, rgba('#1a1206', clamp(st.vignette / 100, 0, 1) * 0.55));
      ctx.save(); ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    // hard-ish burnt edge
    if (st.edgeBurn > 0) {
      const t = clamp(st.edgeBurn / 100, 0, 1);
      const band = Math.min(W, H) * 0.09 * t;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      // four edges via gradients
      const edge = (x, y, w, h, gx0, gy0, gx1, gy1) => {
        const gg = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
        gg.addColorStop(0, rgba('#2a1a08', t * 0.55));
        gg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gg; ctx.fillRect(x, y, w, h);
      };
      edge(0, 0, W, band, 0, 0, 0, band);
      edge(0, H - band, W, band, 0, H, 0, H - band);
      edge(0, 0, band, H, 0, 0, band, 0);
      edge(W - band, 0, band, H, W, 0, W - band, 0);
      ctx.restore();
    }
  }

  // Clip the paper to a rough torn rectangle (destination-out around a jitter path).
  function applyTornEdges(ctx, W, H, st) {
    if (!st.tornEdges) return;
    const rnd = mulberry32(st.seed ^ 0x2545f491);
    const jitter = Math.min(W, H) * 0.012;
    const step = Math.min(W, H) * 0.02;
    const pts = [];
    const edge = (x0, y0, x1, y1) => {
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const n = Math.max(2, Math.round(len / step));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const nx = -dy / len, ny = dx / len;
        const j = (rnd() - 0.5) * 2 * jitter;
        pts.push([x0 + dx * t + nx * j, y0 + dy * t + ny * j]);
      }
    };
    edge(0, 0, W, 0); edge(W, 0, W, H); edge(W, H, 0, H); edge(0, H, 0, 0);
    // erase everything outside the torn path
    const mask = makeCanvas(W, H);
    const mx = mask.getContext('2d');
    mx.fillStyle = '#fff';
    mx.beginPath();
    pts.forEach((p, i) => (i ? mx.lineTo(p[0], p[1]) : mx.moveTo(p[0], p[1])));
    mx.closePath(); mx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    ctx.restore();
  }

  // ---------- public render ----------

  async function render(canvas, st) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    await ensureStamps(st);

    drawPaper(ctx, W, H, st);
    drawGrain(ctx, W, H, st);
    drawPrintGrid(ctx, W, H, st);
    drawStains(ctx, W, H, st);

    const box = contentBox(W, H, st);

    // the drawing
    if (st.__src) {
      const ink = buildInk(st.__src, box.w, box.h, st);
      ctx.drawImage(ink, box.x, box.y);
    }

    drawGrid(ctx, box, st);
    drawStamps(ctx, box, W, st);
    drawBorder(ctx, box, W, H, st);
    drawCompass(ctx, box, W, st);
    drawScaleBar(ctx, box, W, st);
    drawLegend(ctx, box, W, st);
    drawTitle(ctx, box, W, st);
    drawVignette(ctx, W, H, st);
    applyTornEdges(ctx, W, H, st);
    return canvas;
  }

  window.MapEngine = {
    render,
    contentBox,
    PAPERS,
    // expose for the palette preview
    stampSVG(id, color) {
      const raw = (window.MAPSMITH_ICONS || {})[id];
      return raw ? raw.replace(/currentColor/g, color || '#2a1c0e') : '';
    },
    inkHint(style) { return (PAPERS[style] || PAPERS.parchment).inkHint; },
    clearCache() { state_cache.inkKey = null; state_cache.inkCanvas = null; }
  };
})();
