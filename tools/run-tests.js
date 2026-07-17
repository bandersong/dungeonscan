/*
 * Test runner for DungeonScan's headless renderer tests.
 *
 * The test files (renderer/*.test.js) are self-contained: each loads the
 * renderer modules under a tiny canvas shim, runs its assertions, and exits
 * 0 on pass / non-zero on fail. This runner just invokes them in sequence,
 * propagates the failure, and prints a summary — so `npm test` (and CI) get
 * one command that fails the moment any suite fails.
 *
 *   node tools/run-tests.js
 *   npm test
 *
 * Add a new suite by dropping another `renderer/<name>.test.js` that exits
 * non-zero on failure; list it in SUITES below.
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'renderer/perspective.test.js',
  'renderer/features.test.js',
];

const root = path.join(__dirname, '..');
let failed = 0;

for (const suite of SUITES) {
  const file = path.join(root, suite);
  process.stdout.write('\n=== ' + suite + ' ===\n');
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stdout.write('  -> ' + suite + ' FAILED (exit ' + r.status + ')\n');
    failed++;
  } else {
    process.stdout.write('  -> ' + suite + ' OK\n');
  }
}

process.stdout.write(
  '\n────────────────────────────────────────\n' +
  'TESTS: ' + (SUITES.length - failed) + '/' + SUITES.length + ' suites passed' +
  (failed ? ' (' + failed + ' FAILED)' : '') + '\n'
);
process.exit(failed ? 1 : 0);
