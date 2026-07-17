# External holdout set — sources & licenses

Images in this directory are **not committed** (see .gitignore) — they are
third-party works fetched locally for testing only. This file is the tracked
record: what to fetch, from where, under what terms, and the pre-registered
ground truth for the ones that have been zoom-verified.

Rebuild the set by downloading each URL below into this directory with the
listed filename.

## Dyson Logos (dysonlogos.blog) — free commercial license WITH attribution
Clean pro scans, freehand-drawn faint grid, dense hatching, NO printed dot/graph paper.

| file | url |
|---|---|
| dyson-flooded-catacombs.png | https://dysonlogos.blog/wp-content/uploads/2021/01/flooded-catacombs.png |
| dyson-goretooths-grotto.png | https://dysonlogos.blog/wp-content/uploads/2024/03/goretooths-grotto.png |
| dyson-pit-dungeon-levels-5-8.png | https://dysonlogos.blog/wp-content/uploads/2024/05/pit-dungeon-levels-5-8.png |
| dyson-scavengers-deep-33.png | https://dysonlogos.blog/wp-content/uploads/2026/07/scavengers-deep-33.png |

## Paths Peculiar / Niklas Wistedt (wistedt.net) — personal use only (do NOT redistribute)
Tutorial photos: pencil/ink on dotted notebook paper, progressive inking stages.

| file | url |
|---|---|
| wistedt-tut-{2,3,4,6,8,9,11}.png | https://usercontent.one/wp/www.wistedt.net/wp-content/uploads/2019/01/{2,3,4,6,8,9,11}.png |

## Doctor Frikistein (doctorfrikistein.com) — site content, personal testing use only
Phone photos of marker/pencil dungeons on printed graph (squared) paper.

| file | url |
|---|---|
| frikistein-DF-How-to-draw-a-dungeon.jpg | https://www-static.doctorfrikistein.com/wp-content/uploads/2021/07/DF-How-to-draw-a-dungeon.jpg |
| frikistein-Guia-Dibujar-Mapa-Rol-{3-Mapa-General,4-Doors,23-Listo}.jpg | https://www-static.doctorfrikistein.com/wp-content/uploads/2021/07/Gu%C3%ADa-Dibujar-Mapa-Rol-*.jpg |

## Pre-registered ground truth (zoomed lattice overlays, 2026-07-17)
Pitch in px at the post-rectify MAXDIM=1600 working scale. Registered BEFORE
any tuning against these maps — do not adjust these to fit the detector.

| file | true pitch | detector @2026-07-17 | verdict |
|---|---|---|---|
| dyson-pit-dungeon-levels-5-8 | 33 | 33 | PASS |
| frikistein-…-23-Listo | 13 | 13 | PASS |
| dyson-flooded-catacombs | ~36 | 18 | FAIL (2×-fine) |
| dyson-scavengers-deep-33 | ~17 | 33 | FAIL (2×-coarse) |
| wistedt-tut-2 | ~88 (dot pitch; corridors 1 dot-cell) | 44 | FAIL (2×-fine) |
| wistedt-tut-11 | n/a — flagstone art, no canonical game grid | 79 | unscoreable |

Run: `node tools/realgate.js --dir datasets/external` (report mode, never
fails the bro gate).

## Honest conclusion (2026-07-17)
The 5/5 bro gate does NOT generalize: 2/5 scoreable external maps correct.
Half-pitch ambiguity is alive on foreign material in BOTH directions. The
dot-lattice prior only rescues dot-paper-drawn-on-the-dots (bro's habit,
frikistein's graph paper); Dyson's faint freehand grid under heavy hatching
and Wistedt's every-other-dot cells defeat it. The pitch problem needs the
grid-line evidence itself to resolve ×2 — likely the same geometric
stroke/ridge work as the pale-stroke frontier (datasets/README.md §2b).

## Probed and falsified (2026-07-17, same session)
- **Paper-run-width comb** (corridor=1 cell → gap histogram): FAILS on every
  hatched map — hatch-stroke spacing (8-10px) floods the run statistics; only
  unhatched bro-01 matched (30 vs 28). Don't retry without hatch suppression.
