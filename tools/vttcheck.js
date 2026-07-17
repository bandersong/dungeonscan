/*
 * Universal VTT (.dd2vtt/.uvtt) STRICT round-trip validator.
 *
 * renderer/vtt.js's validateUVTT only checks shape (arrays are arrays, x/y are
 * numbers). This checks the contract as actually CONSUMED by real importers:
 * units, ranges, and cross-field consistency that a shape-checker can't catch
 * (e.g. a wall segment that shape-validates fine but sits entirely outside
 * map_size, which Foundry's dd-import silently drops on import).
 *
 * Sources (see docs/RESEARCH.md §6 for the full citation trail):
 *   - Arkenforge's public UVTT spec writeup (arkenforge.com/universal-vtt-files)
 *     — canonical field list, units = "Squares", rotation = radians, image =
 *     base64 PNG or WEBP.
 *   - moo-man/FVTT-DD-Import `ddimport.js` (the Foundry "dd-import" /
 *     "Universal Battlemap Importer" module, ~30k installs) — the actual
 *     consumption logic. Confirmed by reading the source directly:
 *       - resolution.map_size.{x,y} and resolution.map_origin.{x,y} are
 *         dereferenced with NO null-guard (`file.resolution.map_size.x`) —
 *         missing either is a hard crash, not a soft default.
 *       - resolution.pixels_per_grid falls back to 100 if falsy (only field
 *         with a documented default).
 *       - line_of_sight / portals.bounds points are GRID-SQUARE units:
 *         converted to px via `(pt.x - map_origin.x) * pixels_per_grid`.
 *       - GetWalls() only keeps a wall segment if `isWithinMap(A) ||
 *         isWithinMap(B)` — a segment with BOTH endpoints outside
 *         [map_origin, map_origin+map_size] is silently dropped.
 *       - GetDoors() reads ONLY `portals[].bounds` — `position` and
 *         `rotation` are never read by this importer. They're spec-correct
 *         but dead weight for dd-import specifically (Arkenforge's own
 *         closed-source Toolkit may still use them).
 *       - `portals[].closed` drives door sense-type (NORMAL vs PROXIMITY);
 *         `freestanding` is never read.
 *       - `lights[].color` is consumed as `"#" + color.substring(2)` —
 *         i.e. an 8-hex-digit AARRGGBB-ish string with the first byte
 *         stripped as alpha. `lights[].shadows` is never read.
 *       - `environment.*` is round-tripped through multi-level merges but
 *         never applied to the Foundry scene (no darkness/globalLight wire-up
 *         found anywhere in ddimport.js) — spec-correct, functionally inert.
 *       - image magic-byte sniff: 0x89504E47->png, "RIFF"->webp,
 *         0xFFD8FFE0->jpeg, ANYTHING ELSE SILENTLY TREATED AS PNG.
 *   - _checkFileContents() (dd-import's own pre-import validator) is an EMPTY
 *     STUB — real consumers do essentially no defensive validation, which is
 *     the whole reason this checker exists as a pre-flight.
 *
 * Usage:
 *   node tools/vttcheck.js <file.dd2vtt> [more files...]
 *   node tools/vttcheck.js --self-test        (validator self-check, no files)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HEX8 = /^[0-9a-f]{8}$/i;

function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function bool(v) { return typeof v === 'boolean'; }
function pt(v) { return v && num(v.x) && num(v.y); }
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

// ---- image sniff: PNG IHDR gives us width/height with no zlib needed -----
function sniffImage(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { type: 'webp', width: null, height: null }; // dimension parsing needs VP8/VP8L/VP8X chunk sniff; not needed for our exports (always PNG)
  }
  return { type: 'unknown', width: null, height: null };
}

// ---- the strict checker ----------------------------------------------
// Returns array of {field, sev: 'error'|'warn', msg}
function checkUVTT(u) {
  const v = [];
  const err = (field, msg) => v.push({ field, sev: 'error', msg });
  const warn = (field, msg) => v.push({ field, sev: 'warn', msg });

  if (!num(u.format)) err('format', 'missing/non-numeric (dd-import does not require it, but every real exporter sets it)');

  const res = u.resolution || {};
  if (!pt(res.map_origin)) err('resolution.map_origin', 'missing/non-numeric x,y — dd-import dereferences this with no guard (hard crash on import)');
  if (!res.map_size || !num(res.map_size.x) || !num(res.map_size.y) || res.map_size.x <= 0 || res.map_size.y <= 0) {
    err('resolution.map_size', 'missing/non-positive x,y — dd-import dereferences this with no guard (hard crash on import)');
  }
  if (!num(res.pixels_per_grid) || res.pixels_per_grid <= 0) {
    err('resolution.pixels_per_grid', 'missing/non-positive (dd-import falls back to 100 only if falsy — 0/negative slips through)');
  } else if (!Number.isInteger(res.pixels_per_grid)) {
    warn('resolution.pixels_per_grid', `${res.pixels_per_grid} is not an integer (Arkenforge spec: "number of pixels per square", documented as integer)`);
  }

  const originX = pt(res.map_origin) ? res.map_origin.x : 0;
  const originY = pt(res.map_origin) ? res.map_origin.y : 0;
  const sizeX = (res.map_size && res.map_size.x) || 0;
  const sizeY = (res.map_size && res.map_size.y) || 0;
  const within = (p) => p.x >= originX && p.x <= originX + sizeX && p.y >= originY && p.y <= originY + sizeY;

  if (!Array.isArray(u.line_of_sight)) {
    err('line_of_sight', 'not an array');
  } else {
    u.line_of_sight.forEach((poly, i) => {
      if (!Array.isArray(poly) || poly.length < 2) { err(`line_of_sight[${i}]`, 'polyline needs >=2 points'); return; }
      poly.forEach((p, j) => { if (!pt(p)) err(`line_of_sight[${i}][${j}]`, 'point missing numeric x,y'); });
      for (let k = 0; k + 1 < poly.length; k++) {
        const a = poly[k], b = poly[k + 1];
        if (pt(a) && pt(b) && !within(a) && !within(b)) {
          warn(`line_of_sight[${i}] seg${k}`, `both endpoints (${a.x},${a.y})-(${b.x},${b.y}) outside map bounds [${originX},${originY}]..[${originX + sizeX},${originY + sizeY}] — dd-import's isWithinMap(A)||isWithinMap(B) test silently drops this wall`);
        }
      }
    });
  }

  if (!Array.isArray(u.objects_line_of_sight)) err('objects_line_of_sight', 'not an array (schema requires the key to exist even if empty)');

  if (!Array.isArray(u.portals)) {
    err('portals', 'not an array');
  } else {
    u.portals.forEach((p, i) => {
      const f = `portals[${i}]`;
      if (!pt(p.position)) { err(f + '.position', 'missing numeric x,y'); }
      if (!Array.isArray(p.bounds) || p.bounds.length !== 2 || !pt(p.bounds[0]) || !pt(p.bounds[1])) {
        err(f + '.bounds', 'must be exactly 2 points with numeric x,y');
      } else {
        const [b0, b1] = p.bounds;
        if (pt(p.position)) {
          const mx = (b0.x + b1.x) / 2, my = (b0.y + b1.y) / 2;
          if (!near(p.position.x, mx, 1e-6) || !near(p.position.y, my, 1e-6)) {
            err(f + '.position', `(${p.position.x},${p.position.y}) is not the midpoint of bounds (${mx},${my})`);
          }
        }
        const dx = b1.x - b0.x, dy = b1.y - b0.y;
        const onGridEdge = Number.isInteger(b0.x) && Number.isInteger(b0.y) &&
          ((Math.abs(dx) === 1 && dy === 0) || (dx === 0 && Math.abs(dy) === 1));
        if (!onGridEdge) {
          warn(f + '.bounds', `(${b0.x},${b0.y})-(${b1.x},${b1.y}) is not a single axis-aligned unit-grid edge (doors are expected to gap exactly one cell edge)`);
        } else if (num(p.rotation)) {
          const wantRotation = dy === 0 ? 0 : Math.PI / 2;
          if (!near(((p.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), wantRotation, 1e-6)) {
            warn(f + '.rotation', `${p.rotation} rad doesn't match bounds orientation (expected ${wantRotation.toFixed(4)}) — dd-import ignores rotation entirely so this is silent until an Arkenforge-Toolkit import`);
          }
        }
      }
      if (!num(p.rotation)) err(f + '.rotation', 'missing/non-numeric (must be radians per spec)');
      else if (Math.abs(p.rotation) > 2 * Math.PI + 1e-6) warn(f + '.rotation', `${p.rotation} is outside [-2π,2π] — looks like it might be degrees, not radians`);
      if (!bool(p.closed)) err(f + '.closed', 'missing/non-boolean');
      if (!bool(p.freestanding)) err(f + '.freestanding', 'missing/non-boolean');
    });
  }

  if (!Array.isArray(u.lights)) {
    err('lights', 'not an array');
  } else {
    u.lights.forEach((l, i) => {
      const f = `lights[${i}]`;
      if (!pt(l.position)) err(f + '.position', 'missing numeric x,y');
      if (!num(l.range) || l.range < 0) err(f + '.range', 'missing/negative (grid-square units per Arkenforge)');
      if (!num(l.intensity) || l.intensity < 0) err(f + '.intensity', 'missing/negative');
      if (typeof l.color !== 'string' || !HEX8.test(l.color)) {
        err(f + '.color', `expected 8 hex digits (dd-import reads "#"+color.substring(2), i.e. alpha byte + RGB); got ${JSON.stringify(l.color)}`);
      }
      if (!bool(l.shadows)) err(f + '.shadows', 'missing/non-boolean (dd-import never reads this — cosmetic gap only, not a crash risk)');
    });
  }

  const env = u.environment || {};
  if (!bool(env.baked_lighting)) err('environment.baked_lighting', 'missing/non-boolean');
  if (typeof env.ambient_light !== 'string' || !HEX8.test(env.ambient_light)) {
    err('environment.ambient_light', `expected 8 hex digits; got ${JSON.stringify(env.ambient_light)} (note: no known Foundry importer actually applies this field to the scene)`);
  }

  if (typeof u.image !== 'string' || !u.image) {
    err('image', 'missing/empty string');
  } else {
    let buf;
    try { buf = Buffer.from(u.image, 'base64'); } catch (e) { err('image', 'not valid base64'); }
    if (buf) {
      const sniff = sniffImage(buf);
      if (sniff.type === 'unknown') {
        err('image', 'does not decode as PNG or WEBP (dd-import silently mislabels unrecognized magic bytes as .png, corrupting the file on disk)');
      } else if (sniff.type === 'png') {
        const wantW = Math.round(sizeX * res.pixels_per_grid);
        const wantH = Math.round(sizeY * res.pixels_per_grid);
        if (sniff.width !== wantW || sniff.height !== wantH) {
          err('image', `decoded PNG is ${sniff.width}x${sniff.height}, expected map_size*pixels_per_grid = ${wantW}x${wantH} (Foundry stretches the background to scene width/height regardless, so a mismatch here silently distorts the map)`);
        }
      }
    }
  }

  return v;
}

// --------------------------------------------------------------- CLI ---
function printReport(file, violations) {
  const errors = violations.filter((x) => x.sev === 'error');
  const warns = violations.filter((x) => x.sev === 'warn');
  console.log(`\n${path.basename(file)}: ${errors.length} error, ${warns.length} warn`);
  for (const x of violations) console.log(`  [${x.sev.toUpperCase()}] ${x.field}: ${x.msg}`);
  if (!violations.length) console.log('  (clean)');
  return errors.length;
}

function selfTest() {
  // ponytail: one runnable check per checker branch, not a framework.
  const assert = require('assert');
  const good = {
    format: 0.3,
    resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 4, y: 4 }, pixels_per_grid: 10 },
    line_of_sight: [[{ x: 0, y: 0 }, { x: 4, y: 0 }]],
    objects_line_of_sight: [],
    portals: [{ position: { x: 0.5, y: 0 }, bounds: [{ x: 0, y: 0 }, { x: 1, y: 0 }], rotation: 0, closed: true, freestanding: false }],
    lights: [{ position: { x: 1, y: 1 }, range: 5, intensity: 1, color: 'ffffffff', shadows: true }],
    environment: { baked_lighting: true, ambient_light: 'ffffffff' },
    image: makeTestPNG(40, 40).toString('base64'),
  };
  assert.deepStrictEqual(checkUVTT(good), [], 'known-good UVTT must produce zero violations');

  const badOrigin = JSON.parse(JSON.stringify(good)); delete badOrigin.resolution.map_origin;
  assert.ok(checkUVTT(badOrigin).some((x) => x.field === 'resolution.map_origin'), 'missing map_origin must be flagged');

  const droppedWall = JSON.parse(JSON.stringify(good));
  droppedWall.line_of_sight.push([{ x: 100, y: 100 }, { x: 101, y: 100 }]);
  assert.ok(checkUVTT(droppedWall).some((x) => /outside map bounds/.test(x.msg)), 'out-of-bounds wall segment must be flagged');

  const badPortal = JSON.parse(JSON.stringify(good));
  badPortal.portals[0].bounds = [{ x: 0, y: 0 }, { x: 2, y: 0 }]; // 2-unit span, not a single cell edge
  assert.ok(checkUVTT(badPortal).some((x) => x.field === 'portals[0].bounds'), 'non-cell-edge portal bounds must be flagged');

  const badDims = JSON.parse(JSON.stringify(good));
  badDims.image = makeTestPNG(10, 10).toString('base64'); // should be 40x40
  assert.ok(checkUVTT(badDims).some((x) => x.field === 'image'), 'image/grid dimension mismatch must be flagged');

  console.log('vttcheck self-test: PASS (5/5 assertions)');
}

// Minimal 8-bit RGBA PNG encoder (uncompressed zlib stored blocks) — self-test only.
function makeTestPNG(w, h) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0; // filter byte 'none'
  const idat = zlib.deflateSync(raw);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeData), 0);
    return Buffer.concat([len, typeData, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') { selfTest(); return; }
  if (!args.length) {
    console.error('usage: node tools/vttcheck.js <file.dd2vtt> [...] | --self-test');
    process.exit(2);
  }
  let totalErrors = 0;
  for (const file of args) {
    const u = JSON.parse(fs.readFileSync(file, 'utf8'));
    totalErrors += printReport(file, checkUVTT(u));
  }
  console.log(`\n${args.length} file(s), ${totalErrors} total error(s).`);
  process.exit(totalErrors ? 1 : 0);
}

if (require.main === module) main();
module.exports = { checkUVTT, sniffImage };
