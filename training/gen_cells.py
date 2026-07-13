#!/usr/bin/env python3
"""
Cell-crop dataset generator for the DungeonScan read-step classifier.

clean_sample() (imported from gen.py) hands us a CLEAN, axis-aligned, un-augmented
map plus its ground-truth grid. Here we walk every grid cell, crop it expanded by a
margin so the crop captures the cell interior AND its 4 boundary walls (the
classifier has to see walls to tell a room cell from vegetation), label it
{floor, outside}, then augment each crop to mimic the imperfect grid alignment and
phone-photo variation the classifier will meet at inference. Emits an ImageFolder
layout (OUTDIR/floor/*.jpg, OUTDIR/outside/*.jpg), 56x56 JPEG q80.

Deps: numpy, Pillow only.  Usage:  python gen_cells.py OUTDIR N | --preview OUTDIR
"""
import sys, os, io, math, random
import numpy as np
from PIL import Image, ImageFilter
from gen import clean_sample

# ----------------------------- helpers -----------------------------
def rnd(a, b): return random.uniform(a, b)
def rndi(a, b): return random.randint(a, b)

def paper_color(img):
    """Page color sampled from the corners (margins are always blank paper)."""
    arr = np.asarray(img)
    H, W = arr.shape[:2]
    corners = [arr[0:6, 0:6], arr[0:6, W - 6:W], arr[H - 6:H, 0:6], arr[H - 6:H, W - 6:W]]
    means = [c.reshape(-1, 3).mean(0) for c in corners]
    return tuple(int(v) for v in max(means, key=lambda m: m.sum()))  # brightest = truest paper

def crop_cell(img, cell, ox, oy, r, c, M, paper):
    """Crop grid cell (r,c) grown by margin M on all sides; pad overhangs with paper."""
    W, H = img.size
    left, top = ox + c * cell - M, oy + r * cell - M
    right, bottom = ox + (c + 1) * cell + M, oy + (r + 1) * cell + M
    if right <= 0 or bottom <= 0 or left >= W or top >= H:  # box entirely off the page
        return None
    cl, ct = max(0, left), max(0, top)
    cr, cb = min(W, right), min(H, bottom)
    sub = img.crop((cl, ct, cr, cb))
    if sub.size != (right - left, bottom - top):  # some edge ran past the page → pad it
        full = Image.new("RGB", (right - left, bottom - top), paper)
        full.paste(sub, (cl - left, ct - top))
        sub = full
    return sub

def extra_paper_crops(img, cell, ox, oy, rows, cols, M, paper, k):
    """k same-size crops from blank page margins well outside the grid (empty paper = outside)."""
    W, H = img.size
    size = cell + 2 * M
    if W <= size or H <= size:
        return []
    gx0, gy0, gx1, gy1 = ox, oy, ox + cols * cell, oy + rows * cell  # grid bounding box
    out = []
    tries = 0
    while len(out) < k and tries < k * 20:
        tries += 1
        x, y = rndi(0, W - size), rndi(0, H - size)
        if x < gx1 and x + size > gx0 and y < gy1 and y + size > gy0:  # overlaps grid → not blank
            continue
        out.append(img.crop((x, y, x + size, y + size)))
    return out

# ----------------------------- per-crop augmentation -----------------------------
def augment_crop(img, cell, paper):
    """Simulate imperfect cell alignment + photo variation. img is a square cell+margin crop."""
    # rotation ±10°, keep canvas, expose paper at the corners
    img = img.rotate(rnd(-10, 10), resample=Image.BILINEAR, fillcolor=paper)

    # translation up to ±0.12*cell — paste onto a paper sheet so the vacated edge reads as paper
    t = 0.12 * cell
    W, H = img.size
    sheet = Image.new("RGB", (W, H), paper)
    sheet.paste(img, (int(round(rnd(-t, t))), int(round(rnd(-t, t)))))
    img = sheet

    # photometric: brightness, contrast, then additive gaussian noise
    arr = np.asarray(img).astype(np.float32)
    bright, contrast = rnd(0.8, 1.2), rnd(0.8, 1.2)
    pivot = arr.mean()
    arr = arr * bright
    arr = (arr - pivot) * contrast + pivot
    arr += np.random.normal(0, rnd(1, 6), arr.shape)
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    # gaussian blur radius [0, 1.0]
    img = img.filter(ImageFilter.GaussianBlur(rnd(0, 1.0)))

    # occasional (30%) slight rescale then center-crop/pad back to the same square
    if random.random() < 0.3:
        s = rnd(0.9, 1.1)
        nw, nh = max(1, int(round(W * s))), max(1, int(round(H * s)))
        img = img.resize((nw, nh), Image.BILINEAR)
        canvas = Image.new("RGB", (W, H), paper)
        offx, offy = (W - nw) // 2, (H - nh) // 2
        sx, sy = max(0, -offx), max(0, -offy)             # source clip (when grown)
        dx, dy = max(0, offx), max(0, offy)              # dest offset (when shrunk)
        cw, ch = min(W, nw), min(H, nh)
        canvas.paste(img.crop((sx, sy, sx + cw, sy + ch)), (dx, dy))
        img = canvas

    return img.resize((56, 56), Image.LANCZOS)

def _bytes(img):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()

# ----------------------------- per-map -----------------------------
def gen_map_crops(i):
    """One clean map → (floor_crops, outside_crops), each a list of augmented 56x56 PIL images."""
    random.seed(os.getpid() * 100000 + i); np.random.seed((os.getpid() * 100000 + i) % (2 ** 32))
    s = clean_sample()
    img, floor = s["img"], s["floor"]
    cell, ox, oy = s["cell"], s["ox"], s["oy"]
    rows, cols = floor.shape
    M = round(0.45 * cell)
    paper = paper_color(img)

    floor_c, outside_c = [], []
    for r in range(rows):
        for c in range(cols):
            sub = crop_cell(img, cell, ox, oy, r, c, M, paper)
            if sub is None:
                continue
            (floor_c if floor[r, c] else outside_c).append(augment_crop(sub, cell, paper))

    # extra blank-paper "outside" crops from the page margins (teach: empty paper = outside)
    for sub in extra_paper_crops(img, cell, ox, oy, rows, cols, M, paper, rndi(4, 8)):
        outside_c.append(augment_crop(sub, cell, paper))

    # balance: keep every floor crop, subsample outside down to ~1.5x the floor count
    cap = int(math.ceil(1.5 * len(floor_c))) if floor_c else len(outside_c)
    if len(outside_c) > cap:
        random.shuffle(outside_c)
        outside_c = outside_c[:cap]
    return floor_c, outside_c

def _gen_cells(args):
    """Pool worker: one map → JPEG-encoded floor/outside crop bytes."""
    (i,) = args
    f, o = gen_map_crops(i)
    return [_bytes(im) for im in f], [_bytes(im) for im in o]

# ----------------------------- main -----------------------------
def preview_mode(outdir):
    """~40 random crops → OUTDIR/preview.png with each label drawn under it (visual QA)."""
    from PIL import ImageDraw
    os.makedirs(outdir, exist_ok=True)
    samples = []  # (label, img)
    i = 0
    while len(samples) < 40 and i < 200:
        f, o = gen_map_crops(i)
        for im in f: samples.append(("floor", im))
        for im in o: samples.append(("outside", im))
        i += 1
    random.shuffle(samples)   # mix classes so the montage shows both floor and outside
    samples = samples[:40]
    cols, rows = 8, math.ceil(len(samples) / 8)
    cw, ch = 56, 56 + 16
    sheet = Image.new("RGB", (cols * cw, rows * ch), (28, 28, 28))
    dr = ImageDraw.Draw(sheet)
    for idx, (lab, im) in enumerate(samples):
        x, y = (idx % cols) * cw, (idx // cols) * ch
        sheet.paste(im, (x, y))
        dr.text((x + 2, y + 58), lab, fill=(240, 240, 240))
    sheet.save(os.path.join(outdir, "preview.png"))
    print("wrote", os.path.join(outdir, "preview.png"), f"({len(samples)} crops)")

def generate(outdir, n):
    floor_dir = os.path.join(outdir, "floor")
    outside_dir = os.path.join(outdir, "outside")
    os.makedirs(floor_dir, exist_ok=True)
    os.makedirs(outside_dir, exist_ok=True)
    import multiprocessing as mp, time
    t0 = time.time()
    fidx = oidx = nf = no = 0
    with mp.Pool(mp.cpu_count()) as pool:
        for k, (fc, oc) in enumerate(pool.imap_unordered(_gen_cells, [(i,) for i in range(n)], chunksize=8)):
            for b in fc:
                open(os.path.join(floor_dir, f"{fidx:06d}.jpg"), "wb").write(b); fidx += 1
            for b in oc:
                open(os.path.join(outside_dir, f"{oidx:06d}.jpg"), "wb").write(b); oidx += 1
            nf += len(fc); no += len(oc)
            if (k + 1) % 200 == 0:
                rate = (nf + no) / max(1e-6, time.time() - t0)
                print(f"{k + 1}/{n} maps  {nf + no} crops  {rate:.0f} crops/s", flush=True)
    print(f"done {n} maps in {time.time() - t0:.0f}s  floor={nf}  outside={no}")

def main():
    args = sys.argv[1:]
    if "--preview" in args:
        args.remove("--preview")
        preview_mode(args[0])
        return
    generate(args[0], int(args[1]))

if __name__ == "__main__":
    random.seed(); np.random.seed()
    main()
