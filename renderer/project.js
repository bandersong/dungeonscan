/*
 * Project save / reload for DungeonScan. Pure (de)serialization of the full
 * working state to/from a versioned `.dungeonscan` JSON document — no DOM, no
 * canvas, so it round-trips identically in the app and under a headless test.
 *
 * The app controller owns the mapping between its live `S` state and the plain
 * object this module understands; this module only owns the JSON shape:
 *
 *   DS.project.serialize(state)   state -> JSON string
 *       state.terrain may be a Map ("col,row" -> terrainId); it is stored as an
 *       entries array. Everything else is plain JSON.
 *   DS.project.deserialize(text)  JSON string -> state object
 *       Validates the app tag + version, revives terrain back into a Map, and
 *       guarantees the optional fields exist (with defaults) so callers can read
 *       them without guarding every key. Throws on a foreign/corrupt document.
 *
 * Kept separate from app.js on purpose: the round-trip is the one piece of the
 * save/load flow worth pinning down with a regression test, and it must not
 * depend on the DOM.
 */
(function () {
  'use strict';

  var APP = 'DungeonScan';
  var VERSION = 1;

  // Default values for optional fields, merged into every deserialized project
  // so app.js can read state.<field> unconditionally (old/miminal files included).
  var DEFAULTS = {
    mode: 'square',
    hexGrid: null,
    walls: null,
    floor: null,
    doors: [],
    features: [],
    stamps: [],
    terrain: [],          // revived to a Map by deserialize
    style: 'stone',
    floorTexture: 'flat',
    wallStyle: 'solid',
    hexStyle: 'parchment',
    hexTerrain: 'plains',
    hexReady: false,
    ppg: 80,
    lineSensitivity: 0.5,
    invertPaper: false,
    deskew: 0,
    showLegend: false,
    gridOnExport: true,
    gridColor: '',
    gridOpacity: null
  };

  function serialize(state) {
    var o = Object.assign({}, state || {});
    o.app = APP;
    o.version = VERSION;
    // Map -> entries array (JSON has no Map). Accept an array too, defensively.
    if (o.terrain instanceof Map) o.terrain = Array.from(o.terrain.entries());
    else if (Array.isArray(o.terrain)) o.terrain = o.terrain.slice();
    else o.terrain = [];
    return JSON.stringify(o);
  }

  function deserialize(text) {
    var obj = typeof text === 'string' ? JSON.parse(text) : text;
    if (!obj || obj.app !== APP) {
      throw new Error('Not a DungeonScan project file.');
    }
    if (typeof obj.version === 'number' && obj.version > VERSION) {
      throw new Error('This project was saved by a newer DungeonScan (v' + obj.version + ').');
    }
    var out = Object.assign({}, DEFAULTS, obj);
    // revive terrain entries -> Map, dropping malformed keys
    var terr = new Map();
    var entries = Array.isArray(obj.terrain) ? obj.terrain : [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && e.length === 2 && typeof e[0] === 'string') terr.set(e[0], e[1]);
    }
    out.terrain = terr;
    return out;
  }

  window.DS = window.DS || {};
  window.DS.project = {
    APP: APP,
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    serialize: serialize,
    deserialize: deserialize
  };
})();
