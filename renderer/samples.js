/*
 * Sample "photos" for the try-a-pretend-one feature — reuses the synthetic
 * generator so someone can exercise the whole flow without their own drawing.
 */
(function () {
  'use strict';
  const specs = [
    { seed: 3, C: 26, R: 18, cell: 30, name: 'Crypt' },
    { seed: 88, C: 30, R: 20, cell: 26, name: 'Caverns' }
  ];
  window.DSSamples = specs.map((sp) => {
    const g = DS.testgen({ seed: sp.seed, C: sp.C, R: sp.R, cell: sp.cell, jitter: 1.8, noiseAmt: 26 });
    return { name: sp.name, dataUrl: g.canvas.toDataURL('image/png') };
  });
})();
