#!/usr/bin/env python3
"""
DungeonScan — synthetic glyph dataset generator.

Draws 64x64 crops of a SINGLE grid cell of a hand-drawn dungeon map, one symbol
per tile, in a wobbly hand-drawn ink style on faint-grid paper, with heavy
augmentation. Output:

    training/dataset/<class>/<i>.png        master set (~N_PER/class)
    training/dataset_split/{train,val}/<class>/<i>.png   stratified 85/15
    models/labels.json                       class label list (alphabetical)
    training/preview.png                     montage, one sample per class

Classes (folder-per-class):
    plain, door, secret_door, stairs, water, rubble, column, statue, altar,
    trap, chest, pit, portcullis

Run:
    ~/scrubbuddy/.venv/bin/python gen_glyphs.py            # N_PER=450 default
    N_PER=600 ~/scrubbuddy/.venv/bin/python gen_glyphs.py  # override count
"""

import os
import sys
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
OUT_MASTER  = os.path.join(HERE, "dataset")
OUT_SPLIT   = os.path.join(HERE, "dataset_split")
MODELS_DIR  = os.path.join(ROOT, "models")
PREVIEW     = os.path.join(HERE, "preview.png")

CLASSES = ["plain", "door", "secret_door", "stairs", "water", "rubble",
           "column", "statue", "altar", "trap", "chest", "pit", "portcullis"]

N_PER = int(os.environ.get("N_PER", "450"))
SEED  = 1234

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
# Faint grid line color — low contrast so the model learns to ignore it.
GRID_CHOICES = [
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


# --------------------------------------------------------------------------- #
# Background: faint grid + partial dungeon walls on edges
# --------------------------------------------------------------------------- #
def draw_grid(draw, rng, grid_color):
    """Faint cell-border grid lines (drawn on most edges, light + thin)."""
    inset = rng.uniform(0.3, 1.6)
    w = rng.uniform(0.45, 0.85)
    segs = [
        ((inset, inset),            (CELL - inset, inset)),
        ((inset, CELL - inset),     (CELL - inset, CELL - inset)),
        ((inset, inset),            (inset, CELL - inset)),
        ((CELL - inset, inset),     (CELL - inset, CELL - inset)),
    ]
    for a, b in segs:
        if rng.random() < 0.92:
            stroke(draw, [a, b], w, grid_color, rng, jitter=0.25, taper=False)


def draw_walls(draw, rng, ink, max_edges=2, strong=True):
    """Strong partial wall lines along random cell edges."""
    n = rng.randint(0, max_edges)
    edges = rng.sample(["top", "bottom", "left", "right"], n)
    w = rng.uniform(2.4, 3.4) if strong else rng.uniform(1.7, 2.3)
    for e in edges:
        m1, m2 = rng.uniform(0.5, 9.0), rng.uniform(0.5, 9.0)
        off = rng.uniform(1.2, 3.0)
        if e == "top":
            a, b = (m1, off), (CELL - m2, off)
        elif e == "bottom":
            a, b = (m1, CELL - off), (CELL - m2, CELL - off)
        elif e == "left":
            a, b = (off, m1), (off, CELL - m2)
        else:
            a, b = (CELL - off, m1), (CELL - off, CELL - m2)
        stroke(draw, [a, b], w, ink, rng, jitter=0.45)


# --------------------------------------------------------------------------- #
# Per-class symbol drawing (centered ~ (CENTER, CENTER), cell units)
# --------------------------------------------------------------------------- #
def sym_plain(draw, rng, ink):
    pass  # plain: only background grid + walls (added by caller)


def sym_door(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    gap = rng.uniform(11, 15)
    stub = rng.uniform(13, 18)
    w = rng.uniform(2.2, 3.0)
    if rng.random() < 0.5:                      # horizontal wall + leaf
        stroke(draw, [(cx - stub - gap, cy), (cx - gap, cy)], w, ink, rng)
        stroke(draw, [(cx + gap, cy), (cx + stub + gap, cy)], w, ink, rng)
        leaf, side = rng.uniform(9, 13), rng.choice([-1, 1])
        stroke(draw, [(cx + side * gap, cy), (cx + side * gap, cy - leaf)],
               rng.uniform(1.7, 2.3), ink, rng, jitter=0.4)
    else:                                       # vertical wall + leaf
        stroke(draw, [(cx, cy - stub - gap), (cx, cy - gap)], w, ink, rng)
        stroke(draw, [(cx, cy + gap), (cx, cy + stub + gap)], w, ink, rng)
        leaf, side = rng.uniform(9, 13), rng.choice([-1, 1])
        stroke(draw, [(cx, cy + side * gap), (cx - side * leaf, cy + side * gap)],
               rng.uniform(1.7, 2.3), ink, rng, jitter=0.4)


def sym_secret_door(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    gap = rng.uniform(10, 14)
    stub = rng.uniform(13, 18)
    w = rng.uniform(2.0, 2.6)
    mode = rng.random()
    if mode < 0.6:                              # wall stubs + dashed marker
        horiz = rng.random() < 0.5
        if horiz:
            stroke(draw, [(cx - stub - gap, cy), (cx - gap, cy)], w, ink, rng)
            stroke(draw, [(cx + gap, cy), (cx + stub + gap, cy)], w, ink, rng)
            nd = rng.randint(3, 4)
            for i in range(nd):
                t = -1 + 2 * (i + 0.5) / nd
                xx = cx + t * gap * 0.7
                stroke(draw, [(xx, cy - 5), (xx, cy + 5)],
                       rng.uniform(1.0, 1.6), ink, rng, seg=3, jitter=0.25)
        else:
            stroke(draw, [(cx, cy - stub - gap), (cx, cy - gap)], w, ink, rng)
            stroke(draw, [(cx, cy + gap), (cx, cy + stub + gap)], w, ink, rng)
            nd = rng.randint(3, 4)
            for i in range(nd):
                t = -1 + 2 * (i + 0.5) / nd
                yy = cy + t * gap * 0.7
                stroke(draw, [(cx - 5, yy), (cx + 5, yy)],
                       rng.uniform(1.0, 1.6), ink, rng, seg=3, jitter=0.25)
    else:                                       # small "S" squiggle
        r = rng.uniform(6, 8)
        pts = []
        for i in range(20):
            t = i / 19
            x = cx - r + 2 * r * t
            y = cy + math.sin(t * TAU) * r * 0.8
            pts.append((x, y))
        stroke(draw, pts, rng.uniform(1.6, 2.2), ink, rng, seg=1, jitter=0.25)


def sym_stairs(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    n = rng.randint(4, 6)
    spacing = rng.uniform(5, 7)
    total = spacing * (n - 1)
    half = rng.uniform(11, 15)
    w = rng.uniform(1.8, 2.4)
    if rng.random() < 0.5:                      # horizontal rungs
        for i in range(n):
            y = cy - total / 2 + i * spacing
            stroke(draw, [(cx - half, y), (cx + half, y)], w, ink, rng, jitter=0.3)
        if rng.random() < 0.45:
            stroke(draw, [(cx - half, cy - total / 2), (cx - half, cy + total / 2)],
                   rng.uniform(1.4, 1.8), ink, rng)
            stroke(draw, [(cx + half, cy - total / 2), (cx + half, cy + total / 2)],
                   rng.uniform(1.4, 1.8), ink, rng)
    else:                                       # vertical rungs
        for i in range(n):
            x = cx - total / 2 + i * spacing
            stroke(draw, [(x, cy - half), (x, cy + half)], w, ink, rng, jitter=0.3)


def sym_water(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-2, 2), CENTER + rng.uniform(-2, 2)
    nlines = rng.randint(3, 4)
    sp = rng.uniform(7, 9)
    w = rng.uniform(1.4, 2.0)
    amp = rng.uniform(2.0, 3.5)
    half = rng.uniform(14, 18)
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


def sym_rubble(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    R = rng.uniform(12, 16)
    for _ in range(rng.randint(10, 18)):
        a = rng.uniform(0, TAU)
        r = R * math.sqrt(rng.random())
        dot(draw, cx + math.cos(a) * r, cy + math.sin(a) * r,
            rng.uniform(0.8, 2.0), ink, rng)
    for _ in range(rng.randint(1, 3)):
        a = rng.uniform(0, TAU)
        r = R * math.sqrt(rng.random())
        x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
        L = rng.uniform(2, 4)
        ang = rng.uniform(0, TAU)
        stroke(draw, [(x, y), (x + math.cos(ang) * L, y + math.sin(ang) * L)],
               rng.uniform(1.2, 1.8), ink, rng, jitter=0.2)


def sym_column(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    r = rng.uniform(7, 11)
    if rng.random() < 0.5:
        dot(draw, cx, cy, r, ink, rng)
    else:
        ring(draw, cx, cy, r, rng.uniform(1.6, 2.4), ink, rng)
        if rng.random() < 0.5:
            dot(draw, cx, cy, rng.uniform(1.5, 2.6), ink, rng)


def sym_statue(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-2, 2)
    w = rng.uniform(2.0, 2.6)
    bw = rng.uniform(11, 15)
    bh = rng.uniform(3, 5)
    base_cy = cy + 10
    rect(draw, cx - bw / 2, base_cy, cx + bw / 2, base_cy + bh,
         rng.uniform(1.8, 2.4), ink, rng, jitter=0.3)
    body_top = cy - 6
    stroke(draw, [(cx, base_cy), (cx, body_top + rng.uniform(2, 4))],
           w, ink, rng, jitter=0.3)
    arm = base_cy - rng.uniform(4, 7)
    aw = rng.uniform(5, 8)
    stroke(draw, [(cx - aw, arm), (cx + aw, arm)],
           rng.uniform(1.6, 2.2), ink, rng, jitter=0.3)
    dot(draw, cx, body_top, rng.uniform(2.8, 3.8), ink, rng)


def sym_altar(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    w = rng.uniform(2.0, 2.6)
    tw = rng.uniform(14, 20)
    th = rng.uniform(3, 5)
    top_y = cy - 3
    bot_y = cy + 8
    rect(draw, cx - tw / 2, top_y, cx + tw / 2, top_y + th, w, ink, rng, jitter=0.3)
    leg_in = rng.uniform(1, 3)
    stroke(draw, [(cx - tw / 2 + leg_in, top_y + th), (cx - tw / 2 + leg_in, bot_y)],
           rng.uniform(1.6, 2.2), ink, rng, jitter=0.3)
    stroke(draw, [(cx + tw / 2 - leg_in, top_y + th), (cx + tw / 2 - leg_in, bot_y)],
           rng.uniform(1.6, 2.2), ink, rng, jitter=0.3)
    if rng.random() < 0.4:                      # small cross on top
        stroke(draw, [(cx, top_y - 3), (cx, top_y)], rng.uniform(1.2, 1.8), ink, rng, jitter=0.2)
        stroke(draw, [(cx - 2, top_y - 1.5), (cx + 2, top_y - 1.5)],
               rng.uniform(1.2, 1.8), ink, rng, jitter=0.2)


def sym_trap(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    w = rng.uniform(2.0, 2.8)
    mode = rng.random()
    if mode < 0.5:                              # T
        top_y, stem_y = cy - 9, cy + 9
        half = rng.uniform(9, 13)
        stroke(draw, [(cx - half, top_y), (cx + half, top_y)], w, ink, rng, jitter=0.3)
        stroke(draw, [(cx, top_y), (cx, stem_y)], w, ink, rng, jitter=0.3)
    elif mode < 0.85:                           # X
        r = rng.uniform(9, 13)
        stroke(draw, [(cx - r, cy - r), (cx + r, cy + r)], w, ink, rng, jitter=0.4)
        stroke(draw, [(cx - r, cy + r), (cx + r, cy - r)], w, ink, rng, jitter=0.4)
    else:                                       # compact # crosshatch
        r = rng.uniform(8, 11)
        ww = w * 0.8
        stroke(draw, [(cx - r, cy - r), (cx + r, cy - r)], ww, ink, rng, jitter=0.3)
        stroke(draw, [(cx - r, cy + r), (cx + r, cy + r)], ww, ink, rng, jitter=0.3)
        stroke(draw, [(cx - r, cy - r), (cx - r, cy + r)], ww, ink, rng, jitter=0.3)
        stroke(draw, [(cx + r, cy - r), (cx + r, cy + r)], ww, ink, rng, jitter=0.3)


def sym_chest(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    w = rng.uniform(2.0, 2.6)
    bw, bh = rng.uniform(14, 20), rng.uniform(11, 15)
    x0, y0, x1, y1 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
    rect(draw, x0, y0, x1, y1, w, ink, rng, jitter=0.3)
    lid_y = y0 + bh * rng.uniform(0.28, 0.4)
    stroke(draw, [(x0, lid_y), (x1, lid_y)], rng.uniform(1.6, 2.2), ink, rng, jitter=0.25)
    dot(draw, cx, lid_y + (y1 - lid_y) * 0.5, rng.uniform(1.2, 2.0), ink, rng)


def sym_pit(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    w = rng.uniform(1.8, 2.4)
    sz = rng.uniform(13, 18)
    x0, y0, x1, y1 = cx - sz / 2, cy - sz / 2, cx + sz / 2, cy + sz / 2
    rect(draw, x0, y0, x1, y1, w, ink, rng, jitter=0.3)
    if rng.random() < 0.5:                      # inner concentric square
        f = rng.uniform(0.45, 0.65)
        rect(draw, cx - sz / 2 * f, cy - sz / 2 * f, cx + sz / 2 * f, cy + sz / 2 * f,
             rng.uniform(1.4, 1.8), ink, rng, jitter=0.3)
    else:                                       # diagonal hatch inside
        nd = rng.randint(3, 5)
        for i in range(nd):
            t = (i + 1) / (nd + 1)
            stroke(draw, [(x0, y0 + (y1 - y0) * t), (x0 + (x1 - x0) * t, y0)],
                   rng.uniform(1.0, 1.5), ink, rng, jitter=0.2)


def sym_portcullis(draw, rng, ink):
    cx, cy = CENTER + rng.uniform(-3, 3), CENTER + rng.uniform(-3, 3)
    w = rng.uniform(1.6, 2.2)
    sz = rng.uniform(16, 22)
    x0, y0, x1, y1 = cx - sz / 2, cy - sz / 2, cx + sz / 2, cy + sz / 2
    nv, nh = rng.randint(3, 4), rng.randint(3, 4)
    for i in range(nv):
        x = x0 + (x1 - x0) * (i + 1) / (nv + 1)
        stroke(draw, [(x, y0), (x, y1)], w, ink, rng, jitter=0.25)
    for i in range(nh):
        y = y0 + (y1 - y0) * (i + 1) / (nh + 1)
        stroke(draw, [(x0, y), (x1, y)], w, ink, rng, jitter=0.25)
    if rng.random() < 0.4:
        rect(draw, x0, y0, x1, y1, rng.uniform(1.4, 1.8), ink, rng, jitter=0.3)


SYM = {
    "plain":       sym_plain,
    "door":        sym_door,
    "secret_door": sym_secret_door,
    "stairs":      sym_stairs,
    "water":       sym_water,
    "rubble":      sym_rubble,
    "column":      sym_column,
    "statue":      sym_statue,
    "altar":       sym_altar,
    "trap":        sym_trap,
    "chest":       sym_chest,
    "pit":         sym_pit,
    "portcullis":  sym_portcullis,
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
    grid_color = rng.choice(GRID_CHOICES)
    draw_grid(draw, rng, grid_color)
    ink = rng.choice(INK_CHOICES)
    if cls == "plain":
        draw_walls(draw, rng, ink, max_edges=3, strong=True)
        if rng.random() < 0.3:
            draw_walls(draw, rng, ink, max_edges=1, strong=True)
    else:
        if rng.random() < 0.5:                  # occasional context wall
            draw_walls(draw, rng, ink, max_edges=1, strong=True)
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
    from PIL import ImageFont
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
        n = N_PER if c != "plain" else int(N_PER * 1.2)  # extra negatives
        for i in range(n):
            img = make_sample(c, rng)
            img.save(os.path.join(OUT_MASTER, c, f"{i:04d}.png"))
        counts[c] = n
        print(f"  {c:12s} {n}")

    split_counts = make_split(rng)
    make_montage()

    with open(os.path.join(MODELS_DIR, "labels.json"), "w") as f:
        json.dump(sorted(CLASSES), f, indent=2)

    total = sum(counts.values())
    print(f"\nGenerated {total} images into {OUT_MASTER}")
    print(f"Split -> {OUT_SPLIT}  (train/val per class shown above)")
    print(f"Preview -> {PREVIEW}")
    print(f"Labels  -> {os.path.join(MODELS_DIR, 'labels.json')}")
    print("\nStratified split:")
    for c in CLASSES:
        print(f"  {c:12s} train={split_counts[c]['train']:4d}  val={split_counts[c]['val']:3d}")


if __name__ == "__main__":
    main()
