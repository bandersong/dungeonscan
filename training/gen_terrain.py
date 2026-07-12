#!/usr/bin/env python3
"""
DungeonScan — synthetic HEX TERRAIN dataset generator.

Sibling to gen_glyphs.py (the dungeon side). Draws 64x64 crops of a SINGLE hex
of a hand-drawn overland/hex map, one terrain symbol per tile, in a wobbly
hand-drawn ink style on faint-paper with a faint HEX-EDGE hint, with heavy
augmentation. Output:

    training/dataset_terrain/<class>/<i>.png        master set (~N_PER/class)
    training/dataset_terrain_split/{train,val}/<class>/<i>.png   stratified 85/15
    models/terrain_labels.json                      class label list (alphabetical)
    training/preview_terrain.png                    montage, one sample per class

Classes (folder-per-class):
    plains, forest, hills, mountains, water, swamp, desert, road, jungle,
    tundra, coast, town, ruins

Run:
    ~/scrubbuddy/.venv/bin/python gen_terrain.py            # N_PER=450 default
    N_PER=600 ~/scrubbuddy/.venv/bin/python gen_terrain.py  # override count
"""

import os
import math
import json
import random
import shutil

from PIL import Image, ImageDraw, ImageFilter
import numpy as np

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
HERE        = os.path.dirname(os.path.abspath(__file__))
ROOT        = os.path.dirname(HERE)
OUT_MASTER  = os.path.join(HERE, "dataset_terrain")
OUT_SPLIT   = os.path.join(HERE, "dataset_terrain_split")
MODELS_DIR  = os.path.join(ROOT, "models")
PREVIEW     = os.path.join(HERE, "preview_terrain.png")

CLASSES = ["plains", "forest", "hills", "mountains", "water", "swamp", "desert",
           "road", "jungle", "tundra", "coast", "town", "ruins"]

N_PER = int(os.environ.get("N_PER", "450"))
SEED  = 4321

CELL   = 64                       # output tile size, px
SS     = 4                        # supersample factor for smooth strokes
S      = CELL * SS                # internal canvas size (256)
CENTER = CELL / 2.0               # 32
TAU    = math.tau

# Ink: near-black, dark blue (ballpoint), dark brown (sepia) — varied per image.
INK_CHOICES = [
    (28, 26, 32), (22, 20, 24), (20, 21, 26), (34, 30, 28),
    (30, 36, 62), (26, 32, 56), (34, 42, 74),       # dark blue
    (56, 40, 30), (48, 34, 26), (60, 46, 35), (44, 31, 24),  # dark brown
    (38, 34, 30), (40, 36, 32),
]
# Paper: parchment / warm white / cool white.
PAPER_CHOICES = [
    (244, 236, 216), (240, 232, 210), (236, 228, 206),
    (242, 235, 215), (248, 240, 222),
    (238, 238, 234), (236, 236, 232), (242, 242, 238),
    (246, 242, 232), (250, 246, 236),
]
# Faint hex-edge line color — low contrast so the model learns to ignore it.
HEX_CHOICES = [
    (198, 191, 177), (190, 188, 182), (205, 199, 185),
    (182, 184, 190), (201, 195, 183), (188, 186, 174),
]


# --------------------------------------------------------------------------- #
# Ink primitives (geometry in CELL units; scaled by SS at draw time)
# --------------------------------------------------------------------------- #
def _subdivide(points, seg, jitter, rng):
    """Break each control segment into `seg` sub-points with perpendicular jitter."""
    out = []
    steps = max(1, seg)
    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L, dx / L
        for s in range(steps):
            t = (s + 1) / steps
            j = rng.uniform(-jitter, jitter)
            out.append((x0 + (x1 - x0) * t + nx * j,
                        y0 + (y1 - y0) * t + ny * j))
    return out if out else list(points)


def _widths(n, base, rng, taper=True):
    """Smooth random-walk stroke width (cell px) with tapered ends."""
    if n < 1:
        return []
    w = [base * rng.uniform(0.85, 1.05)]
    for _ in range(1, n):
        w.append(max(base * 0.6, min(base * 1.3,
                                     w[-1] + rng.uniform(-base * 0.08, base * 0.08))))
    if taper and n > 4:
        k = max(2, n // 5)
        for i in range(k):
            f = (i + 1) / (k + 1)
            w[i] *= f
            w[n - 1 - i] *= f
    return w


def stroke(draw, points, base, color, rng, seg=6, jitter=0.5,
           closed=False, taper=True):
    """Draw a wobbly, variable-width ink stroke as a filled polygon."""
    pts = _subdivide(points, seg, jitter, rng)
    if closed and len(points) >= 2:
        pts = pts[:-1] + _subdivide([points[-1], points[0]], seg, jitter, rng)
    n = len(pts)
    if n < 2:
        return
    ws = _widths(n, base, rng, taper)
    left, right = [], []
    for i in range(n):
        if closed:
            a = pts[(i - 1) % n]
            b = pts[(i + 1) % n]
        else:
            a = pts[max(i - 1, 0)]
            b = pts[min(i + 1, n - 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / L, tx / L
        hw = ws[i] / 2.0
        left.append((pts[i][0] + nx * hw, pts[i][1] + ny * hw))
        right.append((pts[i][0] - nx * hw, pts[i][1] - ny * hw))
    poly = [(x * SS, y * SS) for x, y in (left + right[::-1])]
    if len(poly) >= 3:
        draw.polygon(poly, fill=color)


def dot(draw, cx, cy, r, color, rng):
    """Wobbly filled blob."""
    jx, jy = rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4)
    rr = r * rng.uniform(0.85, 1.15)
    draw.ellipse([(cx - rr + jx) * SS, (cy - rr + jy) * SS,
                  (cx + rr + jx) * SS, (cy + rr + jy) * SS], fill=color)


def ring(draw, cx, cy, r, w, color, rng, n=30):
    """Wobbly annulus (filled polygon between two jittered circles)."""
    outer, inner = [], []
    start = rng.uniform(0, TAU)
    for i in range(n):
        a = start + i / n * TAU
        rr = r + r * rng.uniform(-0.06, 0.06)
        hw = w / 2.0 * rng.uniform(0.85, 1.15)
        ca, sa = math.cos(a), math.sin(a)
        outer.append(((cx + ca * (rr + hw)) * SS, (cy + sa * (rr + hw)) * SS))
        inner.append(((cx + ca * (rr - hw)) * SS, (cy + sa * (rr - hw)) * SS))
    poly = outer + inner[::-1]
    if len(poly) >= 3:
        draw.polygon(poly, fill=color)


def rect(draw, x0, y0, x1, y1, w, color, rng, **kw):
    stroke(draw, [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)],
           w, color, rng, closed=True, seg=2, **kw)


def _partial(a, b, rng):
    """Return a random interior sub-segment of line a->b (for broken strokes)."""
    t0 = rng.uniform(0.0, 0.35)
    t1 = rng.uniform(0.55, 1.0)
    return ((a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0),
            (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1))


# --------------------------------------------------------------------------- #
# Background: faint HEX-EDGE hint (the hex the symbol sits in)
# --------------------------------------------------------------------------- #
def _hex_vertices(cx, cy, r, pointy, rot):
    off = math.pi / 6 if pointy else 0.0          # 30° offset for pointy-top
    return [(cx + math.cos(off + k * math.pi / 3 + rot) * r,
             cy + math.sin(off + k * math.pi / 3 + rot) * r) for k in range(6)]


def draw_hex(draw, rng, hex_color):
    """Faint hex-edge hint: flat-top or pointy-top, most edges drawn, light + thin."""
    r = rng.uniform(27.0, 30.5)
    pointy = rng.random() < 0.5
    rot = rng.uniform(-0.08, 0.08)
    verts = _hex_vertices(CENTER, CENTER, r, pointy, rot)
    w = rng.uniform(0.45, 0.85)
    n = len(verts)
    order = list(range(n))
    rng.shuffle(order)
    n_draw = rng.randint(4, 6)                     # draw most edges
    for i in order[:n_draw]:
        a, b = verts[i], verts[(i + 1) % n]
        stroke(draw, [a, b], w, hex_color, rng, jitter=0.25, taper=False, seg=2)


# --------------------------------------------------------------------------- #
# Per-class symbol drawing (centered ~ (CENTER, CENTER), cell units)
# --------------------------------------------------------------------------- #
def _tree(draw, rng, ink, tx, ty, scale=1.0):
    """Small tree: trunk + round canopy. (tx, ty) is the base of the trunk."""
    th = rng.uniform(3.0, 5.0) * scale
    cw = rng.uniform(0.9, 1.4) * scale
    stroke(draw, [(tx, ty), (tx, ty - th)], cw, ink, rng, seg=2, jitter=0.15)
    cr = rng.uniform(3.0, 4.5) * scale
    cyc = ty - th - cr * 0.15
    if rng.random() < 0.55:
        dot(draw, tx, cyc, cr, ink, rng)
    else:
        ring(draw, tx, cyc, cr, rng.uniform(1.0, 1.6) * scale, ink, rng)


def snowflake(draw, rng, ink, x, y, sz):
    """6-point asterisk (3 strokes through center at 60°)."""
    rot = rng.uniform(0, math.pi / 3)
    for k in range(3):
        a = rot + k * math.pi / 3
        dx, dy = math.cos(a) * sz, math.sin(a) * sz
        stroke(draw, [(x - dx, y - dy), (x + dx, y + dy)],
               rng.uniform(0.7, 1.1), ink, rng, seg=1, jitter=0.1)


def sym_plains(draw, rng, ink):
    """Mostly blank + a few grass ticks."""
    cx, cy = CENTER, CENTER
    for _ in range(rng.randint(2, 4)):
        bx = cx + rng.uniform(-11, 11)
        by = cy + rng.uniform(-7, 9)
        h = rng.uniform(4, 7)
        lean = rng.uniform(-1.6, 1.6)
        stroke(draw, [(bx, by + h), (bx + lean, by)],
               rng.uniform(0.8, 1.4), ink, rng, seg=4, jitter=0.2)


def sym_forest(draw, rng, ink):
    """Cluster of a few small trees."""
    cx, cy = CENTER, CENTER
    for _ in range(rng.randint(3, 5)):
        a = rng.uniform(0, TAU)
        r = rng.uniform(10, 13) * math.sqrt(rng.random())
        tx, ty = cx + math.cos(a) * r, cy + math.sin(a) * r + 3
        _tree(draw, rng, ink, tx, ty, scale=rng.uniform(0.85, 1.05))


def sym_hills(draw, rng, ink):
    """Rounded bumps (arcs)."""
    cx, cy = CENTER, CENTER
    n = rng.randint(2, 4)
    spacing = rng.uniform(8, 11)
    total = spacing * (n - 1)
    w = rng.uniform(1.4, 2.0)
    for i in range(n):
        bx = cx - total / 2 + i * spacing + rng.uniform(-1, 1)
        by = cy + rng.uniform(-1, 5)
        bw = rng.uniform(7, 10)
        bh = rng.uniform(5, 8)
        pts = []
        steps = 14
        for s in range(steps + 1):
            t = s / steps
            x = bx - bw + 2 * bw * t
            y = by - bh * math.sin(t * math.pi)
            pts.append((x, y))
        stroke(draw, pts, w, ink, rng, seg=1, jitter=0.2)


def sym_mountains(draw, rng, ink):
    """Caret peaks ^^^ (+ small snow cap)."""
    cx, cy = CENTER, CENTER
    n = rng.randint(2, 3)
    spacing = rng.uniform(9, 12)
    total = spacing * (n - 1)
    w = rng.uniform(1.6, 2.2)
    for i in range(n):
        bx = cx - total / 2 + i * spacing + rng.uniform(-1, 1)
        base_y = cy + rng.uniform(3, 7)
        pw = rng.uniform(7, 10)
        ph = rng.uniform(9, 13)
        apex = (bx, base_y - ph)
        stroke(draw, [(bx - pw, base_y), apex], w, ink, rng, jitter=0.25)
        stroke(draw, [apex, (bx + pw, base_y)], w, ink, rng, jitter=0.25)
        if rng.random() < 0.6:                      # snow cap near apex
            scap = ph * rng.uniform(0.18, 0.3)
            stroke(draw, [(bx, apex[1] + scap * 0.4), (bx, apex[1] + scap)],
                   rng.uniform(0.8, 1.3), ink, rng, seg=2, jitter=0.1)
            stroke(draw, [(bx - scap * 0.6, apex[1] + scap * 0.7),
                          (bx + scap * 0.6, apex[1] + scap * 0.7)],
                   rng.uniform(0.8, 1.3), ink, rng, seg=2, jitter=0.1)


def sym_water(draw, rng, ink):
    """Horizontal wavy lines filling the hex."""
    cx, cy = CENTER, CENTER
    nlines = rng.randint(4, 5)
    sp = rng.uniform(7, 9)
    w = rng.uniform(1.4, 1.9)
    amp = rng.uniform(1.8, 3.2)
    half = rng.uniform(15, 19)
    for k in range(nlines):
        y0 = cy - (nlines - 1) / 2.0 * sp + k * sp
        pts = []
        steps = rng.randint(12, 16)
        phase = rng.uniform(0, TAU)
        freq = rng.uniform(0.5, 0.8)
        for s in range(steps + 1):
            t = s / steps
            x = cx - half + 2 * half * t
            y = y0 + math.sin(t * TAU * freq + phase) * amp
            pts.append((x, y))
        stroke(draw, pts, w, ink, rng, seg=1, jitter=0.2, taper=False)


def sym_swamp(draw, rng, ink):
    """Tufts of short horizontal dashes (+ a couple of longer water dashes)."""
    cx, cy = CENTER, CENTER
    for _ in range(rng.randint(2, 4)):
        gx = cx + rng.uniform(-12, 12)
        gy = cy + rng.uniform(-9, 9)
        nd = rng.randint(2, 3)
        dsp = rng.uniform(2.5, 3.5)
        dl = rng.uniform(4, 7)
        for j in range(nd):
            yy = gy - (nd - 1) / 2.0 * dsp + j * dsp
            stroke(draw, [(gx - dl / 2, yy), (gx + dl / 2, yy)],
                   rng.uniform(1.0, 1.5), ink, rng, seg=2, jitter=0.2)
    for _ in range(rng.randint(1, 2)):              # longer water dashes
        wy = cy + rng.uniform(-12, 12)
        wl = rng.uniform(8, 13)
        stroke(draw, [(cx - wl / 2, wy), (cx + wl / 2, wy)],
               rng.uniform(1.0, 1.4), ink, rng, seg=2, jitter=0.15)


def sym_desert(draw, rng, ink):
    """Scattered dots + a couple of small dune arcs."""
    cx, cy = CENTER, CENTER
    R = rng.uniform(13, 17)
    for _ in range(rng.randint(12, 20)):
        a = rng.uniform(0, TAU)
        r = R * math.sqrt(rng.random())
        dot(draw, cx + math.cos(a) * r, cy + math.sin(a) * r,
            rng.uniform(0.7, 1.4), ink, rng)
    for _ in range(rng.randint(1, 2)):
        dx = cx + rng.uniform(-8, 8)
        dy = cy + rng.uniform(-6, 8)
        dw = rng.uniform(5, 8)
        dh = rng.uniform(2, 4)
        pts = []
        steps = 10
        for s in range(steps + 1):
            t = s / steps
            x = dx - dw + 2 * dw * t
            y = dy - dh * math.sin(t * math.pi)
            pts.append((x, y))
        stroke(draw, pts, rng.uniform(0.9, 1.3), ink, rng, seg=1, jitter=0.15)


def sym_road(draw, rng, ink):
    """A line / dashed path crossing the hex."""
    cx, cy = CENTER, CENTER
    w = rng.uniform(1.6, 2.4)
    ang = rng.uniform(0, math.pi)
    L = rng.uniform(24, 30)
    x0, y0 = cx - math.cos(ang) * L / 2, cy - math.sin(ang) * L / 2
    x1, y1 = cx + math.cos(ang) * L / 2, cy + math.sin(ang) * L / 2
    if rng.random() < 0.4:                          # dashed
        nd = rng.randint(4, 6)
        for i in range(nd):
            t0, t1 = i / nd, (i + 0.6) / nd
            stroke(draw, [(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0),
                           (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)],
                   w, ink, rng, jitter=0.3)
    else:                                           # solid, gently curved
        bulge = rng.uniform(-3, 3)
        perpx, perpy = -math.sin(ang), math.cos(ang)
        pts = []
        steps = 12
        for s in range(steps + 1):
            t = s / steps
            x = x0 + (x1 - x0) * t + perpx * bulge * math.sin(t * math.pi)
            y = y0 + (y1 - y0) * t + perpy * bulge * math.sin(t * math.pi)
            pts.append((x, y))
        stroke(draw, pts, w, ink, rng, seg=1, jitter=0.2)


def sym_jungle(draw, rng, ink):
    """Dense overlapping trees (denser + slightly larger than forest)."""
    cx, cy = CENTER, CENTER
    for _ in range(rng.randint(6, 9)):
        a = rng.uniform(0, TAU)
        r = rng.uniform(11, 14) * math.sqrt(rng.random())
        tx, ty = cx + math.cos(a) * r, cy + math.sin(a) * r + 4
        _tree(draw, rng, ink, tx, ty, scale=rng.uniform(1.0, 1.25))


def sym_tundra(draw, rng, ink):
    """Sparse dots + snowflake ticks."""
    cx, cy = CENTER, CENTER
    R = rng.uniform(12, 16)
    for _ in range(rng.randint(2, 4)):
        a = rng.uniform(0, TAU)
        r = R * math.sqrt(rng.random())
        snowflake(draw, rng, ink, cx + math.cos(a) * r, cy + math.sin(a) * r,
                  rng.uniform(2.5, 4.0))
    for _ in range(rng.randint(3, 6)):
        a = rng.uniform(0, TAU)
        r = R * math.sqrt(rng.random())
        dot(draw, cx + math.cos(a) * r, cy + math.sin(a) * r,
            rng.uniform(0.6, 1.1), ink, rng)


def sym_coast(draw, rng, ink):
    """Wavy water on one side + blank land on the other."""
    cx, cy = CENTER, CENTER
    half = rng.uniform(18, 22)
    amp = rng.uniform(1.5, 3.0)
    div_y = cy + rng.uniform(-4, 4)
    freq = rng.uniform(0.6, 0.9)
    phase = rng.uniform(0, TAU)
    wy_dir = rng.choice([-1, 1])                    # which side is water

    steps = 16
    divpts = []
    for s in range(steps + 1):
        t = s / steps
        x = cx - half + 2 * half * t
        y = div_y + math.sin(t * TAU * freq + phase) * amp
        divpts.append((x, y))
    stroke(draw, divpts, rng.uniform(1.2, 1.8), ink, rng, seg=1, jitter=0.2)

    for j in range(1, rng.randint(2, 4)):           # water wavy lines on one side
        off = j * rng.uniform(4, 6)
        dpts = []
        h2 = half * 0.7
        for s in range(steps + 1):
            t = s / steps
            x = cx - h2 + 2 * h2 * t
            y = div_y + wy_dir * off + math.sin(t * TAU * freq + phase + j) * amp * 0.8
            dpts.append((x, y))
        stroke(draw, dpts, rng.uniform(1.0, 1.4), ink, rng,
               seg=1, jitter=0.2, taper=False)


def sym_town(draw, rng, ink):
    """Little buildings / squares (some with a roof)."""
    cx, cy = CENTER, CENTER
    R = rng.uniform(8, 11)
    for _ in range(rng.randint(3, 5)):
        a = rng.uniform(0, TAU)
        r = R * math.sqrt(rng.random())
        bx, by = cx + math.cos(a) * r, cy + math.sin(a) * r
        bw, bh = rng.uniform(4, 7), rng.uniform(4, 7)
        x0, y0, x1, y1 = bx - bw / 2, by - bh / 2, bx + bw / 2, by + bh / 2
        rect(draw, x0, y0, x1, y1, rng.uniform(1.2, 1.8), ink, rng, jitter=0.25)
        if rng.random() < 0.4:                      # peaked roof
            peak = (bx, y0 - rng.uniform(2, 3.5))
            stroke(draw, [(x0, y0), peak], rng.uniform(1.0, 1.5), ink, rng, jitter=0.2)
            stroke(draw, [peak, (x1, y0)], rng.uniform(1.0, 1.5), ink, rng, jitter=0.2)


def sym_ruins(draw, rng, ink):
    """Broken rectangle (a few partial sides) + stray line fragments."""
    cx, cy = CENTER, CENTER
    w = rng.uniform(1.4, 2.0)
    sz = rng.uniform(14, 19)
    x0, y0, x1, y1 = cx - sz / 2, cy - sz / 2, cx + sz / 2, cy + sz / 2
    sides = [
        [(x0, y0), (x1, y0)],   # top
        [(x1, y0), (x1, y1)],   # right
        [(x0, y1), (x1, y1)],   # bottom
        [(x0, y0), (x0, y1)],   # left
    ]
    order = list(range(4))
    rng.shuffle(order)
    for i in order[:rng.randint(2, 3)]:
        a, b = sides[i]
        if rng.random() < 0.6:
            a, b = _partial(a, b, rng)              # break the side
        stroke(draw, [a, b], w, ink, rng, jitter=0.3)
    for _ in range(rng.randint(1, 3)):              # stray fragments
        fx = cx + rng.uniform(-sz / 2, sz / 2)
        fy = cy + rng.uniform(-sz / 2, sz / 2)
        fl = rng.uniform(3, 6)
        fa = rng.uniform(0, math.pi)
        stroke(draw, [(fx, fy), (fx + math.cos(fa) * fl, fy + math.sin(fa) * fl)],
               rng.uniform(1.0, 1.5), ink, rng, jitter=0.2)


SYM = {
    "plains":    sym_plains,
    "forest":    sym_forest,
    "hills":     sym_hills,
    "mountains": sym_mountains,
    "water":     sym_water,
    "swamp":     sym_swamp,
    "desert":    sym_desert,
    "road":      sym_road,
    "jungle":    sym_jungle,
    "tundra":    sym_tundra,
    "coast":     sym_coast,
    "town":      sym_town,
    "ruins":     sym_ruins,
}


# --------------------------------------------------------------------------- #
# Augmentation pipeline
# --------------------------------------------------------------------------- #
def augment_geom(img, rng, fill):
    """Rotate ±12°, scale 0.8-1.15, translate ±4px (cell units)."""
    angle = rng.uniform(-12, 12)
    scale = rng.uniform(0.8, 1.15)
    tx = rng.uniform(-4, 4) * SS
    ty = rng.uniform(-4, 4) * SS
    rot = img.rotate(angle, resample=Image.Resampling.BICUBIC,
                     expand=False, fillcolor=fill)
    ns = max(4, int(S * scale))
    scaled = rot.resize((ns, ns), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (S, S), fill)
    ox = (S - ns) // 2 + int(round(tx))
    oy = (S - ns) // 2 + int(round(ty))
    canvas.paste(scaled, (ox, oy))
    return canvas


def add_noise(img, rng):
    arr = np.asarray(img).astype(np.float32)
    sigma = rng.uniform(3.0, 9.0)
    noise = np.random.normal(0.0, sigma, arr.shape).astype(np.float32)
    arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def make_sample(cls, rng):
    paper = rng.choice(PAPER_CHOICES)
    img = Image.new("RGB", (S, S), paper)
    draw = ImageDraw.Draw(img)
    draw_hex(draw, rng, rng.choice(HEX_CHOICES))
    ink = rng.choice(INK_CHOICES)
    SYM[cls](draw, rng, ink)
    img = augment_geom(img, rng, paper)
    img = img.resize((CELL, CELL), Image.Resampling.LANCZOS)
    img = add_noise(img, rng)
    if rng.random() < 0.22:
        img = img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.25, 0.7)))
    return img


# --------------------------------------------------------------------------- #
# Split + montage + main
# --------------------------------------------------------------------------- #
def make_split(rng):
    if os.path.exists(OUT_SPLIT):
        shutil.rmtree(OUT_SPLIT)
    counts = {}
    for c in CLASSES:
        src_dir = os.path.join(OUT_MASTER, c)
        files = sorted(f for f in os.listdir(src_dir) if f.endswith(".png"))
        rng.shuffle(files)
        nv = int(round(len(files) * 0.15))
        split = {"train": files[nv:], "val": files[:nv]}
        counts[c] = {"train": len(split["train"]), "val": len(split["val"])}
        for sub, items in split.items():
            dd = os.path.join(OUT_SPLIT, sub, c)
            os.makedirs(dd, exist_ok=True)
            for f in items:
                shutil.copy(os.path.join(src_dir, f), os.path.join(dd, f))
    return counts


def make_montage():
    cols = 5
    rows = math.ceil(len(CLASSES) / cols)
    pad = 6
    cell = CELL + pad
    canvas = Image.new("RGB", (cols * cell + pad, rows * cell + pad), (30, 30, 30))
    d = ImageDraw.Draw(canvas)
    for i, c in enumerate(CLASSES):
        col, row = i % cols, i // cols
        x = pad + col * cell
        y = pad + row * cell
        src_dir = os.path.join(OUT_MASTER, c)
        files = sorted(f for f in os.listdir(src_dir) if f.endswith(".png"))
        if files:
            tile = Image.open(os.path.join(src_dir, files[0])).convert("RGB")
            canvas.paste(tile, (x, y))
        d.text((x, y + CELL + 1), c, fill=(230, 230, 230))
    canvas.save(PREVIEW)


def main():
    rng = random.Random(SEED)
    np.random.seed(SEED)

    if os.path.exists(OUT_MASTER):
        shutil.rmtree(OUT_MASTER)
    for c in CLASSES:
        os.makedirs(os.path.join(OUT_MASTER, c), exist_ok=True)
    os.makedirs(MODELS_DIR, exist_ok=True)

    counts = {}
    for c in CLASSES:
        for i in range(N_PER):
            img = make_sample(c, rng)
            img.save(os.path.join(OUT_MASTER, c, f"{i:04d}.png"))
        counts[c] = N_PER
        print(f"  {c:10s} {N_PER}")

    split_counts = make_split(rng)
    make_montage()

    with open(os.path.join(MODELS_DIR, "terrain_labels.json"), "w") as f:
        json.dump(sorted(CLASSES), f, indent=2)

    total = sum(counts.values())
    print(f"\nGenerated {total} images into {OUT_MASTER}")
    print(f"Split -> {OUT_SPLIT}  (train/val per class shown above)")
    print(f"Preview -> {PREVIEW}")
    print(f"Labels  -> {os.path.join(MODELS_DIR, 'terrain_labels.json')}")
    print("\nStratified split:")
    for c in CLASSES:
        print(f"  {c:10s} train={split_counts[c]['train']:4d}  val={split_counts[c]['val']:3d}")


if __name__ == "__main__":
    main()
