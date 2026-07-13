#!/usr/bin/env python3
"""Does the cell classifier TRANSFER to bro's real maps? Slide a cell-window over
each real map, classify floor/outside, and paint the floor-probability heatmap.
If sim2real worked, 'floor' lights up on the rooms (grid squares) and stays dark on
vegetation/blank. Phase-independent (tiled), so it doesn't need a perfect grid.
Run with the export venv (coremltools). Writes training/cells_real_eval.png."""
import os, glob
import numpy as np
from PIL import Image
import coremltools as ct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ml = ct.models.MLModel(os.path.join(ROOT, "training", "CellFloor.mlpackage"))
MAX = 1600
# per-map (cell px @1600 long side) from earlier grid analysis; deskew handled by the
# classifier's rotation-robustness (trained with ±10°), so we tile the raw image.
CELL = {"bro-01": 54, "bro-02": 32, "bro-03": 42, "bro-04": 44, "bro-05": 42}

def floor_prob(crop):
    p = ml.predict({"image": crop.resize((56, 56))})
    # classifier output: a dict of class->prob under some key + a classLabel
    for v in p.values():
        if isinstance(v, dict) and "floor" in v:
            return float(v["floor"])
    return 0.0

def eval_map(f):
    name = os.path.splitext(os.path.basename(f))[0]
    cell = CELL.get(name, 42)
    img = Image.open(f).convert("RGB")
    s = MAX / max(img.size)
    img = img.resize((round(img.size[0] * s), round(img.size[1] * s)))
    W, H = img.size
    M = round(0.45 * cell); win = cell + 2 * M
    overlay = img.convert("RGBA")
    from PIL import ImageDraw
    dr = ImageDraw.Draw(overlay, "RGBA")
    step = cell
    for y in range(0, H - cell, step):
        for x in range(0, W - cell, step):
            crop = img.crop((x + cell // 2 - win // 2, y + cell // 2 - win // 2,
                             x + cell // 2 + win // 2, y + cell // 2 + win // 2))
            pr = floor_prob(crop)
            if pr > 0.5:
                a = int(120 * (pr - 0.5) * 2)
                dr.rectangle([x, y, x + cell, y + cell], fill=(40, 230, 90, a))
    return overlay.convert("RGB")

files = sorted(glob.glob(os.path.join(ROOT, "datasets", "real-maps", "*.jpg")))
thumbs = [eval_map(f).resize((300, 400)) for f in files]
sheet = Image.new("RGB", (len(thumbs) * 300, 400), (0, 0, 0))
for i, t in enumerate(thumbs):
    sheet.paste(t, (i * 300, 0))
out = os.path.join(ROOT, "training", "cells_real_eval.png")
sheet.save(out)
print("wrote", out)
