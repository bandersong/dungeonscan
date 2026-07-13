#!/usr/bin/env python3
"""Show real crops WITH their predicted floor-prob, so we can see if the classifier
is sensible on real cells (vs my crude heatmap). Grid of crops from bro-03/bro-04."""
import os, glob
import numpy as np
from PIL import Image, ImageDraw
import coremltools as ct
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ml = ct.models.MLModel(os.path.join(ROOT, "training", "CellFloor.mlpackage"))
MAX = 1600
def fp(crop):
    p = ml.predict({"image": crop.resize((56, 56))})
    for v in p.values():
        if isinstance(v, dict) and "floor" in v: return float(v["floor"])
    return -1.0
sheet = Image.new("RGB", (7 * 84, 2 * 100), (20, 20, 20))
dr = ImageDraw.Draw(sheet)
row = 0
for name, cell in [("bro-03", 42), ("bro-04", 44)]:
    f = os.path.join(ROOT, "datasets", "real-maps", name + ".jpg")
    img = Image.open(f).convert("RGB"); s = MAX / max(img.size)
    img = img.resize((round(img.size[0] * s), round(img.size[1] * s)))
    W, H = img.size; win = round(1.9 * cell)
    # 7 windows spread across a horizontal band through the middle
    ys = H // 2
    for i in range(7):
        cx = int(W * (i + 0.5) / 7)
        crop = img.crop((cx - win // 2, ys - win // 2, cx + win // 2, ys + win // 2))
        pr = fp(crop)
        th = crop.resize((80, 80))
        sheet.paste(th, (i * 84 + 2, row * 100 + 2))
        dr.text((i * 84 + 4, row * 100 + 84), f"{name[-1]} {pr:.2f}", fill=(90, 240, 120) if pr > 0.5 else (240, 140, 90))
    row += 1
out = os.path.join(ROOT, "training", "cells_real_probe.png"); sheet.save(out); print("wrote", out)
