#!/usr/bin/env python3
"""
Train GridNet: image -> 4 grid corners (TL,TR,BR,BL, normalized) + cell size.
The corners fix rotation+perspective in one shot; the cell size resolves the
octave ambiguity that pixel heuristics can't (e.g. a bold background grid at half
the true pitch). Trains on the synthetic set, evaluates on bro's 5 real maps by
overlaying predictions. Runs on the M2 Max via MPS.

Usage:
  python train.py           # train, save best to training/gridnet.pt
  python train.py --eval     # load gridnet.pt, render predictions on real maps
"""
import os, sys, json, glob, time
import numpy as np
from PIL import Image, ImageDraw
import torch, torch.nn as nn
from torch.utils.data import Dataset, DataLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNTH = "/Volumes/2TB/DungeonScan/synth"
CKPT = os.path.join(ROOT, "training", "gridnet.pt")
REAL = os.path.join(ROOT, "datasets", "real-maps")
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
RES = 320
EPOCHS = 24

def load_target(j):
    W, H = j["_wh"]
    m = max(W, H)
    cs = j["corners"]
    t = [v for (cx, cy) in cs for v in (cx / W, cy / H)]
    t.append(j["cell"] / m)
    return np.array(t, np.float32)

class DS(Dataset):
    def __init__(self, d):
        self.files = sorted(glob.glob(os.path.join(d, "*.json")))
    def __len__(self): return len(self.files)
    def __getitem__(self, i):
        j = json.load(open(self.files[i]))
        img = Image.open(self.files[i][:-5] + ".jpg").convert("RGB")
        j["_wh"] = img.size
        x = torch.from_numpy(np.asarray(img.resize((RES, RES), Image.BILINEAR), np.float32) / 255.).permute(2, 0, 1)
        return x, torch.from_numpy(load_target(j))

def conv(i, o, s=2):
    return nn.Sequential(nn.Conv2d(i, o, 3, s, 1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True))

class GridNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(
            conv(3, 32), conv(32, 64), conv(64, 96), conv(96, 128), conv(128, 192),  # 320->10
            nn.AdaptiveAvgPool2d(1), nn.Flatten())
        self.head = nn.Sequential(nn.Linear(192, 128), nn.ReLU(inplace=True), nn.Dropout(0.1), nn.Linear(128, 9))
    def forward(self, x):
        return torch.sigmoid(self.head(self.body(x)))

def train():
    tr = DataLoader(DS(f"{SYNTH}/train"), batch_size=64, shuffle=True, num_workers=8, drop_last=True, persistent_workers=True)
    va = DataLoader(DS(f"{SYNTH}/val"), batch_size=64, num_workers=4, persistent_workers=True)
    net = GridNet().to(DEV)
    opt = torch.optim.AdamW(net.parameters(), 1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    lossf = nn.SmoothL1Loss()
    best = 1e9
    print(f"device={DEV} train={len(tr.dataset)} val={len(va.dataset)}")
    for ep in range(EPOCHS):
        net.train(); t0 = time.time()
        for x, t in tr:
            x, t = x.to(DEV), t.to(DEV)
            opt.zero_grad(); l = lossf(net(x), t); l.backward(); opt.step()
        sched.step()
        net.eval(); vs = n = cpx = 0
        with torch.no_grad():
            for x, t in va:
                x, t = x.to(DEV), t.to(DEV); p = net(x)
                vs += lossf(p, t).item() * len(x); n += len(x)
                # mean corner error in normalized units -> approx % of image
                cpx += (p[:, :8] - t[:, :8]).abs().mean().item() * len(x)
        print(f"ep{ep} val={vs/n:.5f} corner_err={100*cpx/n:.2f}% lr={sched.get_last_lr()[0]:.1e} {time.time()-t0:.0f}s", flush=True)
        if vs / n < best:
            best = vs / n; torch.save(net.state_dict(), CKPT); print("  saved", flush=True)
    print("best val", best)

def eval_real():
    net = GridNet().to(DEV); net.load_state_dict(torch.load(CKPT, map_location=DEV)); net.eval()
    files = sorted(glob.glob(os.path.join(REAL, "*.jpg")))
    sheet = Image.new("RGB", (len(files) * 320, 430), (0, 0, 0))
    for i, f in enumerate(files):
        img = Image.open(f).convert("RGB"); W, H = img.size
        x = torch.from_numpy(np.asarray(img.resize((RES, RES), Image.BILINEAR), np.float32) / 255.).permute(2, 0, 1)[None].to(DEV)
        with torch.no_grad(): p = net(x)[0].cpu().numpy()
        corners = [(p[k * 2] * W, p[k * 2 + 1] * H) for k in range(4)]
        cell = p[8] * max(W, H)
        th = img.resize((320, 400)); dr = ImageDraw.Draw(th)
        sx, sy = 320 / W, 400 / H
        q = [(x * sx, y * sy) for x, y in corners]
        dr.line(q + [q[0]], fill=(60, 230, 90), width=3)
        for pt in q: dr.ellipse([pt[0] - 4, pt[1] - 4, pt[0] + 4, pt[1] + 4], fill=(255, 210, 0))
        dr.text((6, 404), f"{os.path.basename(f)} cell~{cell:.0f}px", fill=(255, 255, 255))
        sheet.paste(th, (i * 320, 0))
    out = os.path.join(ROOT, "training", "real_eval.png"); sheet.save(out); print("wrote", out)

if __name__ == "__main__":
    if "--eval" in sys.argv: eval_real()
    else: train()
