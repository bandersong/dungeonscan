#!/usr/bin/env python3
"""
DungeonScan synthetic map generator.

Procedurally draws hand-drawn-style dungeon maps on dot-grid paper — bro's style:
bold wobbly marker walls, dense vegetation hatching outside the rooms, doors,
stairs, room numbers — then augments each into a "phone photo" (rotation,
perspective keystone, lighting, paper texture, JPEG). Emits image + JSON label
with the ground-truth grid geometry (the 4 grid corners in FINAL image pixels,
plus cell size and per-cell floor / per-edge wall masks) for training.

Deps: numpy, Pillow only.  Usage:  python gen.py OUTDIR N [--preview]
"""
import sys, os, json, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ----------------------------- small helpers -----------------------------
def rnd(a, b): return random.uniform(a, b)
def rndi(a, b): return random.randint(a, b)
def jitter_pt(x, y, j): return (x + rnd(-j, j), y + rnd(-j, j))

def wobbly_line(draw, p0, p1, width, color, seg=None, jit=1.4):
    """A hand-drawn line: many short segments with perpendicular noise + width jitter."""
    x0, y0 = p0; x1, y1 = p1
    L = math.hypot(x1 - x0, y1 - y0)
    if seg is None: seg = max(2, int(L / 9))
    nx, ny = (y1 - y0) / (L + 1e-6), -(x1 - x0) / (L + 1e-6)  # perpendicular
    pts = []
    for i in range(seg + 1):
        t = i / seg
        off = rnd(-jit, jit) * math.sin(t * math.pi)  # bow out in the middle
        px = x0 + (x1 - x0) * t + nx * off
        py = y0 + (y1 - y0) * t + ny * off
        pts.append((px, py))
    for i in range(seg):
        w = max(1, width + rnd(-0.9, 0.9))
        draw.line([pts[i], pts[i + 1]], fill=color, width=int(round(w)))

def ink(shade=0):
    v = rndi(18, 46) + shade
    return (v, v, max(0, v - rndi(0, 6)))

# ----------------------------- layout -----------------------------
def gen_layout(cols, rows):
    """Return a boolean floor mask [rows,cols] of rooms + connecting corridors."""
    floor = np.zeros((rows, cols), bool)
    centers = []
    for _ in range(rndi(5, 13)):  # rectangular rooms (denser)
        rw, rh = rndi(2, max(2, cols // 2)), rndi(2, max(2, rows // 3))
        cx, cy = rndi(1, max(1, cols - rw - 1)), rndi(1, max(1, rows - rh - 1))
        floor[cy:cy + rh, cx:cx + rw] = True
        centers.append((cx + rw // 2, cy + rh // 2))
    yy, xx = np.ogrid[:rows, :cols]
    for _ in range(rndi(0, 2)):  # circular rooms (bro draws these)
        rad = rndi(2, max(2, min(cols, rows) // 5))
        if cols - rad - 1 <= rad + 1 or rows - rad - 1 <= rad + 1:
            continue
        cx, cy = rndi(rad + 1, cols - rad - 1), rndi(rad + 1, rows - rad - 1)
        floor[(xx - cx) ** 2 + (yy - cy) ** 2 <= rad * rad] = True
        centers.append((cx, cy))
    # connect consecutive room centers with L-shaped 1-cell corridors
    for i in range(1, len(centers)):
        (x0, y0), (x1, y1) = centers[i - 1], centers[i]
        for x in range(min(x0, x1), max(x0, x1) + 1): floor[y0, x] = True
        for y in range(min(y0, y1), max(y0, y1) + 1): floor[y, x1] = True
    return floor

# ----------------------------- drawing -----------------------------
def draw_dot_grid(draw, W, H, D, ox, oy):
    dot = (rndi(150, 195), rndi(148, 190), rndi(135, 175))
    y = oy % D
    while y < H:
        x = ox % D
        while x < W:
            r = rnd(0.6, 1.3)
            jx, jy = jitter_pt(x, y, 0.4)
            draw.ellipse([jx - r, jy - r, jx + r, jy + r], fill=dot)
            x += D
        y += D

def draw_map(floor, cell, ox, oy, D, pad_r, pad_b):
    rows, cols = floor.shape
    # variable margins → the grid occupies a varying fraction of the page, so the
    # model learns to find the tight grid even when the drawing is small on the page
    W = int(ox + cols * cell + pad_r)
    H = int(oy + rows * cell + pad_b)
    paper = (rndi(230, 243), rndi(224, 238), rndi(205, 222))
    img = Image.new("RGB", (W, H), paper)
    dr = ImageDraw.Draw(img)
    draw_dot_grid(dr, W, H, D, ox % D, oy % D)

    def cx(c): return ox + c * cell
    def cy(r): return oy + r * cell

    # dilate the floor mask by up to 2 cells → the "vegetation band" that rings rooms
    from itertools import product
    veg = np.zeros_like(floor)
    band = rndi(1, 3)
    fy, fx = np.where(floor)
    for r, c in zip(fy, fx):
        for dr_, dc in product(range(-band, band + 1), repeat=2):
            rr, cc = r + dr_, c + dc
            if 0 <= rr < rows and 0 <= cc < cols and not floor[rr, cc]:
                veg[rr, cc] = True
    # vegetation hatching: dense short strokes filling the band around the rooms
    for r in range(rows):
        for c in range(cols):
            if not veg[r, c] or random.random() < 0.12:
                continue
            x0, y0 = cx(c), cy(r)
            n = rndi(16, 34)
            for _ in range(n):
                sx, sy = x0 + rnd(1, cell - 1), y0 + rnd(1, cell - 1)
                ang = rnd(-0.9, 0.9) + math.pi / 2
                ln = rnd(3, 9)
                dr.line([(sx, sy), (sx + math.cos(ang) * ln, sy + math.sin(ang) * ln)],
                        fill=ink(), width=1)

    # light interior grid — bro draws every floor cell as a little ruled square
    for r in range(rows):
        for c in range(cols):
            if not floor[r, c]:
                continue
            x0, y0, x1, y1 = cx(c), cy(r), cx(c + 1), cy(r + 1)
            for a, b in (((x0, y0), (x1, y0)), ((x0, y0), (x0, y1)),
                         ((x1, y0), (x1, y1)), ((x0, y1), (x1, y1))):
                wobbly_line(dr, a, b, 1.3, ink(72), jit=0.8)

    # walls: bold marker on every floor-cell edge adjacent to non-floor
    ww = rnd(3.2, 5.4)
    for r in range(rows):
        for c in range(cols):
            if not floor[r, c]:
                continue
            x0, y0, x1, y1 = cx(c), cy(r), cx(c + 1), cy(r + 1)
            if r == 0 or not floor[r - 1, c]:
                wobbly_line(dr, (x0, y0), (x1, y0), ww, ink())
            if r == rows - 1 or not floor[r + 1, c]:
                wobbly_line(dr, (x0, y1), (x1, y1), ww, ink())
            if c == 0 or not floor[r, c - 1]:
                wobbly_line(dr, (x0, y0), (x0, y1), ww, ink())
            if c == cols - 1 or not floor[r, c + 1]:
                wobbly_line(dr, (x1, y0), (x1, y1), ww, ink())

    # faint interior texture marks in some floor cells (bro's tally/dots)
    for r in range(rows):
        for c in range(cols):
            if floor[r, c] and random.random() < 0.25:
                x0, y0 = cx(c), cy(r)
                for _ in range(rndi(1, 3)):
                    sx, sy = x0 + rnd(cell * .3, cell * .7), y0 + rnd(cell * .3, cell * .7)
                    dr.line([(sx, sy), (sx + rnd(-3, 3), sy + rnd(2, 5))], fill=ink(40), width=1)

    # symbols: doors (gaps in walls), stairs, room numbers
    edges = []
    for r in range(rows):
        for c in range(cols):
            if not floor[r, c]:
                continue
            if r == 0 or not floor[r - 1, c]: edges.append(('h', cx(c), cy(r), cx(c + 1), cy(r)))
            if r == rows - 1 or not floor[r + 1, c]: edges.append(('h', cx(c), cy(r + 1), cx(c + 1), cy(r + 1)))
            if c == 0 or not floor[r, c - 1]: edges.append(('v', cx(c), cy(r), cx(c), cy(r + 1)))
            if c == cols - 1 or not floor[r, c + 1]: edges.append(('v', cx(c + 1), cy(r), cx(c + 1), cy(r + 1)))
    random.shuffle(edges)
    for e in edges[:rndi(1, 4)]:
        o, ax, ay, bx, by = e
        mx, my = (ax + bx) / 2, (ay + by) / 2
        g = cell * 0.32
        if o == 'h':
            dr.rectangle([mx - g, my - 3, mx + g, my + 3], fill=paper)
            wobbly_line(dr, (mx - g, my), (mx + g, my), 1.7, ink(55), jit=0.5)
        else:
            dr.rectangle([mx - 3, my - g, mx + 3, my + g], fill=paper)
            wobbly_line(dr, (mx, my - g), (mx, my + g), 1.7, ink(55), jit=0.5)
    if fy.size:
        for _ in range(rndi(0, 2)):  # stairs
            i = rndi(0, fy.size - 1); r, c = fy[i], fx[i]
            x0, y0 = cx(c), cy(r)
            for t in range(rndi(3, 6)):
                yy = y0 + cell * (0.2 + 0.6 * t / 5)
                wobbly_line(dr, (x0 + cell * 0.2, yy), (x0 + cell * 0.8, yy), 2.0, ink(), jit=0.4)
        for _ in range(rndi(2, 5)):  # room numbers
            i = rndi(0, fy.size - 1); r, c = fy[i], fx[i]
            dr.text((cx(c) + cell * 0.25, cy(r) + cell * 0.2), str(rndi(1, 20)), fill=ink())

    corners = [(ox, oy), (ox + cols * cell, oy), (ox + cols * cell, oy + rows * cell), (ox, oy + rows * cell)]
    return img, corners

# ----------------------------- augmentation -----------------------------
def perspective_coeffs(src, dst):
    """coeffs mapping OUTPUT(dst)->INPUT(src) for PIL Image.transform PERSPECTIVE."""
    A = []
    for (x, y), (X, Y) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -X * x, -X * y])
        A.append([0, 0, 0, x, y, 1, -Y * x, -Y * y])
    A = np.array(A, float)
    B = np.array(sum([[X, Y] for X, Y in src], []), float)
    res = np.linalg.solve(A, B)
    return res.tolist()

def augment(img, corners):
    W, H = img.size
    # place on a darker "table" background with a margin, so the page has borders
    m = rndi(20, 90)
    bg = (rndi(20, 70), rndi(18, 62), rndi(15, 55))
    canvas = Image.new("RGB", (W + 2 * m, H + 2 * m), bg)
    canvas.paste(img, (m, m))
    corners = [(x + m, y + m) for x, y in corners]
    W2, H2 = canvas.size

    # geometric: rotation + perspective, applied as one homography via corner map
    ang = math.radians(rnd(-24, 24))
    ca, sa = math.cos(ang), math.sin(ang)
    cxp, cyp = W2 / 2, H2 / 2
    def rot(p):
        x, y = p[0] - cxp, p[1] - cyp
        return (cxp + x * ca - y * sa, cyp + x * sa + y * ca)
    # keystone: nudge the 4 image corners inward by random amounts
    kp = 0.10
    img_c = [(0, 0), (W2, 0), (W2, H2), (0, H2)]
    warp_c = [rot((x + rnd(-kp, kp) * W2, y + rnd(-kp, kp) * H2)) for x, y in img_c]
    # transform maps output->input; we want input(img_c)->output(warp_c), invert:
    coeffs = perspective_coeffs(img_c, warp_c)
    out = canvas.transform((W2, H2), Image.PERSPECTIVE, coeffs, resample=Image.BILINEAR, fillcolor=bg)
    # move the grid corners through the same forward map
    a, b, c, d, e, f, g, h = coeffs  # output->input
    def fwd(p):  # input->output : invert the projective map
        # solve for (x,y) out such that map(out)=in ; do it numerically via the inverse matrix
        M = np.array([[a, b, c], [d, e, f], [g, h, 1]])
        Minv = np.linalg.inv(M)
        v = Minv @ np.array([p[0], p[1], 1.0])
        return (v[0] / v[2], v[1] / v[2])
    corners = [fwd(p) for p in corners]

    # photometric: soft lighting gradient + vignette + white balance
    arr = np.asarray(out).astype(np.float32)
    yy, xx = np.mgrid[0:H2, 0:W2]
    gx, gy = rnd(-1, 1), rnd(-1, 1)
    grad = 1.0 + 0.18 * (gx * (xx / W2 - .5) + gy * (yy / H2 - .5))
    r = np.sqrt((xx / W2 - .5) ** 2 + (yy / H2 - .5) ** 2)
    vig = 1.0 - rnd(0.15, 0.4) * (r ** 2)
    arr *= (grad * vig)[..., None]
    arr[..., 0] *= rnd(1.0, 1.06); arr[..., 2] *= rnd(0.94, 1.0)  # warm
    arr += np.random.normal(0, rnd(1.5, 5.0), arr.shape)
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    if random.random() < 0.6:
        out = out.filter(ImageFilter.GaussianBlur(rnd(0.3, 0.9)))
    return out, corners

# ----------------------------- main -----------------------------
# A clean (un-augmented, axis-aligned) map + its ground truth. Reused by the
# full-image generator (below) AND the cell-crop generator (gen_cells.py).
def clean_sample():
    D = rndi(12, 20)                 # dot pitch
    k = rndi(2, 4)                    # dots per cell
    cell = D * k
    cols, rows = rndi(8, 20), rndi(10, 26)
    # variable page margins (in cells) around the grid — sometimes tight, sometimes lots of blank paper
    ox = rndi(0, 5) * cell + rndi(D, 2 * D)
    oy = rndi(0, 5) * cell + rndi(D, 2 * D)
    pad_r = rndi(0, 6) * cell + rndi(D, 2 * D)
    pad_b = rndi(0, 6) * cell + rndi(D, 2 * D)
    floor = gen_layout(cols, rows)
    img, corners = draw_map(floor, cell, ox, oy, D, pad_r, pad_b)
    return {"img": img, "floor": floor, "cell": cell, "ox": ox, "oy": oy, "D": D, "corners": corners}

def one():
    s = clean_sample()
    img, corners = s["img"], s["corners"]
    out, corners = augment(img, corners)
    # normalize longest side to 1600 like the app
    W, H = out.size
    s = 1600 / max(W, H)
    out = out.resize((int(W * s), int(H * s)), Image.LANCZOS)
    corners = [(x * s, y * s) for x, y in corners]
    label = {"corners": [[round(x, 1), round(y, 1)] for x, y in corners],
             "cell": round(cell * s, 2), "cols": cols, "rows": rows,
             "floor": floor.astype(int).tolist()}
    return out, label

def _gen_to_disk(args):
    i, outdir = args
    random.seed(os.getpid() * 100000 + i); np.random.seed((os.getpid() * 100000 + i) % (2**32))
    img, label = one()
    img.save(os.path.join(outdir, f"s{i:06d}.jpg"), quality=rndi(62, 90))
    json.dump(label, open(os.path.join(outdir, f"s{i:06d}.json"), "w"))
    return i

def main():
    outdir = sys.argv[1]; n = int(sys.argv[2]); preview = "--preview" in sys.argv
    os.makedirs(outdir, exist_ok=True)
    if preview:
        cols = 3; rows = (n + cols - 1) // cols
        thumbs = [one()[0].resize((360, 480)) for _ in range(n)]
        sheet = Image.new("RGB", (cols * 360, rows * 480), (0, 0, 0))
        for i, t in enumerate(thumbs):
            sheet.paste(t, ((i % cols) * 360, (i // cols) * 480))
        sheet.save(os.path.join(outdir, "preview.png"))
        print("wrote", os.path.join(outdir, "preview.png"))
        return
    import multiprocessing as mp, time
    t0 = time.time()
    with mp.Pool(mp.cpu_count()) as pool:
        for k, _ in enumerate(pool.imap_unordered(_gen_to_disk, [(i, outdir) for i in range(n)], chunksize=16)):
            if k % 500 == 0: print(k, f"{k/max(1e-6,time.time()-t0):.0f}/s", flush=True)
    print("done", n, f"in {time.time()-t0:.0f}s")

if __name__ == "__main__":
    random.seed(); np.random.seed()
    main()
