/*
 * Battle-map exporters — dependency-free. Everything is hand-rolled: no jspdf,
 * no pdf-lib, no fabric. The PDFs are assembled byte-by-byte (header → objects →
 * xref → trailer) so they open in Preview / qlmanage / Acrobat with zero deps.
 *
 * Contract: these helpers take a rendered battle-map <canvas> (the output of
 * DS.renderBattleMap, sized C*ppg × R*ppg) plus grid info {C, R, ppg}.
 *
 *   C, R   grid columns / rows           (squares)
 *   ppg    pixels per grid square         (px)
 *
 * Grid info may be passed inside the opts object of any function as
 * {C, R, ppg}; if only ppg is given, C and R are derived from the canvas dims.
 *
 * Exports:
 *   DS.canvasToDataURL(canvas, fmt)                         -> data URL
 *   DS.buildPDF(canvas, opts)                               -> Uint8Array
 *   DS.buildTiledPDF(canvas, opts)                          -> Uint8Array
 *   DS.toFoundryScene(uvtt, name)                           -> Scene object
 *   DS.EXPORT_FORMATS                                       -> [{id,name,ext,kind}]
 *
 * buildPDF opts:        { C, R, ppg, inchesPerSquare=1.0, quality=0.85 }
 * buildTiledPDF opts:   { C, R, ppg, inchesPerSquare=1.0, pageW=8.5, pageH=11,
 *                          margin=0.3, overlap=0.25, cutMarks=true, label=true,
 *                          quality=0.85 }
 */
(function () {
  'use strict';

  // ---------- small byte/string helpers (Latin-1, one char == one byte) --------

  function latin1ToBytes(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  // Append-only byte buffer; tracks total length so we can record object offsets.
  function Buf() {
    this.parts = [];
    this.len = 0;
  }
  Buf.prototype.pushStr = function (s) {
    var b = latin1ToBytes(s);
    this.parts.push(b);
    this.len += b.length;
  };
  Buf.prototype.pushBytes = function (b) {
    this.parts.push(b);
    this.len += b.length;
  };
  Buf.prototype.offset = function () { return this.len; };
  Buf.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.len);
    var p = 0;
    for (var i = 0; i < this.parts.length; i++) {
      out.set(this.parts[i], p);
      p += this.parts[i].length;
    }
    return out;
  };

  function pad10(n) { n = String(n); while (n.length < 10) n = '0' + n; return n; }
  function fmtNum(n) { return String(Math.round(n * 1000) / 1000); }

  // ---------- grid resolution ----------

  function resolveGrid(canvas, opts) {
    opts = opts || {};
    var C = opts.C, R = opts.R, ppg = opts.ppg;
    if (ppg && (!C || !R)) {
      C = C || Math.max(1, Math.round(canvas.width / ppg));
      R = R || Math.max(1, Math.round(canvas.height / ppg));
    }
    if (!ppg && C) ppg = canvas.width / C;
    return { C: C || 1, R: R || 1, ppg: ppg || canvas.width };
  }

  // ---------- canvas -> image bytes ----------

  function canvasToDataURL(canvas, fmt) {
    fmt = (fmt || 'png').toLowerCase();
    var mime;
    if (fmt === 'jpg' || fmt === 'jpeg') mime = 'image/jpeg';
    else if (fmt === 'webp') mime = 'image/webp';
    else { mime = 'image/png'; fmt = 'png'; }
    // PNG ignores the quality arg; pass it only for lossy formats.
    return mime === 'image/png'
      ? canvas.toDataURL(mime)
      : canvas.toDataURL(mime, 0.92);
  }

  // Returns { bytes:Uint8Array (raw JPEG), w, h }.
  function encodeJPEG(canvas, quality) {
    var url = canvas.toDataURL('image/jpeg', quality == null ? 0.85 : quality);
    var comma = url.indexOf(',');
    var b64 = comma >= 0 ? url.slice(comma + 1) : url;
    return { bytes: b64ToBytes(b64), w: canvas.width, h: canvas.height };
  }

  // Offscreen slice of a canvas at integer pixel coords (for tiled PDF).
  function sliceCanvas(src, sx, sy, sw, sh) {
    var c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    return c;
  }

  // =====================================================================
  //  PDF assembly — single internal routine for any number of pages.
  //  Each page carries its own JPEG XObject (DCTDecode), drawn into a rect,
  //  plus an optional extra content stream (cut marks + label).
  // =====================================================================

  // page = { mediaW, mediaH (points), img:{bytes,w,h},
  //          place:{x,y,w,h (points)}, extra:''|contentOps }
  function assemblePDF(pages) {
    var buf = new Buf();
    buf.pushStr('%PDF-1.4\n');
    buf.pushStr('%\xe2\xe3\xcf\xd3\n'); // binary marker comment

    var offsets = {};      // object number -> byte offset of "N 0 obj"
    var nextId = 1;
    var catalogId = nextId++;
    var pagesId = nextId++;
    var fontId = nextId++;   // shared Helvetica (standard 14, no embedding)

    var pageEntries = pages.map(function () {
      return { imageId: nextId++, contentsId: nextId++, pageId: nextId++ };
    });

    function writeObj(id, content) {
      offsets[id] = buf.offset();
      buf.pushStr(id + ' 0 obj\n');
      if (typeof content === 'string') buf.pushStr(content);
      else content(buf);                 // function form: for streams
      buf.pushStr('\nendobj\n');
    }

    // 1. Catalog
    writeObj(catalogId, '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');

    // 2. Pages
    var kids = pageEntries.map(function (e) { return e.pageId + ' 0 R'; }).join(' ');
    writeObj(pagesId, '<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>');

    // 3. Font (Type1 BaseFont, standard 14)
    writeObj(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

    // 4. Per-page image / contents / page objects
    pages.forEach(function (pg, i) {
      var e = pageEntries[i];
      var img = pg.img;

      // image XObject (DCTDecode = raw JPEG in the stream)
      writeObj(e.imageId, function (buf) {
        buf.pushStr(
          '<< /Type /XObject /Subtype /Image /Width ' + img.w +
          ' /Height ' + img.h +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
          ' /Filter /DCTDecode /Length ' + img.bytes.length + ' >>\n'
        );
        buf.pushStr('stream\n');
        buf.pushBytes(img.bytes);
        buf.pushStr('\nendstream');
      });

      // contents stream: draw image into place rect, then any extras
      var cs = '';
      cs += 'q\n';
      cs += fmtNum(pg.place.w) + ' 0 0 ' + fmtNum(pg.place.h) + ' ' +
            fmtNum(pg.place.x) + ' ' + fmtNum(pg.place.y) + ' cm\n';
      cs += '/Im' + i + ' Do\n';
      cs += 'Q\n';
      if (pg.extra) cs += pg.extra;
      var csBytes = latin1ToBytes(cs);

      writeObj(e.contentsId, function (buf) {
        buf.pushStr('<< /Length ' + csBytes.length + ' >>\n');
        buf.pushStr('stream\n');
        buf.pushBytes(csBytes);
        buf.pushStr('\nendstream');
      });

      // page object
      var mediabox = '[0 0 ' + fmtNum(pg.mediaW) + ' ' + fmtNum(pg.mediaH) + ']';
      writeObj(e.pageId,
        '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox ' + mediabox +
        ' /Resources << /XObject << /Im' + i + ' ' + e.imageId + ' 0 R >>' +
        ' /Font << /F1 ' + fontId + ' 0 R >> >>' +
        ' /Contents ' + e.contentsId + ' 0 R >>'
      );
    });

    // 5. xref + trailer
    var maxId = nextId - 1;
    var size = maxId + 1;          // includes the free object 0
    var xrefOffset = buf.offset();
    buf.pushStr('xref\n');
    buf.pushStr('0 ' + size + '\n');
    buf.pushStr('0000000000 65535 f\r\n');             // free head (exactly 20 bytes)
    for (var id = 1; id <= maxId; id++) {
      buf.pushStr(pad10(offsets[id] || 0) + ' 00000 n\r\n');   // 20 bytes each
    }
    buf.pushStr('trailer\n');
    buf.pushStr('<< /Size ' + size + ' /Root ' + catalogId + ' 0 R >>\n');
    buf.pushStr('startxref\n');
    buf.pushStr(xrefOffset + '\n');
    buf.pushStr('%%EOF');

    return buf.toUint8Array();
  }

  // ---------- cut marks + tile label (content-stream ops) ----------

  function cutMarksOps(x, y, w, h) {
    var m = 8; // tick length, points
    var corners = [
      [x, y, -1, -1], [x + w, y, 1, -1],
      [x, y + h, -1, 1], [x + w, y + h, 1, 1]
    ];
    var s = '0.5 w 0 0 0 RG\n';
    for (var i = 0; i < corners.length; i++) {
      var c = corners[i], cx = c[0], cy = c[1], dx = c[2], dy = c[3];
      s += fmtNum(cx) + ' ' + fmtNum(cy) + ' m ' + fmtNum(cx + dx * m) + ' ' + fmtNum(cy) + ' l S\n';
      s += fmtNum(cx) + ' ' + fmtNum(cy) + ' m ' + fmtNum(cx) + ' ' + fmtNum(cy + dy * m) + ' l S\n';
    }
    return s;
  }

  function labelOps(x, baseY, row, col) {
    var txt = ('row ' + row + ', col ' + col).replace(/([()\\])/g, '\\$1');
    return 'BT /F1 8 Tf ' + fmtNum(x + 2) + ' ' + fmtNum(baseY - 10) +
           ' Td (' + txt + ') Tj ET\n';
  }

  // =====================================================================
  //  Public: single-page PDF
  // =====================================================================

  function buildPDF(canvas, opts) {
    opts = opts || {};
    var g = resolveGrid(canvas, opts);
    var ips = opts.inchesPerSquare != null ? opts.inchesPerSquare : 1.0;
    var quality = opts.quality != null ? opts.quality : 0.85;

    var pageW_in = g.C * ips;        // 1 square == inchesPerSquare inches
    var pageH_in = g.R * ips;
    var img = encodeJPEG(canvas, quality);

    return assemblePDF([{
      mediaW: pageW_in * 72,
      mediaH: pageH_in * 72,
      img: img,
      place: { x: 0, y: 0, w: pageW_in * 72, h: pageH_in * 72 },
      extra: ''
    }]);
  }

  // =====================================================================
  //  Public: multi-page tiled PDF (print a real-scale battle map for minis)
  // =====================================================================

  function buildTiledPDF(canvas, opts) {
    opts = opts || {};
    var g = resolveGrid(canvas, opts);
    var ips = opts.inchesPerSquare != null ? opts.inchesPerSquare : 1.0;
    var pageW = opts.pageW != null ? opts.pageW : 8.5;
    var pageH = opts.pageH != null ? opts.pageH : 11;
    var margin = opts.margin != null ? opts.margin : 0.3;
    var overlap = opts.overlap != null ? opts.overlap : 0.25;
    var cutMarks = opts.cutMarks !== false;
    var label = opts.label !== false;
    var quality = opts.quality != null ? opts.quality : 0.85;

    var W_in = g.C * ips;
    var H_in = g.R * ips;
    var usableW = pageW - 2 * margin;
    var usableH = pageH - 2 * margin;
    if (usableW <= 0 || usableH <= 0) {
      throw new Error('tiled PDF: margins too large for page size');
    }
    // step = how far each tile advances; tiles overlap by `overlap` inches.
    var stepX = Math.max(0.01, usableW - overlap);
    var stepY = Math.max(0.01, usableH - overlap);
    var nx = Math.max(1, Math.ceil((W_in - overlap) / stepX));
    var ny = Math.max(1, Math.ceil((H_in - overlap) / stepY));

    var ppi = canvas.width / W_in;   // source pixels per map-inch (== ppg / ips)

    var pages = [];
    for (var row = 0; row < ny; row++) {
      for (var col = 0; col < nx; col++) {
        var x0 = col * stepX, y0 = row * stepY;
        var rw = Math.min(usableW, W_in - x0);     // tile content size, inches
        var rh = Math.min(usableH, H_in - y0);

        var sx = Math.max(0, Math.round(x0 * ppi));
        var sy = Math.max(0, Math.round(y0 * ppi));
        var sw = Math.max(1, Math.min(canvas.width - sx, Math.round(rw * ppi)));
        var sh = Math.max(1, Math.min(canvas.height - sy, Math.round(rh * ppi)));

        var slice = sliceCanvas(canvas, sx, sy, sw, sh);
        var img = encodeJPEG(slice, quality);

        var placeX = margin * 72, placeY = margin * 72;
        var placeW = rw * 72, placeH = rh * 72;

        var extra = '';
        if (cutMarks) extra += cutMarksOps(placeX, placeY, placeW, placeH);
        if (label) extra += labelOps(placeX, placeY, row, col);

        pages.push({
          mediaW: pageW * 72,
          mediaH: pageH * 72,
          img: img,
          place: { x: placeX, y: placeY, w: placeW, h: placeH },
          extra: extra
        });
      }
    }
    return assemblePDF(pages);
  }

  // =====================================================================
  //  Public: Foundry VTT Scene from a Universal-VTT object
  // =====================================================================
  //
  //  UVTT walls (line_of_sight) are in GRID units; Foundry walls are in PX.
  //  Portals become door walls (door:1), gapped open ones flagged ds:1.
  //  Compatible with Foundry v10–v12 scene schema.

  function foundryWall(p1, p2, ppg, door, open) {
    // No light/sight/sound/move keys: the old explicit 0 meant
    // WALL_SENSE_TYPES.NONE — walls that block nothing (tokens, vision and
    // light pass straight through). Omitting the keys lets Foundry's schema
    // default (NORMAL, blocking) apply at Scene.create(), which is exactly
    // what the dd-import module relies on for its own walls.
    return {
      c: [Math.round(p1.x * ppg), Math.round(p1.y * ppg),
          Math.round(p2.x * ppg), Math.round(p2.y * ppg)],
      dir: 0,
      door: door || 0,
      ds: open ? 1 : 0
    };
  }

  function foundryId() {
    var hex = '0123456789abcdef', s = '';
    for (var i = 0; i < 16; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }

  function toFoundryScene(uvtt, name) {
    var res = (uvtt && uvtt.resolution) || {};
    var ppg = res.pixels_per_grid || 100;
    var ms = res.map_size || { x: 0, y: 0 };
    var width = Math.round(ms.x * ppg);
    var height = Math.round(ms.y * ppg);

    var walls = [];
    (uvtt.line_of_sight || []).forEach(function (poly) {
      if (!poly || poly.length < 2) return;
      for (var i = 0; i + 1 < poly.length; i++) {
        walls.push(foundryWall(poly[i], poly[i + 1], ppg, 0, false));
      }
    });
    (uvtt.portals || []).forEach(function (p) {
      var b = p && p.bounds;
      if (b && b.length === 2) {
        walls.push(foundryWall(b[0], b[1], ppg, 1, p.closed === false));
      }
    });

    return {
      _id: foundryId(),
      name: name || 'Imported Scene',
      active: false,
      navigation: true,
      navOrder: 0,
      img: '',
      width: width,
      height: height,
      padding: 0,
      initial: { x: 0, y: 0, scale: 0.5 },
      backgroundColor: '#000000',
      grid: {
        size: ppg,
        type: 1,                 // 1 = square grid
        distance: 5,             // 5 ft per square (D&D standard) — 1 made every ruler/template read 5x short
        units: 'ft',
        alpha: 0.2,
        color: '#000000'
      },
      tokenVision: true,
      fogExploration: true,
      fogReset: 0,
      globalLight: true,
      globalLightThreshold: null,
      darkness: 0,
      walls: walls,
      lights: [],
      sounds: [],
      drawings: [],
      tiles: [],
      notes: [],
      templates: [],
      tokens: [],
      thumb: '',
      flags: {}
    };
  }

  // ---------- UI format list ----------

  var EXPORT_FORMATS = [
    { id: 'png',          name: 'PNG Image',         ext: 'png',    kind: 'image' },
    { id: 'jpg',          name: 'JPEG Image',        ext: 'jpg',    kind: 'image' },
    { id: 'webp',         name: 'WebP Image',        ext: 'webp',   kind: 'image' },
    { id: 'pdf',          name: 'PDF (single page)', ext: 'pdf',    kind: 'pdf' },
    { id: 'pdf-tiled',    name: 'PDF (tiled print)', ext: 'pdf',    kind: 'pdf' },
    { id: 'dd2vtt',       name: 'Universal VTT',     ext: 'dd2vtt', kind: 'vtt' },
    { id: 'foundry-json', name: 'Foundry Scene',     ext: 'json',   kind: 'json' }
  ];

  // ---------- exports ----------

  window.DS = window.DS || {};
  Object.assign(window.DS, {
    canvasToDataURL: canvasToDataURL,
    buildPDF: buildPDF,
    buildTiledPDF: buildTiledPDF,
    toFoundryScene: toFoundryScene,
    EXPORT_FORMATS: EXPORT_FORMATS
  });
})();
