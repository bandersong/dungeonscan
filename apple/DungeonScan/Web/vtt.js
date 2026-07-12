/*
 * Universal VTT exporter (.dd2vtt / .uvtt / .df2vtt) — the format Dungeondraft
 * exports and Foundry/Roll20 importers read. Coordinates are in GRID units,
 * origin top-left, y down. Walls = line_of_sight polylines. Doors = portals,
 * and the wall is GAPPED under each door (that's how VTTs represent openings).
 *
 * Doors are specified as edge refs: {kind:'h'|'v', col, row, open?:bool}
 *   h-edge (col,row) spans grid points (col,row)->(col+1,row)   [horizontal wall line y=row]
 *   v-edge (col,row) spans grid points (col,row)->(col,row+1)   [vertical wall line x=col]
 */
(function () {
  'use strict';

  function cloneWalls(walls) {
    const v = walls.vEdge.map((r) => Uint8Array.from(r));
    const h = walls.hEdge.map((r) => Uint8Array.from(r));
    return { vEdge: v, hEdge: h, C: walls.C, R: walls.R };
  }

  function portalFromDoor(d) {
    let p1, p2;
    if (d.kind === 'h') { p1 = { x: d.col, y: d.row }; p2 = { x: d.col + 1, y: d.row }; }
    else { p1 = { x: d.col, y: d.row }; p2 = { x: d.col, y: d.row + 1 }; }
    const position = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    // Universal VTT rotation is in RADIANS (Dungeondraft/Foundry convention).
    const rotation = d.kind === 'h' ? 0 : Math.PI / 2;
    return { position, bounds: [p1, p2], rotation, closed: d.open ? false : true, freestanding: false };
  }

  /*
   * Build the Universal VTT object.
   *   walls: {vEdge,hEdge,C,R} unit wall edges
   *   doors: [{kind,col,row,open?}]
   *   grid:  {C,R}
   *   pixelsPerGrid: px per cell in the exported base image
   *   imageBase64: PNG base64 WITHOUT the "data:image/png;base64," prefix
   */
  function buildUVTT(opts) {
    const { walls, doors = [], pixelsPerGrid = 100, imageBase64 = '' } = opts;
    const C = walls.C, R = walls.R;

    // gap the walls under each door, then merge into polylines
    const w = cloneWalls(walls);
    for (const d of doors) {
      if (d.kind === 'h') { if (w.hEdge[d.row]) w.hEdge[d.row][d.col] = 0; }
      else { if (w.vEdge[d.row]) w.vEdge[d.row][d.col] = 0; }
    }
    const segs = window.DS.mergeWalls(w);
    const line_of_sight = segs.map((s) => [{ x: s[0].x, y: s[0].y }, { x: s[1].x, y: s[1].y }]);
    const portals = doors.map(portalFromDoor);

    return {
      format: 0.3,
      resolution: {
        map_origin: { x: 0, y: 0 },
        map_size: { x: C, y: R },
        pixels_per_grid: pixelsPerGrid
      },
      line_of_sight,
      objects_line_of_sight: [],
      portals,
      lights: [],
      environment: { baked_lighting: true, ambient_light: 'ffffffff' },
      image: imageBase64
    };
  }

  // Basic validity check (helps catch export regressions in the harness).
  function validateUVTT(u) {
    const errs = [];
    if (u.format == null) errs.push('missing format');
    if (!u.resolution || !u.resolution.pixels_per_grid) errs.push('missing resolution.pixels_per_grid');
    if (!Array.isArray(u.line_of_sight)) errs.push('line_of_sight not array');
    for (const poly of u.line_of_sight || []) {
      if (!Array.isArray(poly) || poly.length < 2) { errs.push('bad wall polyline'); break; }
      for (const pt of poly) if (typeof pt.x !== 'number' || typeof pt.y !== 'number') { errs.push('bad wall point'); break; }
    }
    for (const p of u.portals || []) {
      if (!p.position || !Array.isArray(p.bounds) || p.bounds.length !== 2) { errs.push('bad portal'); break; }
    }
    if (typeof u.image !== 'string') errs.push('image not a string');
    return { ok: errs.length === 0, errors: errs };
  }

  window.DS = window.DS || {};
  Object.assign(window.DS, { buildUVTT, validateUVTT, portalFromDoor });
})();
