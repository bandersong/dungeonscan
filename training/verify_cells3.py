#!/usr/bin/env python3
"""Aligned-cell read: deskew each real map, lock the grid phase using the classifier's
own confidence, then classify each grid cell and paint the floor mask. This mimics what
the app actually does (grid-aligned cells), unlike the crude phase-0 heatmap."""
import os, glob
import numpy as np
from PIL import Image, ImageDraw
import coremltools as ct
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ml = ct.models.MLModel(os.path.join(ROOT, "training", "CellFloor.mlpackage"))
MAX = 1600
# (cell px @1600, deskew deg to apply)
CFG = {"bro-01": (54, 0), "bro-02": (32, 18), "bro-03": (42, -2), "bro-04": (44, 0), "bro-05": (42, 0)}

def fp(crop):
    p = ml.predict({"image": crop.resize((56, 56))})
    for v in p.values():
        if isinstance(v, dict) and "floor" in v: return float(v["floor"])
    return 0.0

def cells_at(img, cell, ox, oy):
    W, H = img.size; M = round(0.45 * cell); win = cell + 2 * M
    res = []
    for r in range((H - oy) // cell):
        for c in range((W - ox) // cell):
            x, y = ox + c * cell, oy + r * cell
            crop = img.crop((x + cell // 2 - win // 2, y + cell // 2 - win // 2,
                             x + cell // 2 + win // 2, y + cell // 2 + win // 2))
            res.append((x, y, fp(crop)))
    return res

def eval_map(name, cell, deskew):
    f = os.path.join(ROOT, "datasets", "real-maps", name + ".jpg")
    img = Image.open(f).convert("RGB"); s = MAX / max(img.size)
    img = img.resize((round(img.size[0] * s), round(img.size[1] * s)))
    if deskew: img = img.rotate(deskew, resample=Image.BILINEAR, fillcolor=(235, 230, 215), expand=False)
    # phase search: pick (ox,oy) in a coarse grid that maximises confident cells
    best, bestscore = (0, 0), -1
    for ox in range(0, cell, max(4, cell // 4)):
        for oy in range(0, cell, max(4, cell // 4)):
            cs = cells_at(img, cell, ox, oy)
            conf = sum(1 for _, _, p in cs if p > 0.8 or p < 0.2)
            if conf > bestscore: bestscore, best = conf, (ox, oy)
    cs = cells_at(img, cell, best[0], best[1])
    ov = img.convert("RGBA"); dr = ImageDraw.Draw(ov, "RGBA")
    for x, y, p in cs:
        if p > 0.5: dr.rectangle([x, y, x + cell, y + cell], fill=(40, 230, 90, int(140 * p)))
    return ov.convert("RGB")

thumbs = [eval_map(n, c, d).resize((300, 400)) for n, (c, d) in CFG.items()]
sheet = Image.new("RGB", (len(thumbs) * 300, 400), (0, 0, 0))
for i, t in enumerate(thumbs): sheet.paste(t, (i * 300, 0))
out = os.path.join(ROOT, "training", "cells_aligned_eval.png"); sheet.save(out); print("wrote", out)
