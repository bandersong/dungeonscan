/*
 * Clean battle-map renderer. Takes the digitized walls/floor/doors and draws a
 * crisp, grid-aligned map at `ppg` pixels per cell — the "ready to use" output,
 * and the base image embedded in the .dd2vtt.
 *
 * Contract: window.DS.renderBattleMap(opts) -> HTMLCanvasElement (C*ppg x R*ppg)
 *   opts = {
 *     walls: { vEdge[R][C+1], hEdge[R+1][C] },   // 1 = wall on that grid edge
 *     floor: Uint8Array(C*R),                     // 1 = room floor cell
 *     doors: [{ kind:'h'|'v', col, row }],
 *     C, R, ppg,
 *     style:        id into STYLES (default 'stone')
 *     floorTexture: 'flat'|'stonetile'|'cave'|'wood'|'grass'|'water' (default 'flat')
 *     wallStyle:    'solid'|'double'|'stoneblock'|'hatched' (default 'solid')
 *     features: [{ kind, col, row, label }]       // 'number' uses label; others are glyphs
 *   }
 *
 * Exports: DS.renderBattleMap, DS.STYLES,
 *          DS.RENDER_STYLES / DS.FLOOR_TEXTURES / DS.WALL_STYLES  (for UI menus)
 *
 * Everything procedural and deterministic (seeded) — re-rendering the same input
 * yields pixel-identical output.
 */
(function () {
  'use strict';

  // ---------- color model (work in RGB objects, format at the edges) ----------
  var BLACK = { r: 0, g: 0, b: 0 };
  var WHITE = { r: 255, g: 255, b: 255 };
  var GREEN = { r: 86, g: 150, b: 72 };
  var BLUE = { r: 58, g: 116, b: 178 };
  var BROWN = { r: 122, g: 82, b: 46 };

  function hexToRgb(hex) {
    hex = (hex || '#000').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbCss(c, a) {
    if (a == null) return 'rgb(' + (c.r | 0) + ',' + (c.g | 0) + ',' + (c.b | 0) + ')';
    return 'rgba(' + (c.r | 0) + ',' + (c.g | 0) + ',' + (c.b | 0) + ',' + a + ')';
  }
  function mix(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; }
  function tint(c, hue, amt) { return mix(c, hue, amt); }            // nudge toward a hue
  function shade(c, amt) { return amt >= 0 ? mix(c, WHITE, amt) : mix(c, BLACK, -amt); } // -1..1
  function luma(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }

  // ---------- deterministic rng / noise ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash01(n) { // int -> [0,1)
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = (n ^ (n >>> 16)) >>> 0;
    return n / 4294967296;
  }
  // Smooth value-noise field; sampling world coords makes it seamless across cells.
  function makeValueNoise(seed) {
    var s = seed || 1;
    function hash(ix, iy) {
      var h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
      h = Math.imul(h ^ (h >>> 13), s);
      h = (h + Math.imul(iy, 2246822519)) | 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return h / 4294967296;
    }
    var smooth = function (t) { return t * t * (3 - 2 * t); };
    return function (x, y) {
      var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      var v00 = hash(x0, y0), v10 = hash(x0 + 1, y0), v01 = hash(x0, y0 + 1), v11 = hash(x0 + 1, y0 + 1);
      var a = v00 + (v10 - v00) * smooth(fx), b = v01 + (v11 - v01) * smooth(fx);
      return a + (b - a) * smooth(fy);
    };
  }

  // ---------- style palettes (void, floor, floorEdge, grid, wall, door) ----------
  var STYLES = {
    stone:     { void: '#1b1e24', floor: '#d9ccb0', floorEdge: '#c7b78f', grid: 'rgba(60,50,30,0.20)',  wall: '#1b1e24', door: '#7a5230' },
    blueprint: { void: '#0d2f52', floor: '#123a63', floorEdge: '#0f3157', grid: 'rgba(150,190,225,0.35)', wall: '#eaf3ff', door: '#8fb4dd' },
    ink:       { void: '#f4f3ee', floor: '#ffffff', floorEdge: '#eceae3', grid: 'rgba(40,40,40,0.18)',   wall: '#161616', door: '#161616' },
    parchment: { void: '#e3d3a8', floor: '#f2e6c4', floorEdge: '#ddc99a', grid: 'rgba(110,72,32,0.22)',  wall: '#5b3a1c', door: '#8a5a2b' },
    cavern:    { void: '#1a1d22', floor: '#42474f', floorEdge: '#333840', grid: 'rgba(170,180,190,0.12)', wall: '#0a0c10', door: '#7a8088' },
    classic:   { void: '#e9eef4', floor: '#ffffff', floorEdge: '#d7e2f0', grid: 'rgba(40,72,150,0.55)',  wall: '#1b2c61', door: '#1b2c61' },
    handdrawn: { void: '#f3eede', floor: '#fbf7ea', floorEdge: '#ece4cc', grid: 'rgba(70,55,30,0.14)',   wall: '#211d14', door: '#211d14' },
    scifi:     { void: '#070b10', floor: '#0f1a22', floorEdge: '#182835', grid: 'rgba(90,205,235,0.30)', wall: '#57d1e8', door: '#2e6f80' }
  };

  // ---------- floor textures (drawn INSIDE floor cells only) ----------
  function drawStoneTile(ctx, x, y, ppg, base, cellSeed) {
    var rng = mulberry32(cellSeed);
    var v = (rng() - 0.5) * 0.12;
    var fill = tint(base, v >= 0 ? WHITE : BLACK, Math.abs(v));
    ctx.fillStyle = rgbCss(fill); ctx.fillRect(x, y, ppg, ppg);
    // soft lighten in the upper-left for a worn face
    ctx.fillStyle = rgbCss(tint(base, WHITE, 0.08), 0.35);
    ctx.fillRect(x + ppg * 0.06, y + ppg * 0.06, ppg * 0.5, ppg * 0.5);
    // mortar inset
    var m = Math.max(1, ppg * 0.045);
    ctx.strokeStyle = rgbCss(shade(base, -0.28), 0.95);
    ctx.lineWidth = Math.max(1.5, ppg * 0.06); ctx.lineJoin = 'miter';
    ctx.strokeRect(x + m, y + m, ppg - 2 * m, ppg - 2 * m);
  }

  function drawCave(ctx, c, r, ppg, base, noise) {
    var x = c * ppg, y = r * ppg;
    var img = ctx.createImageData(ppg, ppg);
    var d = img.data;
    var scale = ppg * 0.18;
    var dark = shade(base, -0.44), light = shade(base, 0.14);
    for (var py = 0; py < ppg; py++) {
      for (var px = 0; px < ppg; px++) {
        var wx = (x + px) / scale, wy = (y + py) / scale;
        var v = 0.55 * noise(wx, wy) + 0.30 * noise(wx * 2.07 + 11, wy * 2.07 + 5) + 0.15 * noise(wx * 4.3 + 31, wy * 4.3 + 19);
        var cc = mix(dark, light, v);
        var i = (py * ppg + px) * 4;
        d[i] = cc.r; d[i + 1] = cc.g; d[i + 2] = cc.b; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, x, y);
  }

  function drawWood(ctx, c, r, ppg, base) {
    var x = c * ppg, y = r * ppg;
    var wood = tint(base, BROWN, 0.28);
    ctx.fillStyle = rgbCss(wood); ctx.fillRect(x, y, ppg, ppg);
    var plankH = Math.max(8, ppg * 0.26);
    var seam = tint(wood, BLACK, 0.32);
    var grain = tint(wood, BLACK, 0.14);
    // Align planks to the world so they continue across columns.
    var pi = Math.floor((r * ppg) / plankH);
    var topLocal = (r * ppg) - pi * plankH; // <=0: this plank starts above the cell
    while (topLocal < ppg) {
      var cTop = Math.max(0, topLocal), cBot = Math.min(ppg, topLocal + plankH);
      if (cBot > cTop) {
        var h = hash01(pi * 7919 + 13);
        var pc = tint(wood, h > 0.5 ? WHITE : BLACK, Math.abs(h - 0.5) * 0.30);
        ctx.fillStyle = rgbCss(pc); ctx.fillRect(x, y + cTop, ppg, cBot - cTop);
        if (topLocal >= 0 && topLocal < ppg) {
          ctx.fillStyle = rgbCss(seam, 0.8);
          ctx.fillRect(x, y + topLocal, ppg, Math.max(1, ppg * 0.035));
        }
        // a single faint grain line per plank
        ctx.strokeStyle = rgbCss(grain, 0.5); ctx.lineWidth = Math.max(1, ppg * 0.02);
        var gy = y + cTop + (cBot - cTop) * 0.5;
        ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + ppg, gy); ctx.stroke();
      }
      pi++; topLocal += plankH;
    }
  }

  function drawGrass(ctx, x, y, ppg, base, cellSeed) {
    var grass = tint(base, GREEN, 0.34);
    ctx.fillStyle = rgbCss(grass); ctx.fillRect(x, y, ppg, ppg);
    var rng = mulberry32(cellSeed);
    var light = tint(grass, WHITE, 0.30), dark = tint(grass, BLACK, 0.20);
    var blades = Math.floor(ppg * ppg * 0.02) + 6;
    ctx.lineWidth = Math.max(1, ppg * 0.02); ctx.lineCap = 'round';
    for (var i = 0; i < blades; i++) {
      var bx = x + rng() * ppg, by = y + rng() * ppg;
      var len = ppg * 0.08 + rng() * ppg * 0.16;
      var slant = (rng() - 0.5) * ppg * 0.07;
      ctx.strokeStyle = rgbCss(rng() < 0.5 ? light : dark, 0.5 + rng() * 0.4);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + slant, by - len); ctx.stroke();
    }
  }

  function drawWater(ctx, c, r, ppg, base) {
    var x = c * ppg, y = r * ppg;
    var water = tint(base, BLUE, 0.42);
    var top = tint(water, WHITE, 0.14), bot = tint(water, BLACK, 0.14);
    var g = ctx.createLinearGradient(0, y, 0, y + ppg);
    g.addColorStop(0, rgbCss(top)); g.addColorStop(1, rgbCss(bot));
    ctx.fillStyle = g; ctx.fillRect(x, y, ppg, ppg);
    var ripple = rgbCss(tint(water, WHITE, 0.30), 0.55);
    ctx.strokeStyle = ripple; ctx.lineWidth = Math.max(1, ppg * 0.03); ctx.lineCap = 'round';
    var step = Math.max(6, ppg * 0.24);
    for (var yy = (step - (r * ppg) % step) % step; yy < ppg; yy += step) {
      ctx.beginPath();
      for (var px = 0; px <= ppg; px += 2) {
        var wy = y + yy + Math.sin((x + px) / (ppg * 0.25) + r) * (ppg * 0.035);
        if (px === 0) ctx.moveTo(x + px, wy); else ctx.lineTo(x + px, wy);
      }
      ctx.stroke();
    }
  }

  // Resolve the grid stroke style for an export. The look defaults to the
  // style palette's `grid` colour; the user may override the colour, the
  // opacity, or both from the step-5 "Grid on export" controls. Pure — kept on
  // DS so the option plumbing is testable headlessly.
  function resolveGridStyle(st, opts) {
    opts = opts || {};
    if (opts.gridColor) {
      var rgb = hexToRgb(opts.gridColor);
      var a = (opts.gridOpacity != null) ? opts.gridOpacity : 1;
      return rgbCss(rgb, a);
    }
    if (opts.gridOpacity != null) {
      // swap the alpha of the palette's rgba() grid colour
      var m = /rgba?\(([^)]+)\)/.exec(st.grid || '');
      if (m) {
        var p = m[1].split(',').map(function (s) { return s.trim(); });
        return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + opts.gridOpacity + ')';
      }
    }
    return st.grid;
  }

  // ---------- grid (confined to floor cells, so margins stay clean) ----------
  function drawGrid(ctx, floor, C, R, ppg, gridStyle) {
    ctx.strokeStyle = gridStyle; ctx.lineWidth = Math.max(1, ppg / 60); ctx.lineCap = 'butt';
    var c, r;
    for (c = 0; c <= C; c++) {
      for (r = 0; r < R; r++) {
        var lv = c > 0 ? floor[r * C + (c - 1)] : 0;
        var rv = c < C ? floor[r * C + c] : 0;
        if (lv || rv) { ctx.beginPath(); ctx.moveTo(c * ppg, r * ppg); ctx.lineTo(c * ppg, (r + 1) * ppg); ctx.stroke(); }
      }
    }
    for (r = 0; r <= R; r++) {
      for (c = 0; c < C; c++) {
        var uv = r > 0 ? floor[(r - 1) * C + c] : 0;
        var dv = r < R ? floor[r * C + c] : 0;
        if (uv || dv) { ctx.beginPath(); ctx.moveTo(c * ppg, r * ppg); ctx.lineTo((c + 1) * ppg, r * ppg); ctx.stroke(); }
      }
    }
  }

  // ---------- walls ----------
  function drawWalls(ctx, walls, doors, C, R, ppg, st, styleId, wallStyle, floorLum, wallRgb) {
    var doorSet = new Set(doors.map(function (d) { return d.kind + d.col + '_' + d.row; }));
    var lw = Math.max(3, ppg * 0.12);
    var wobble = styleId === 'handdrawn';
    var w = wobble ? Math.max(0.6, ppg * 0.02) : 0;
    var shadowOn = floorLum > 118 && !wobble && wallStyle !== 'double';
    var shDX = Math.max(1, ppg * 0.03), shDY = Math.max(1, ppg * 0.03);
    ctx.lineJoin = 'miter';
    var r, c;

    function drawStyledEdge(isVert, fixed, a, b) {
      var len = b - a;
      var seed = (Math.imul(isVert ? 7919 : 4099, Math.round(fixed) + 1) ^ Math.imul(17, Math.round(a) + 1)) >>> 0;

      // Builds the centerline (optionally wobbled). `off` shifts it perpendicular.
      function path(off) {
        ctx.beginPath();
        if (!w) {
          if (isVert) { ctx.moveTo(fixed + off, a); ctx.lineTo(fixed + off, b); }
          else { ctx.moveTo(a, fixed + off); ctx.lineTo(b, fixed + off); }
          return;
        }
        var n = Math.max(2, Math.round(len / (ppg * 0.16)));
        var rng = mulberry32(seed || 1);
        if (isVert) ctx.moveTo(fixed + off, a); else ctx.moveTo(a, fixed + off);
        for (var i = 1; i < n; i++) {
          var t = i / n, coord = a + len * t, j = (rng() - 0.5) * 2 * w;
          if (isVert) ctx.lineTo(fixed + off + j, coord); else ctx.lineTo(coord, fixed + off + j);
        }
        if (isVert) ctx.lineTo(fixed + off, b); else ctx.lineTo(b, fixed + off);
      }
      // One wobbled block segment, for stoneblock.
      function seg(s, e) {
        ctx.beginPath();
        if (isVert) ctx.moveTo(fixed, s); else ctx.moveTo(s, fixed);
        if (w) {
          var nn = Math.max(2, Math.round((e - s) / (ppg * 0.16)));
          var rng = mulberry32((seed ^ Math.imul(Math.round(s) + 1, 2654435761)) >>> 0 || 1);
          for (var i = 1; i < nn; i++) {
            var t = i / nn, coord = s + (e - s) * t, j = (rng() - 0.5) * 2 * w;
            if (isVert) ctx.lineTo(fixed + j, coord); else ctx.lineTo(coord, fixed + j);
          }
        }
        if (isVert) ctx.lineTo(fixed, e); else ctx.lineTo(e, fixed);
      }

      if (shadowOn) {
        ctx.save(); ctx.lineCap = 'round';
        ctx.strokeStyle = rgbCss(BLACK, 0.16); ctx.lineWidth = lw + Math.max(1, ppg * 0.03);
        ctx.translate(shDX, shDY); path(0); ctx.stroke(); ctx.restore();
      }

      if (wallStyle === 'double') {
        var gap = Math.max(2, ppg * 0.10), tl = Math.max(1.2, ppg * 0.05);
        ctx.lineCap = wobble ? 'round' : 'butt'; ctx.strokeStyle = st.wall; ctx.lineWidth = tl;
        path(gap / 2); ctx.stroke(); path(-gap / 2); ctx.stroke();
        return;
      }

      if (wallStyle === 'stoneblock') {
        var segLen = ppg * 0.5, bgap = Math.max(1.5, ppg * 0.10);
        ctx.strokeStyle = st.wall; ctx.lineWidth = lw; ctx.lineCap = 'butt';
        var rng = mulberry32(seed || 1);
        var s = a; if (rng() < 0.5) s += bgap; // stagger so neighboring edges don't share seams
        while (s < b) {
          var ln = segLen * (0.7 + rng() * 0.6), e = Math.min(b, s + ln);
          seg(s, e); ctx.stroke();
          s = e + bgap;
        }
        return;
      }

      // solid (also the base for hatched)
      ctx.lineCap = wobble ? 'round' : 'square'; ctx.strokeStyle = st.wall; ctx.lineWidth = lw;
      path(0); ctx.stroke();

      // bevel highlight on the top-left edge — skip on hand-drawn to keep it inky flat
      if (!wobble) {
        var lw2 = lw * 0.42, hi = (lw - lw2) / 2;
        ctx.save(); ctx.lineCap = 'butt';
        if (isVert) ctx.translate(-hi, 0); else ctx.translate(0, -hi);
        ctx.strokeStyle = rgbCss(tint(wallRgb, WHITE, 0.28), 0.7); ctx.lineWidth = lw2;
        path(0); ctx.stroke(); ctx.restore();
      }

      if (wallStyle === 'hatched') {
        var sp = Math.max(6, ppg * 0.22), hl = Math.max(3, ppg * 0.18);
        ctx.strokeStyle = st.wall; ctx.lineWidth = Math.max(1, ppg * 0.04); ctx.lineCap = 'butt';
        var hr = mulberry32((seed ^ 0x55555555) >>> 0 || 1);
        var hs = a + sp * 0.5;
        while (hs < b) {
          if (isVert) { ctx.beginPath(); ctx.moveTo(fixed - hl / 2, hs); ctx.lineTo(fixed + hl / 2, hs); ctx.stroke(); }
          else { ctx.beginPath(); ctx.moveTo(hs, fixed - hl / 2); ctx.lineTo(hs, fixed + hl / 2); ctx.stroke(); }
          hs += sp * (0.8 + hr() * 0.4);
        }
      }
    }

    for (r = 0; r < R; r++) for (c = 0; c <= C; c++) {
      if (walls.vEdge[r][c] && !doorSet.has('v' + c + '_' + r)) drawStyledEdge(true, c * ppg, r * ppg, (r + 1) * ppg);
    }
    for (r = 0; r <= R; r++) for (c = 0; c < C; c++) {
      if (walls.hEdge[r][c] && !doorSet.has('h' + c + '_' + r)) drawStyledEdge(false, r * ppg, c * ppg, (c + 1) * ppg);
    }
  }

  // ---------- doors (gap left by walls + door rect + swing arc) ----------
  function drawDoors(ctx, doors, ppg, st, wallRgb) {
    ctx.lineJoin = 'miter';
    for (var i = 0; i < doors.length; i++) {
      var d = doors[i];
      var th = ppg * 0.26, pad = ppg * 0.14, wd = ppg * 0.72;
      ctx.fillStyle = st.door; ctx.strokeStyle = st.wall; ctx.lineWidth = Math.max(1.2, ppg * 0.04);
      if (d.kind === 'h') {
        var hx = d.col * ppg, hy = d.row * ppg;
        ctx.fillRect(hx + pad, hy - th / 2, wd, th); ctx.strokeRect(hx + pad, hy - th / 2, wd, th);
        ctx.strokeStyle = rgbCss(wallRgb, 0.5); ctx.lineWidth = Math.max(1, ppg * 0.025); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(hx + pad, hy, wd, 0, Math.PI / 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(hx + pad, hy); ctx.lineTo(hx + pad, hy + wd); ctx.stroke();
      } else {
        var vx = d.col * ppg, vy = d.row * ppg;
        ctx.fillRect(vx - th / 2, vy + pad, th, wd); ctx.strokeRect(vx - th / 2, vy + pad, th, wd);
        ctx.strokeStyle = rgbCss(wallRgb, 0.5); ctx.lineWidth = Math.max(1, ppg * 0.025); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(vx, vy + pad, wd, 0, Math.PI / 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vx, vy + pad); ctx.lineTo(vx + wd, vy + pad); ctx.stroke();
      }
    }
  }

  // ---------- features: glyphs + room numbers ----------
  function drawIcon(ctx, kind, cx, cy, s, st) {
    var lw = Math.max(1.2, s * 0.11);
    ctx.strokeStyle = st.wall; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.fillStyle = st.wall;
    function wave(yy) {
      ctx.beginPath();
      for (var k = 0; k <= 16; k++) {
        var t = k / 16, xx = cx - s * 0.4 + t * s * 0.8, yo = Math.sin(t * Math.PI * 2) * s * 0.07;
        if (k === 0) ctx.moveTo(xx, yy + yo); else ctx.lineTo(xx, yy + yo);
      }
      ctx.stroke();
    }
    switch (kind) {
      case 'stairs': {
        var n = 4, tw = s * 0.7, th = s / n, left = cx - tw / 2, baseY = cy + s * 0.35;
        for (var i = 0; i < n; i++) { var yy = baseY - i * th; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(left + tw, yy); ctx.stroke(); }
        ctx.beginPath(); ctx.moveTo(left, baseY); ctx.lineTo(left, baseY - (n - 1) * th); ctx.stroke();
        break;
      }
      case 'water': wave(cy - s * 0.16); wave(cy + s * 0.16); break;
      case 'rubble': {
        var pts = [[-0.3, -0.05], [0.12, -0.22], [0.3, 0.08], [-0.05, 0.22], [-0.26, 0.16]];
        for (var p = 0; p < pts.length; p++) {
          var bx = cx + pts[p][0] * s, by = cy + pts[p][1] * s;
          ctx.beginPath(); ctx.moveTo(bx, by - s * 0.07); ctx.lineTo(bx + s * 0.08, by + s * 0.07); ctx.lineTo(bx - s * 0.08, by + s * 0.07); ctx.closePath(); ctx.fill();
        }
        break;
      }
      case 'column':
        ctx.beginPath(); ctx.moveTo(cx - s * 0.32, cy - s * 0.34); ctx.lineTo(cx + s * 0.32, cy - s * 0.34); ctx.lineTo(cx + s * 0.24, cy - s * 0.22); ctx.lineTo(cx - s * 0.24, cy - s * 0.22); ctx.closePath(); ctx.stroke();
        ctx.strokeRect(cx - s * 0.2, cy - s * 0.2, s * 0.4, s * 0.34);
        for (var f = -1; f <= 1; f++) { ctx.beginPath(); ctx.moveTo(cx + f * s * 0.1, cy - s * 0.2); ctx.lineTo(cx + f * s * 0.1, cy + s * 0.14); ctx.stroke(); }
        ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy + s * 0.2); ctx.lineTo(cx + s * 0.3, cy + s * 0.2); ctx.stroke();
        break;
      case 'statue':
        ctx.beginPath(); ctx.arc(cx, cy - s * 0.22, s * 0.12, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - s * 0.22, cy + s * 0.3); ctx.lineTo(cx - s * 0.12, cy - s * 0.08); ctx.lineTo(cx + s * 0.12, cy - s * 0.08); ctx.lineTo(cx + s * 0.22, cy + s * 0.3); ctx.closePath(); ctx.stroke();
        break;
      case 'altar':
        ctx.strokeRect(cx - s * 0.3, cy - s * 0.28, s * 0.6, s * 0.16);
        ctx.beginPath(); ctx.moveTo(cx - s * 0.22, cy - s * 0.12); ctx.lineTo(cx - s * 0.22, cy + s * 0.26); ctx.moveTo(cx + s * 0.22, cy - s * 0.12); ctx.lineTo(cx + s * 0.22, cy + s * 0.26); ctx.stroke();
        break;
      case 'trap':
        ctx.strokeRect(cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6);
        ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy - s * 0.3); ctx.lineTo(cx + s * 0.3, cy + s * 0.3); ctx.moveTo(cx + s * 0.3, cy - s * 0.3); ctx.lineTo(cx - s * 0.3, cy + s * 0.3); ctx.stroke();
        break;
      case 'chest':
        ctx.strokeRect(cx - s * 0.3, cy - s * 0.1, s * 0.6, s * 0.34);
        ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy - s * 0.1); ctx.lineTo(cx - s * 0.2, cy - s * 0.26); ctx.lineTo(cx + s * 0.2, cy - s * 0.26); ctx.lineTo(cx + s * 0.3, cy - s * 0.1); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy + s * 0.04, s * 0.06, 0, Math.PI * 2); ctx.stroke();
        break;
      case 'pit':
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.32, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.18, 0, Math.PI * 2); ctx.fill();
        break;
      default:
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.16, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawFeatures(ctx, features, ppg, st, floorRgb) {
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var cx = (f.col + 0.5) * ppg, cy = (f.row + 0.5) * ppg, s = ppg * 0.5;
      if (f.kind === 'number') {
        var label = String(f.label);
        var fs = Math.max(8, Math.round((ppg * 0.5) / Math.max(1, label.length * 0.62)));
        ctx.font = 'bold ' + fs + 'px Georgia';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, fs * 0.22); ctx.strokeStyle = rgbCss(floorRgb, 0.9); ctx.lineJoin = 'round';
        ctx.strokeText(label, cx, cy);
        ctx.fillStyle = st.wall; ctx.fillText(label, cx, cy);
      } else {
        // soft halo so glyphs read over any texture
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = rgbCss(floorRgb, 0.5); ctx.fill();
        drawIcon(ctx, f.kind, cx, cy, s, st);
      }
    }
  }

  // ---------- main ----------
  function renderBattleMap(opts) {
    opts = opts || {};
    var walls = opts.walls;
    var floor = opts.floor;
    var doors = opts.doors || [];
    var C = opts.C, R = opts.R;
    var ppg = Math.round(opts.ppg || 80);
    var styleId = STYLES[opts.style] ? opts.style : 'stone';
    var st = STYLES[styleId];
    var texture = FLOOR_TEXTURE_BY_ID[opts.floorTexture] ? opts.floorTexture : 'flat';
    var wallStyle = WALL_STYLE_BY_ID[opts.wallStyle] ? opts.wallStyle : 'solid';

    var W = C * ppg, H = R * ppg;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');

    var floorRgb = hexToRgb(st.floor);
    var wallRgb = hexToRgb(st.wall);
    var floorLum = luma(floorRgb);
    var noise = texture === 'cave' ? makeValueNoise(0x9e3779b9) : null;
    // Grid-on-export controls (step 5). Default keeps the existing look: grid on,
    // palette colour. showGrid:false skips the grid pass entirely.
    var showGrid = opts.showGrid !== false;
    var gridStyle = resolveGridStyle(st, opts);

    // void
    ctx.fillStyle = st.void; ctx.fillRect(0, 0, W, H);

    // floor: base fill + texture (inside floor cells only)
    for (var r = 0; r < R; r++) {
      for (var c = 0; c < C; c++) {
        if (!floor[r * C + c]) continue;
        var x = c * ppg, y = r * ppg;
        ctx.fillStyle = st.floor; ctx.fillRect(x, y, ppg, ppg);
        if (texture === 'flat') continue;
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, ppg, ppg); ctx.clip();
        var cellSeed = (Math.imul(r * C + c + 1, 2654435761)) >>> 0;
        if (texture === 'stonetile') drawStoneTile(ctx, x, y, ppg, floorRgb, cellSeed);
        else if (texture === 'cave') drawCave(ctx, c, r, ppg, floorRgb, noise);
        else if (texture === 'wood') drawWood(ctx, c, r, ppg, floorRgb);
        else if (texture === 'grass') drawGrass(ctx, x, y, ppg, floorRgb, cellSeed);
        else if (texture === 'water') drawWater(ctx, c, r, ppg, floorRgb);
        ctx.restore();
      }
    }

    // grid over floor (skipped when "Grid on export" is off)
    if (showGrid) drawGrid(ctx, floor, C, R, ppg, gridStyle);

    // walls (door edges are skipped so they read as openings)
    drawWalls(ctx, walls, doors, C, R, ppg, st, styleId, wallStyle, floorLum, wallRgb);

    // doors
    drawDoors(ctx, doors, ppg, st, wallRgb);

    // features (icons) + room numbers
    drawFeatures(ctx, opts.features || [], ppg, st, floorRgb);

    return cv;
  }

  // ---------- UI menu catalogs ----------
  var RENDER_STYLES = [
    { id: 'stone', name: 'Stone (classic)' },
    { id: 'blueprint', name: 'Blueprint' },
    { id: 'ink', name: 'Clean ink' },
    { id: 'parchment', name: 'Parchment' },
    { id: 'cavern', name: 'Cavern (dark rock)' },
    { id: 'classic', name: 'Classic (TSR blue)' },
    { id: 'handdrawn', name: 'Hand-drawn' },
    { id: 'scifi', name: 'Sci-fi' }
  ];
  var FLOOR_TEXTURES = [
    { id: 'flat', name: 'Flat' },
    { id: 'stonetile', name: 'Stone tile' },
    { id: 'cave', name: 'Cavern rock' },
    { id: 'wood', name: 'Wood planks' },
    { id: 'grass', name: 'Grass' },
    { id: 'water', name: 'Water' }
  ];
  var WALL_STYLES = [
    { id: 'solid', name: 'Solid' },
    { id: 'double', name: 'Double line' },
    { id: 'stoneblock', name: 'Stone block' },
    { id: 'hatched', name: 'Hatched' }
  ];
  var FLOOR_TEXTURE_BY_ID = {}; FLOOR_TEXTURES.forEach(function (t) { FLOOR_TEXTURE_BY_ID[t.id] = 1; });
  var WALL_STYLE_BY_ID = {}; WALL_STYLES.forEach(function (t) { WALL_STYLE_BY_ID[t.id] = 1; });

  // ---------- exports ----------
  window.DS = window.DS || {};
  Object.assign(window.DS, {
    renderBattleMap: renderBattleMap,
    resolveGridStyle: resolveGridStyle,
    STYLES: STYLES,
    RENDER_STYLES: RENDER_STYLES,
    FLOOR_TEXTURES: FLOOR_TEXTURES,
    WALL_STYLES: WALL_STYLES
  });
})();
