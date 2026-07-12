#!/usr/bin/env python3
"""Sanity-check the CoreML export: its outputs must match the torch model on a
real map (catches color-order / normalization / scaling export bugs). Run with
the export venv."""
import sys, os, glob
import numpy as np
from PIL import Image
import torch, coremltools as ct
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from train import GridNet, RES, CKPT, ROOT

net = GridNet(); net.load_state_dict(torch.load(CKPT, map_location="cpu")); net.eval()
ml = ct.models.MLModel(os.path.join(ROOT, "training", "GridNet.mlpackage"))

for f in sorted(glob.glob(os.path.join(ROOT, "datasets", "real-maps", "*.jpg")))[:3]:
    img = Image.open(f).convert("RGB").resize((RES, RES))
    x = torch.from_numpy(np.asarray(img, np.float32) / 255.).permute(2, 0, 1)[None]
    with torch.no_grad():
        tp = net(x)[0].numpy()
    cp = np.array(ml.predict({"image": img})["grid"]).flatten()
    print(os.path.basename(f), "maxdiff=%.4f" % np.abs(tp - cp).max(),
          "torch=", np.round(tp[:4], 3), "coreml=", np.round(cp[:4], 3))
