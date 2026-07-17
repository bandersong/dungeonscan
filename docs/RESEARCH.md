# DungeonScan — research reference

## How to use this doc

This is background reading for whoever (human or agent) picks up DungeonScan's
open computer-vision problems next — mainly the ×2 grid-pitch ambiguity on
foreign maps (`datasets/external/SOURCES.md`) and pale-stroke wall recall on
sparse hand-drawn maps (`datasets/README.md` §2b). It is NOT a spec and NOT a
plan — it's "here's what the field actually knows about these sub-problems,
here's how it maps onto our code, here's a concrete next step." Every citation
below was checked to actually exist (title/authors/venue verified via search)
as of 2026-07-17; nothing here is a paraphrase of a paper nobody read. Read
`README.md`, `BUILD_PLAN.md`, `datasets/README.md`, and
`datasets/external/SOURCES.md` FIRST — they contain the frozen ground truth
and the list of things already tried and reverted. Don't re-litigate a
reverted experiment without a new idea; several of the "obvious" moves below
(lower the ink threshold, tune covFloor) are exactly what was already tried
and killed synthetic wall F1. The frontier is geometric discrimination, not
better tuning of the same intensity-based signal.

---

## 1. Grid/lattice pitch detection — periodicity, autocorrelation, and the ×2 (octave) problem

### What the literature says

Estimating the period of a repeating signal is a solved-many-times problem in
1D (audio pitch detection) and has a direct 2D analogue (periodic texture /
lattice detection). The core tools:

- **Autocorrelation.** If a signal is periodic with period *p*, its
  autocorrelation has peaks at *p*, *2p*, *3p*, ... The classic failure mode —
  well documented in pitch-detection literature — is picking the wrong peak:
  autocorrelation alone can't tell a true fundamental period *p* from its
  first subharmonic *2p* (an "octave error"), because a signal periodic at *p*
  is *also* trivially periodic at *2p*, *3p*, etc.
- **Harmonic Product Spectrum (HPS)** ([UCSD music analysis notes](http://musicweb.ucsd.edu/~trsmyth/analysis/Harmonic_Product_Spectrum.html)): downsample the magnitude spectrum by integer factors (2×, 3×, 4×, 5×) and multiply the copies together. A true fundamental *f₀* gets reinforced at every harmonic (*f₀, 2f₀, 3f₀...*), so its product spike dominates; a candidate that's actually a harmonic of a lower true fundamental gets support from only a subset of the same comb and scores lower. HPS is exactly the frequency-domain move built to kill octave errors.
- **Subharmonic summation (SHS)** — D.J. Hermes, "Measurement of pitch by subharmonic summation," *J. Acoust. Soc. Am.* 83(1), 1988 ([PDF](https://www.researchgate.net/publication/19813760_Measurement_of_pitch_by_subharmonic_summation)). Same idea from the other direction: sum shifted/compressed copies of the spectrum so energy at true harmonics of a candidate accumulates. Reduces octave errors versus picking the single strongest peak.
- **Cepstrum method** (classic Noll-era pitch detection; general description confirmed via multiple sources): take the log-magnitude spectrum, then Fourier-transform *that*. Periodicity in the harmonic comb of the original spectrum shows up as a single peak in the cepstrum at the fundamental period — cleanly separating "many periodic harmonics" from "one true period" in one step. This is worth knowing about but is drop-in-equivalent to autocorrelation for a single dominant periodicity (Wiener–Khinchin: autocorrelation is the inverse FFT of the power spectrum) — it doesn't add power beyond HPS/SHS for our case, just a different implementation route.
- **2D lattice/periodicity detection specifically**: Y. Liu, W.-C. Lin, J. Hays / and separately Liu, Collins & Tsin, **"A Computational Model for Periodic Pattern Perception Based on Frieze and Wallpaper Groups,"** *IEEE TPAMI* 26(3), 2004 ([DOI](https://dl.acm.org/doi/10.1109/TPAMI.2004.1262332), [PubMed](https://pubmed.ncbi.nlm.nih.gov/15376882/)). This is the closest real academic analogue to "find the cell pitch of a hand-drawn grid": it formalizes finding the underlying 2D lattice of a near-regular texture from local features + a spacing/frequency analysis, using the crystallographic frieze/wallpaper-group taxonomy to constrain what a "correct" period looks like. It's texture-analysis literature, not grid-detection-for-CV-pipelines literature, but the core move — combine an autocorrelation-style spatial signal with a frequency/harmonic consistency check — is the same one HPS uses.
- **Hough transform for explicit grid-line detection** (lines, not projection periodicity): used routinely for camera-calibration grids — e.g. ["Automatic Detection of Calibration Grids in Time-of-Flight Images"](https://arxiv.org/pdf/1401.6393) runs a Cartesian Hough transform per gradient-orientation cluster and sweeps for collinear peaks whose intersections give grid vertices directly, sidestepping periodicity-of-a-projection entirely (closer to the §3/§4 stroke/line approach than more spectral analysis).

**Does the octave-error fix transfer?** Yes, structurally. A hand-drawn grid's ink projection is, to first approximation, a periodic square wave with period = cell pitch, and like a plucked string it has spatial "harmonics" at multiples of 1/pitch. Reading the 2nd harmonic as the fundamental, or the reverse, is *exactly* the audio octave-error failure mode — and it happens in **both directions**, which is precisely what `datasets/external/SOURCES.md` reports ("Half-pitch ambiguity is alive... in BOTH directions").

### Relevance to DungeonScan

DungeonScan's `dotLatticeAt`/`combScore` (`renderer/grid.js`, lines ~178-260) is
already, in effect, a domain-specific harmonic-consistency check: it scores a
candidate pitch *d* by mean peak mass across a comb of teeth at multiples of
*d*, and `midpointStrength` explicitly checks the *d/2* midpoint teeth to catch
a half-pitch lock (grid.js line ~118-127, "the comb also self-resolves the
half-pitch ambiguity" per the code comment at line ~242). **This is HPS/SHS in
spirit, already implemented — but only over the dot-lattice signal.** It never
fires on the Dyson/Wistedt maps because those have no printed dot grid for
`dotPitch` to lock onto (`datasets/external/SOURCES.md`: "the dot-lattice prior
only rescues dot-paper-drawn-on-the-dots").

The generalizable form of this idea — apply a harmonic/subharmonic consistency
check directly to the row/column ink-projection's power spectrum, not just to
the dot-lattice blob comb — is untried and is the natural next lever for the
non-dot-lattice failures (`dyson-flooded-catacombs`, `dyson-scavengers-deep-33`,
`wistedt-tut-2`).

### Recommendation

Don't reach for new math frameworks (cepstrum, wallpaper-group symmetry
detection) — the repo's own comb-scoring is already the right shape of
solution. Extend the *same* HPS-style comb/midpoint check to the raw
projection spectrum (via FFT or just the existing autocorrelation-style
projection code in `projections()`), independent of whether a dot lattice was
found, so it can arbitrate ×2 ambiguity on freehand/hatched maps too. See
Ranked Experiment #4.

---

## 2. Document image rectification / dewarping

### What the literature says

- **Classical, rigid-page methods**: 4-corner quadrilateral detection +
  homography warp (perspective correction) is the standard approach for a
  flat page photographed at an angle — this is what a simple "correct the
  perspective" tool does and requires no learned model. Text-line-based
  dewarping (fit and straighten detected baselines) is the classical approach
  for genuinely *curved* pages (open books, curled paper) — see general
  document-analysis review literature, e.g. Cattoni, Coianiz, Messelodi &
  Modena, *"Geometric Layout Analysis Techniques for Document Image
  Understanding: a Review"* (widely cited in skew/layout surveys; see also the
  broader survey [Bassil & Alwan, "Document Skew Estimation and Correction:
  Analysis of Techniques, Common Problems and Possible Solutions,"
  *Applied Artificial Intelligence* 25(9), 2011](https://www.tandfonline.com/doi/full/10.1080/08839514.2011.607009)).
- **Learned, non-planar dewarping**: three landmark papers, all targeting
  *curved/crumpled* documents rather than flat-but-angled ones:
  - **DocUNet** — Ma, Shu, Bai, Wang & Samaras, *"DocUNet: Document Image
    Unwarping via a Stacked U-Net,"* CVPR 2018
    ([paper](https://openaccess.thecvf.com/content_cvpr_2018/papers/Ma_DocUNet_Document_Image_CVPR_2018_paper.pdf)).
    Predicts a dense forward-warp displacement field; trained on ~100k
    synthetically warped documents; introduced the 130-photo DocUNet real-world
    benchmark.
  - **DewarpNet** — Das, Ma, Shu, Samaras & Roy-Chowdhury, ICCV 2019
    ([paper](https://openaccess.thecvf.com/content_ICCV_2019/html/Das_DewarpNet_Single-Image_Document_Unwarping_With_Stacked_3D_and_2D_Regression_ICCV_2019_paper.html)).
    Regresses a 3D shape for the deformed page (contributes the large
    synthetic Doc3D dataset), then 2D-textures it flat; cuts OCR CER ~42%
    on curved real photos.
  - **DocTr** — Feng, Zhu, Chen, et al., *"DocTr: Document Image Transformer
    for Geometric Unwarping and Illumination Correction,"* ACM Multimedia 2021
    (oral) ([repo](https://github.com/fh2019ustc/DocTr), [arXiv](https://arxiv.org/abs/2110.12942)).
    Transformer-based geometric ("GeoTr") + illumination ("IllTr") correction,
    trained on Doc3D. Newer follow-ons (DocTr-Plus/TMM 2023, DocScanner/IJCV)
    push further on wild, unrestricted (not-fully-in-frame) documents.

  All three target the "page is not flat" problem: curls, folds, crumples,
  out-of-frame edges. None solve "flat page, angled camera" — that's
  considered solved by a homography and isn't where these papers spend budget.

### Relevance to DungeonScan

Bro's photos are a **flat notebook page** photographed at an angle — pure
projective distortion, exactly the case a 4-point homography (`DS.perspective.autoRectify`,
`renderer/perspective.js`) solves exactly and losslessly. The DocUNet/DewarpNet/
DocTr line of work solves a *harder and different* problem (unknown 3D paper
shape) that doesn't exist in this pipeline's input domain unless bro starts
photographing dog-eared or loosely-held pages. Reaching for a learned dewarping
network here would mean: (a) bundling a heavyweight model with license/
provenance questions, (b) solving a problem you don't have, and (c) not
touching the actual open failure (grid-pitch ambiguity happens *after*
rectification — SOURCES.md's failures are post-rectify pitch misreads, not
warp residue).

### Recommendation

Keep the classical homography. It is already correct-complexity for the
photographed-flat-page case (BUILD_PLAN.md confirms "auto-deskew PROVEN: exact
angle recovery ±0.0°"). Only reconsider if real photos start showing genuine
non-planar page curl (spine bend, folded corner) — and even then, the
proportionate next step is a lightweight polynomial fit to the *detected grid
lines themselves* (once §3/§4 line-extraction work exists) rather than a
learned 3D-shape network. This is a "don't build it" line item: no action
needed now.

---

## 3. Line/stroke extraction from drawings — the open frontier

### What the literature says

This is the most load-bearing section for the current open problem
(pale-stroke recall, `datasets/README.md` §2b: "The separator has to be
GEOMETRY, not darkness").

- **LSD (Line Segment Detector)** — von Gioi, Jakubowicz, Morel & Randall,
  *"LSD: A Fast Line Segment Detector with a False Detection Control,"*
  *IEEE TPAMI* 32(4), 2010, pp. 722–732 (also detailed as an
  [IPOL reproducible article, 2012](http://www.ipol.im/pub/art/2012/gjmr-lsd/article.pdf)).
  Linear-time, parameter-free (uses an a-contrario/Helmholtz-principle bound
  on false detections rather than hand-tuned thresholds), finds straight line
  segments directly from gradient orientation fields.
- **EDLines** — Akinlar & Topal, *"EDLines: A real-time line segment detector
  with a false detection control,"* *Pattern Recognition Letters* 32(13),
  2011, pp. 1633–1642. Builds on their Edge Drawing (ED) algorithm to get
  clean contiguous edge chains first, then least-squares line-fits segments
  out of them; reported ~10× faster than LSD, real-time (~9.45 ms/frame).
- **Stroke Width Transform (SWT)** — Epshtein, Ofek & Wexler, *"Detecting Text
  in Natural Scenes with Stroke Width Transform,"* CVPR 2010
  ([Microsoft Research](https://www.microsoft.com/en-us/research/publication/detecting-text-in-natural-scenes-with-stroke-width-transform/)).
  A per-pixel operator: ray-cast along the local gradient direction to the
  opposing edge, record the ray length as that pixel's "stroke width." Text
  strokes (and pen strokes generally) have **low local variance in stroke
  width**; this is the key discriminator SWT exploits, and it's a genuinely
  different signal from "is it dark" — a pale, thin, uniform-width stroke
  and a chaotic patch of hatching/paper texture can have identical local
  darkness but very different stroke-width variance.
- **Ridge/curvilinear-structure detection** — Steger, *"An Unbiased Detector
  of Curvilinear Structures,"* *IEEE TPAMI* 20(2), 1998
  ([PDF](http://howardzzh.com/research/papers/vision/1998.PAMI.Steger.UnbiasedDetector.pdf)).
  Models the cross-section profile of a line explicitly (2nd-derivative/
  Hessian eigen-analysis) to localize a ridge centerline to sub-pixel accuracy
  and estimate its width, even under noise — this is the formal version of
  "a pen stroke is a curvilinear ridge," the exact hypothesis
  `datasets/README.md` §2b states as the next-attempt direction.
- **Frangi vesselness filter** — Frangi, Niessen, Vincken & Viergever,
  *"Multiscale Vessel Enhancement Filtering,"* MICCAI 1998
  ([summary](https://www.sfu.ca/~kabhishe/posts/posts/summary_miccai_vesselness_1998/)).
  Uses the eigenvalues of the local Hessian at multiple scales to score
  "how tube/ridge-like is this point" while actively suppressing blob-like and
  isotropic-texture response — designed for vessels in medical images, but the
  underlying geometric test (one dominant elongated eigenvalue direction,
  consistent across nearby points) is directly the "pen stroke vs. texture"
  separator this project needs, and it's a closed-form filter, not an ML model.
- **Structure tensor / orientation coherence** — origin: Förstner & Gülch,
  1987; standard tool since. Eigen-decomposition of the local gradient
  structure tensor gives (a) a dominant local orientation and (b) a coherence
  score (an anisotropy measure: large eigenvalue gap = strongly oriented
  structure, small gap = isotropic). **Texture regions score low coherence;
  line/edge regions score high coherence with a locally consistent
  orientation** — this is a cheaper, simpler formalization of exactly the
  same "geometry not darkness" idea, computable from a few Sobel + box-blur
  passes (no eigen-decomposition of anything bigger than 2×2 needed for a
  gradient structure tensor).
- **Skeletonization/thinning** — Zhang & Suen, 1984 (classic parallel thinning
  algorithm; still the standard baseline). Once a candidate ink mask is
  isolated, thinning reduces it to a 1px centerline for tracing into
  polylines — the mechanical last step of the "skeletonize → polylines → snap
  to lattice edges" plan already sketched in `datasets/README.md` §2b.

### Relevance to DungeonScan

The current wall-continuity veto (`renderer/digitize.js`, integral-image local
ink + `covFloor 0.35`) is purely intensity/coverage-based. `datasets/README.md`
already diagnosed *why* this is a dead end for pale strokes: bro's palest
strokes sit at the **same local darkness** as photo/paper texture, and
threshold/coverage tuning (delta 10 + followed-run rescue) recovered pale
strokes but dropped synthetic wall F1 99.1→93.7 because "texture chains just
like a pale line" under any purely-darkness-based rule. No amount of retuning
a 1D (intensity) signal can separate two populations that overlap on that
axis. The literature above is unanimous that the fix is a **second,
orthogonal signal**: local orientation coherence / stroke-width consistency /
ridge shape — i.e., exactly what the repo's own next-attempt note already
guesses ("a pen stroke is a curvilinear ridge with a consistent direction;
texture is isotropic"), just not yet backed by a named, implementable
technique.

### Recommendation

Implement structure-tensor orientation coherence first — it's the cheapest of
the geometric options (Sobel gradients + Gaussian/box smoothing of Gxx, Gyy,
Gxy, then a closed-form 2×2 eigenvalue formula; no new dependency, same
complexity class as the existing integral-image machinery) and is a strict
superset of the "hatching is isotropic, strokes are directional" hypothesis
already written down. Use it as an *additional* gate alongside (not instead
of) the existing continuity veto: credit ink toward a wall only when local
orientation coherence is high **and** the dominant orientation is aligned with
the candidate wall-edge direction (rules out oriented-but-wrong-direction
hatch runs, which plain coherence alone wouldn't catch). If that's not
separable enough in practice (a real risk: parallel hatch strokes are locally
coherent too, just over shorter runs and inconsistent global direction),
escalate to Frangi vesselness before LSD/EDLines — LSD/EDLines are built to
find long, straight, deliberate lines and will need real adaptation for short,
wobbly hand-drawn strokes; Frangi's multiscale ridge response degrades more
gracefully for exactly that case. See Ranked Experiments #1–#3.

---

## 4. Floor-plan / sketch recognition, and TTRPG map digitization specifically

### What the literature says

- **CubiCasa5K** — Kalervo, Ylioinas, Häikiö, Karhu & Kannala, *"CubiCasa5K:
  A Dataset and an Improved Multi-Task Model for Floorplan Image Analysis,"*
  SCIA 2019 / [arXiv:1904.01920](https://arxiv.org/pdf/1904.01920). 5,000
  real-estate floor plans (Finnish real-estate marketing material,
  CAD-originated), multi-task CNN for walls/rooms/icons, SVG vector ground
  truth. **Clean, CAD-drafted plans — not hand-drawn.**
- **Raster-to-Vector** — Liu, Wu, Kohli & Furukawa, *"Raster-to-Vector:
  Revisiting Floorplan Transformation,"* ICCV 2017
  ([paper](https://openaccess.thecvf.com/content_ICCV_2017/papers/Liu_Raster-To-Vector_Revisiting_Floorplan_ICCV_2017_paper.pdf)).
  CNN → junction heatmap → integer program assembling wall primitives with
  topological/geometric consistency constraints; ~90% precision/recall.
  Again CAD-quality raster plans.
- **Room-boundary-guided multi-task recognition** — Zeng, Li, Yu & Fu, *"Deep
  Floor Plan Recognition Using a Multi-Task Network with Room-Boundary-Guided
  Attention,"* ICCV 2019 / [arXiv:1908.11025](https://arxiv.org/pdf/1908.11025).
  Same domain (clean architectural plans).
- **Hybrid classical+learned** — *"Parsing Line Segments of Floor Plan Images
  Using Graph Neural Networks,"* [arXiv:2303.03851](https://arxiv.org/pdf/2303.03851).
  Notable for its staging: runs classical line-segment detection (LSD-style)
  first, then a GNN groups/classifies the resulting segments into walls —
  i.e., geometry extraction stays classical, learning is only applied to the
  semantic layer on top. Still targets clean floor plans, not sketches.

  **In every case above, the input domain is professionally-drafted/CAD-origin
  floor plans** — high-contrast straight lines, no hatching, no paper texture,
  no hand-drawn irregularity. None of this literature was built for, or
  tested on, genuinely freehand pencil/marker drawings.

- **TTRPG map digitization specifically: no academic literature exists.**
  Searches turned up nothing peer-reviewed or arXiv-indexed on
  photograph-to-vector digitization of hand-drawn tabletop RPG maps. The one
  adjacent hit, [ztoz.blog, "Improving Product Discovery of Tabletop RPG
  Maps"](https://ztoz.blog/posts/map-ml/), is an independent/hobby blog post
  (not peer-reviewed) solving a different problem: it zero-shot-prompts
  vision-language models (Gemini, GPT-4V, Pixtral, Gemma3, LLaVA) to
  *tag/describe already-digital* map images for marketplace search — not to
  extract grid/wall geometry from a photo of a hand-drawn page. Its one
  relevant finding: it reports these general VLMs "perform poorly with
  reasoning and quantitative tasks," specifically calling out **grid
  counting** — a small data point against reaching for a general VLM to solve
  DungeonScan's grid-pitch problem directly.
  The unrelated arXiv hit **"Dungeons for Science: Mapping Belief Places and
  Spaces"** (Dant, Feldman & Lutters, [arXiv:1904.05216](https://arxiv.org/abs/1904.05216))
  is a sociology/HCI paper using tabletop RPGs as a data-collection method —
  unrelated to map image processing, noted only to rule it out.
  The actual TTRPG-map ecosystem is entirely **hobby drawing tools**, not
  photo-to-digital scanners: Dungeon Scrawl, Dungeondraft, DungeonFog, Dungeon
  Painter Studio, Campaign Cartographer, Dungeon Alchemist — you draw the map
  natively inside the tool; none take a photo of a paper sketch as input.

### Relevance to DungeonScan

DungeonScan sits in a genuine literature gap: hand-drawn + heavy hatching/
texture + non-CAD irregular geometry + photographed (not scanned flat). This
is worth stating plainly to whoever picks this up next so they don't waste
time hunting for a paper that solves this exact problem — it doesn't exist.
The nearest published work (CubiCasa5K, Raster-to-Vector) solves a
differently-shaped problem (clean CAD input) and their trained models would
not transfer without DungeonScan collecting its own labeled dataset anyway —
at which point the project's own classical geometric pipeline plus the
already-planned "retrain the CoreML classifier on real crops" step
(`datasets/README.md` step 4) is the more tractable path, not adopting an
architecture built for blueprints.

### Recommendation

Don't adapt CubiCasa5K/Raster-to-Vector/room-boundary-attention models — wrong
training distribution, wrong deformation model, and adapting one would cost
more than the value it delivers over the existing classical pipeline. Do
borrow the *staging pattern* from the LSD+GNN floor-plan paper — classical
line/geometry extraction first, learning only at the semantic-classification
layer on top — because that's already DungeonScan's own plan (`datasets/README.md`
step 4: retrain the glyph classifier on real crops once labeled wall/door/
floor data exists from steps 1–3). No new direction needed here; the existing
plan is already the correct-complexity one for a domain nobody else has published on.

---

## 5. Binarization under uneven illumination

### What the literature says

- **Otsu's method** (Otsu, 1979) picks a single global threshold maximizing
  between-class variance, under an implicit assumption of a **bimodal
  histogram** and **uniform illumination**. Both assumptions are its failure
  modes: it degrades badly under class imbalance (a small foreground fraction
  splits *within* the dominant background mode instead of separating from it)
  and under spatially-varying illumination (a single global cutoff can't
  track a brightness gradient across the frame).
- **Niblack** (1986): local threshold = local mean + *k*·(local standard
  deviation), computed per-pixel over a sliding window — handles local
  illumination variation but tends to leave substantial background noise in
  near-uniform regions.
- **Sauvola** — Sauvola & Pietikäinen, *"Adaptive document image
  binarization,"* *Pattern Recognition* 33(2), 2000. Adds a dynamic-range
  normalization term (parameters *k*, *R*) to Niblack's formula specifically
  to suppress the noise Niblack leaves in flat background regions, while
  keeping the same local-window adaptivity — the standard reference method
  for degraded/unevenly-lit document scans, available in OpenCV and
  scikit-image ([skimage docs](https://scikit-image.org/docs/0.24.x/auto_examples/segmentation/plot_niblack_sauvola.html)).
- **Modern learned alternatives**: SauvolaNet
  ([arXiv:2105.05521](https://arxiv.org/pdf/2105.05521)) learns the window
  size/parameters adaptively per image instead of fixing them by hand;
  transformer/GAN-based binarizers (e.g. DocBinFormer,
  [arXiv:2312.03568](https://arxiv.org/pdf/2312.03568)) target severely
  degraded historical documents. These are aimed at document restoration
  (stains, bleed-through, faded ink on old paper), a harder and different
  problem than a clean modern notebook photographed unevenly.

### Relevance to DungeonScan

DungeonScan's `inkThreshold` (`renderer/grid.js` lines ~129–142) already
independently rediscovered the Otsu/class-imbalance failure mode without
citing it — the code comment states Otsu "splits within the paper mode"
because ink is a small minority class (~5% of pixels), and works around it
with a **global** percentile-based threshold (paper p60 minus a fixed step)
instead of Otsu. That's a reasonable and already-shipped fix for the
class-imbalance half of the problem. It does **not** address the
uneven-illumination half: it is still one threshold per whole image, so it
cannot track a brightness gradient within a single photo (camera vignetting,
desk shadow in one corner) the way a genuine local method would.

### Recommendation

This is not the current bottleneck — `datasets/README.md` §2b is explicit that
the pale-stroke failure is a discrimination-by-shape problem, not a
thresholding problem (intensity tuning was tried and reverted for hurting
synthetic F1, independent of whether the threshold was global or local). Don't
reach for Sauvola as the *primary* fix for pale-stroke recall — it would very
likely reproduce the same reverted regression, since a locally-adaptive
threshold still can't distinguish "locally darker than its neighborhood
because it's a pale wall stroke" from "locally darker than its neighborhood
because it's a hatch line," which is the same overlap problem stated in
§2b just computed with a smarter local baseline. That said, genuine per-pixel
Sauvola (not the current global percentile) is cheap to add — the project
already has integral-image machinery for local sums (used in the wall
continuity veto), so local mean/variance for Sauvola is nearly free — and IS
worth adding as a **secondary, corroborating signal** alongside the geometric
stroke work in §3, for the narrower case of genuine regional illumination
unevenness surviving rectification (vignetting corners). Sequence it behind
Area 3's geometric work, not ahead of it.

---

## 6. Universal VTT ecosystem (.dd2vtt / .uvtt)

### What the literature says

There's no academic literature here — this is a de facto industry format, not
a research artifact — but it's well-documented by its ecosystem:

- **Origin**: created by Megasploot, the developer of Dungeondraft and
  Wonderdraft, as the export format for Dungeondraft. Now referred to
  generically as "Universal VTT."
- **File extensions**: `.dd2vtt` (Dungeondraft), `.df2vtt` (DungeonFog), and
  `.uvtt` (generic) are the **same underlying JSON schema** — different tools
  just export with different extensions ([Arkenforge's writeup](https://arkenforge.com/universal-vtt-files/)
  is the most complete public spec description found; the
  [Dungeondraft Encyclopaedia guide](https://dungeondraft-encyclopaedia.gitbook.io/guide/final-steps/exporting-your-map/universal-vtt)
  covers the export side).
- **Schema fields** (confirmed against Arkenforge's documented spec):
  - `format` — decimal version number.
  - `resolution` — `{ map_origin: {x,y}, map_size: {x,y}, pixels_per_grid }`.
  - `line_of_sight` — array of polylines; sight/movement-blocking wall
    geometry.
  - `objects_line_of_sight` — separate array of polylines for freestanding
    blocking objects (furniture, pillars) as distinct from perimeter walls.
  - `portals` — array of `{ position:{x,y}, bounds:[pt,pt], rotation
    (float, **radians**), closed (bool), freestanding (bool) }` — doors/
    windows: the wall polyline is gapped at the door location and the door
    itself is represented as this separate, potentially-openable object.
  - `lights` — array of `{ position:{x,y}, range, intensity, color (hex),
    shadows (bool) }`.
  - `environment` — `{ baked_lighting (bool), ambient_light (hex) }`.
  - `image` — base64-encoded PNG or WEBP (no `data:` URI prefix).
- **Import support confirmed**: Arkenforge Toolkit (native), FoundryVTT (no
  native core support — via the community
  ["Universal Battlemap Importer"](https://foundryvtt.com/packages/dd-import/)
  / [moo-man/FVTT-DD-Import](https://github.com/moo-man/FVTT-DD-Import) module),
  Roll20 (via a community API script, Pro-tier subscription required for API
  scripts), Fantasy Grounds Unity (via the converter
  [uvtt2fgu](https://github.com/Imagix/uvtt2fgu)), MapTool. **Export support**
  (other tools that also *produce* this format): Dungeondraft, DungeonFog,
  Dungeon Alchemist, MapForge, Arkenforge.

### Relevance to DungeonScan

`renderer/vtt.js`'s `buildUVTT`/`validateUVTT` already implements this schema
field-for-field: `format: 0.3`; `resolution.{map_origin,map_size,pixels_per_grid}`;
`line_of_sight` built from merged wall polylines; `objects_line_of_sight: []`
(correctly empty — no freestanding-object detection exists yet, which is
consistent with the schema's *intent*, not a gap); `portals` built via
`portalFromDoor` with `position`/`bounds`/`rotation` **in radians**/`closed`/
`freestanding: false`; `lights: []` (no light-source detection yet);
`environment: { baked_lighting: true, ambient_light: 'ffffffff' }` (a sound
default meaning "treat this as a fully-lit scene with no dynamic lighting,"
appropriate until DungeonScan detects actual light sources); `image` as
base64 with no prefix. The BUILD_PLAN.md status line "VTT portal rotation
fixed to radians (Foundry convention)" matches the confirmed spec
(`rotation: float (Radians)`) exactly — this was a real, already-fixed bug
that's now provably spec-correct, not a hypothesis.

### Recommendation

The exporter is spec-compliant; the two empty arrays (`objects_line_of_sight`,
`lights`) are correctly-scoped placeholders, not bugs — don't build freestanding-
object or light-source detection speculatively (nothing in the pipeline
currently detects torches/braziers or furniture) until there's a concrete
feature driving it. When that day comes: populate `lights[].color` as a hex
string, `range`/`intensity` as floats in grid-square units (per Arkenforge's
documented convention), and flip that scene's `environment.baked_lighting` to
`false` so the receiving VTT actually renders dynamic shadows through the
exported walls — leaving it `true` with a populated `lights` array would be
self-contradictory (baked lighting says "the image already has the lighting
baked in, ignore the lights array"). One gap worth closing regardless: the
harness (`validateUVTT`) only checks shape/type correctness, not round-trip
fidelity in a real consumer — a smoke test importing an exported `.dd2vtt`
into Foundry's `dd-import` module (or Arkenforge) before the next release
would catch anything the shape-checker can't (e.g. coordinate-origin or
winding-order mismatches that are only visible once actually rendered).

---

## Ranked next experiments

Ordered cheapest/most-informative first. All must respect: **`node
tools/realgate.js` (the 5 bro maps) stays 5/5** — that's the non-negotiable
regression gate. `datasets/external` is report-mode only (per
`datasets/external/SOURCES.md`) and is not allowed to block anything; it's
where progress on the ×2-pitch problem gets *measured*, not gated.

**1. Verify the core assumption before building anything (cheapest, do
first).** The whole geometric-discrimination direction (§3) rests on an
unverified premise: that pale wall strokes and hatching/paper texture are
separable by local orientation coherence even though they're not separable by
darkness. Test this with a numbers-only script — no detector changes — before
touching `detectWalls`: take ~20-30 hand-labeled crops each of "genuine pale
wall stroke" and "hatching/texture, no wall" from bro-01 (the map that
diagnosed this problem), compute a structure-tensor coherence score
(Sobel + box-blur, 2×2 eigenvalue formula) on each, and compare the two
distributions.
*Falsifiable prediction*: the two distributions are meaningfully separated
(e.g. a threshold exists with reasonable precision/recall on the labeled
crops). If they overlap as heavily as the darkness histograms already do, the
whole structure-tensor/Frangi direction (experiments 2–3) is falsified up
front, cheaply, before any pipeline surgery.
*Gate*: none needed — it's an offline analysis script, doesn't touch
`detectWalls`. Report the two distributions (means/spread/overlap) before
proceeding to #2.

**2. Wire structure-tensor orientation coherence into `detectWalls` as a
second gate (contingent on #1 succeeding).** Add a per-edge-strip coherence +
dominant-orientation feature alongside the existing continuity veto
(`covFloor`); require coherence above a threshold **and** orientation aligned
with the candidate wall-edge direction before crediting ink toward a wall.
*Falsifiable prediction*: bro-01's enclosed-cell count rises materially above
the current 29 (of ~250 drawn) while synthetic wall F1 does not regress below
its current 99.1–99.4%.
*Gate*: `node tools/realgate.js` must stay 5/5; synthetic wall-F1 harness must
not regress; requires bro-01 labeled wall ground truth (build per
`datasets/README.md` step 3 if it doesn't already exist) to score the
enclosed-cell improvement, not just eyeball it.

**3. Escalate to Frangi vesselness if #2's separation isn't clean enough.**
Structure-tensor coherence alone has a known weak spot: parallel hatch runs
are *also* locally coherent (just shorter and less globally consistent in
direction than a real stroke). A proper Hessian/Frangi ridge filter explicitly
models ridge *width* and suppresses the corner/blob-like response that
criss-crossing hatch strokes produce at their intersections, which plain
orientation coherence doesn't.
*Falsifiable prediction*: on the same labeled bro-01 crops from #1, Frangi
ridge-continuity score shows a cleaner separation between genuine strokes and
hatching than structure-tensor coherence alone did.
*Gate*: standalone unit test comparing scores on labeled crops (new
`renderer/*.test.js`-style test); do not touch `detectWalls`/the bro gate
until this validates independently — this is a fallback, only pursue if #2
underperforms.

**4. Harmonic/subharmonic reinforcement over the raw projection spectrum, for
the non-dot-lattice ×2 failures.** Independent track from #1-3 — this targets
`datasets/external`'s `dyson-flooded-catacombs` (FAIL, 2×-fine) and
`dyson-scavengers-deep-33` (FAIL, 2×-coarse), which have no printed dot grid
for the existing `dotLatticeAt`/`combScore` comb-scoring to lock onto. Apply
the same HPS-style comb/midpoint logic that already resolves half-pitch
ambiguity on the dot lattice (grid.js `combScore`/`midpointStrength`) directly
to the row/column ink-projection's power spectrum, so it can arbitrate ×2
ambiguity even when there's no dot lattice.
*Falsifiable prediction*: `dyson-flooded-catacombs` and
`dyson-scavengers-deep-33` flip from FAIL to PASS without regressing
`dyson-pit-dungeon-levels-5-8` or `frikistein-…-23-Listo` (currently PASS).
*Gate*: `node tools/realgate.js --dir datasets/external` (report mode,
non-blocking) to measure; `node tools/realgate.js` (bro gate) must stay 5/5,
since this only activates as a fallback when the dot-lattice prior doesn't
fire — it must not change behavior on maps where the dot lattice already
wins.

**5. Grid-line geometric clustering (LSD/EDLines) to resolve ×2 pitch by
finding lines directly, not periodicity.** The most novel and most expensive
option — biggest rewrite, so ranked last. Run LSD or EDLines on the rectified
image, restrict to near-horizontal/near-vertical segments, cluster by
perpendicular offset into candidate grid-line families, and read the pitch
directly off segment spacing rather than off a projection's periodicity —
sidestepping the fundamental/harmonic ambiguity rather than resolving it after
the fact.
*Falsifiable prediction*: on `wistedt-tut-2` (currently 44 detected vs. 88 true
— the "every-other-dot cells" case, where dot-lattice pitch ≠ drawn-cell
pitch), line clustering recovers a pitch consistent with 88 (or fails in a
diagnosable, non-silent way).
*Gate*: `datasets/external` report mode; must not be wired into the bro-gate
path (must not replace or interfere with the dot-lattice prior) until it
independently matches or beats the existing 5/5 on bro's own maps — this is
a new signal to corroborate against, not a replacement, until proven.
