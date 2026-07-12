#!/usr/bin/env python3
"""
Convert the trained GridNet (training/gridnet.pt) to a CoreML .mlpackage for
on-device inference in the app. Input: a 320x320 RGB image (CoreML handles the
pixel-buffer → tensor conversion + /255 scaling). Output: 9 floats — 4 grid
corners (TL,TR,BR,BL, normalized 0..1) then cell size / max(image side).

Run with the export venv (has coremltools):
  /Volumes/2TB/DungeonScan/export-venv/bin/python training/export_coreml.py
"""
import os, torch, coremltools as ct
from train import GridNet, RES, CKPT, ROOT

net = GridNet()
net.load_state_dict(torch.load(CKPT, map_location="cpu"))
net.eval()

example = torch.rand(1, 3, RES, RES)
traced = torch.jit.trace(net, example)

mlmodel = ct.convert(
    traced,
    inputs=[ct.ImageType(name="image", shape=(1, 3, RES, RES),
                         scale=1 / 255.0, bias=[0, 0, 0],
                         color_layout=ct.colorlayout.RGB)],
    outputs=[ct.TensorType(name="grid")],
    minimum_deployment_target=ct.target.macOS14,
    compute_units=ct.ComputeUnit.ALL,
)
mlmodel.short_description = "DungeonScan GridNet: image -> 4 grid corners + cell size"
mlmodel.input_description["image"] = "320x320 RGB photo of a hand-drawn grid map"
mlmodel.output_description["grid"] = "8 corner coords (TL,TR,BR,BL normalized) + cell/maxdim"

out = os.path.join(ROOT, "training", "GridNet.mlpackage")
mlmodel.save(out)
print("saved", out)
