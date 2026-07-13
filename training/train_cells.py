#!/usr/bin/env python3
"""
Train CellNet: 56x56 RGB cell -> {outside=0, floor=1}. Small (<1M params),
on-device/CoreML sized conv net. Trains on ImageFolder-style cell crops,
evaluates per-epoch val loss + accuracy, and saves the best state_dict.
Exports a Vision CLASSIFIER (.mlpackage) in a separate --export mode.

Run training with the torch+MPS venv, export with the coremltools venv:
  python train_cells.py           # train, save best to training/cellnet.pt
  python train_cells.py --export  # load cellnet.pt, write training/CellFloor.mlpackage
"""
import os, sys, glob, time
import numpy as np
from PIL import Image
import torch, torch.nn as nn
from torch.utils.data import Dataset, DataLoader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CELLS = "/Volumes/2TB/DungeonScan/cells"
CKPT = os.path.join(ROOT, "training", "cellnet.pt")
MLMODEL = os.path.join(ROOT, "training", "CellFloor.mlpackage")
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
RES = 56
EPOCHS = 16

# ImageFolder-style: <split>/<class>/*.jpg ; class index fixed so it matches the
# CoreML classifier labels below (outside=0, floor=1).
CLASSES = [("outside", 0), ("floor", 1)]

class CellDS(Dataset):
    def __init__(self, d):
        self.files, self.labels = [], []
        for cls, lab in CLASSES:
            fs = sorted(glob.glob(os.path.join(d, cls, "*.jpg")))
            self.files += fs; self.labels += [lab] * len(fs)
    def __len__(self): return len(self.files)
    def __getitem__(self, i):
        img = Image.open(self.files[i]).convert("RGB")
        x = torch.from_numpy(np.asarray(img, np.float32) / 255.).permute(2, 0, 1)
        return x, self.labels[i]

def conv(i, o, s=2):
    return nn.Sequential(nn.Conv2d(i, o, 3, s, 1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True))

class CellNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(
            conv(3, 32), conv(32, 64), conv(64, 96), conv(96, 128),  # 56->28->14->7->4
            nn.AdaptiveAvgPool2d(1), nn.Flatten())
        self.head = nn.Sequential(nn.Dropout(0.1), nn.Linear(128, 2))
    def forward(self, x):
        return self.head(self.body(x))  # raw logits

def train():
    tr = DataLoader(CellDS(f"{CELLS}/train"), batch_size=128, shuffle=True, num_workers=8, drop_last=True, persistent_workers=True)
    va = DataLoader(CellDS(f"{CELLS}/val"), batch_size=128, num_workers=8, persistent_workers=True)
    net = CellNet().to(DEV)
    opt = torch.optim.AdamW(net.parameters(), 1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    lossf = nn.CrossEntropyLoss()
    best = 0.0
    print(f"device={DEV} train={len(tr.dataset)} val={len(va.dataset)}")
    for ep in range(EPOCHS):
        net.train(); t0 = time.time()
        for x, y in tr:
            x, y = x.to(DEV), y.to(DEV)
            opt.zero_grad(); l = lossf(net(x), y); l.backward(); opt.step()
        sched.step()
        net.eval(); vs = n = nc = 0
        with torch.no_grad():
            for x, y in va:
                x, y = x.to(DEV), y.to(DEV); p = net(x)
                vs += lossf(p, y).item() * len(x); n += len(x)
                nc += (p.argmax(1) == y).sum().item()
        acc = 100 * nc / n
        print(f"ep{ep} val_loss={vs/n:.4f} val_acc={acc:.2f}% lr={sched.get_last_lr()[0]:.1e} {time.time()-t0:.0f}s", flush=True)
        if acc > best:
            best = acc; torch.save(net.state_dict(), CKPT); print("  saved", flush=True)
    print(f"best val_acc={best:.2f}%")

def export():
    import coremltools as ct  # lives in the export venv; keep out of the train path
    # Trace on CPU for a clean, device-agnostic export: CellNet logits -> softmax probs.
    net = CellNet().eval(); net.load_state_dict(torch.load(CKPT, map_location="cpu"))
    model = nn.Sequential(net, nn.Softmax(dim=1)).eval()
    ex = torch.randn(1, 3, RES, RES)
    traced = torch.jit.trace(model, ex)
    mlmodel = ct.convert(
        traced,
        inputs=[ct.ImageType(name="image", shape=(1, 3, RES, RES), scale=1/255.0, bias=[0, 0, 0], color_layout=ct.colorlayout.RGB)],
        classifier_config=ct.ClassifierConfig(["outside", "floor"]),
        minimum_deployment_target=ct.target.macOS14,
        compute_units=ct.ComputeUnit.ALL)
    mlmodel.short_description = "Cell classifier: outside vs floor (56x56 RGB)"
    mlmodel.save(MLMODEL); print("wrote", MLMODEL)

if __name__ == "__main__":
    if "--export" in sys.argv: export()
    else: train()
