# title: Train on a Dataset
# description: The full data path: publish a CSV dataset to the Master, load it on the worker with ts.dataset(), train a PyTorch model, and publish the checkpoint back as a new dataset.
# category: Training
# runtime: ~30 s
# gpu: optional

# %% [markdown]
# # Training on a dataset
# Inside every notebook and job, **`ts`** (the TensorSwarm data client) is already imported.
#
# | Call | What it does on the worker |
# | :--- | :--- |
# | `ts.dataset("name")` | Local folder with the dataset; copied from the Master **once**, then cached on this PC |
# | `ts.upload(path, "name")` | Publishes a file or folder to the Master as a new dataset version |
# | `ts.download(url)` / `ts.hf_download(repo, file)` | Cached internet download on this worker |
#
# This sample creates a small CSV dataset if it doesn't exist yet, so it runs anywhere.
# For your own data, use the **Datasets** tab to upload it, then replace the name below.

# %%
import csv
import math
import os
import random
import tempfile
import time

DATASET = "demo-spirals"

def make_spirals(folder, n_per_class=1500, classes=3, seed=0):
    """Three interleaved spirals: not linearly separable, so a real network is needed."""
    rnd = random.Random(seed)
    rows = []
    for c in range(classes):
        for i in range(n_per_class):
            r = i / n_per_class * 5
            t = c * 2 * math.pi / classes + r * 1.4 + rnd.gauss(0, 0.18)
            rows.append((r * math.cos(t), r * math.sin(t), c))
    rnd.shuffle(rows)
    cut = int(len(rows) * 0.8)
    for fname, part in (("train.csv", rows[:cut]), ("test.csv", rows[cut:])):
        with open(os.path.join(folder, fname), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["x", "y", "label"])
            w.writerows(part)

try:
    ts.manifest(DATASET)
    print(f"Dataset '{DATASET}' already on the Master.")
except ts.DatasetError:
    print(f"Dataset '{DATASET}' not found: creating and publishing it ...")
    tmp = tempfile.mkdtemp(prefix="ts-demo-")
    make_spirals(tmp)
    ts.upload(tmp, DATASET, description="3-class spirals (x, y, label), 3,600 train / 900 test rows")

# %% [markdown]
# ## Load it on this worker
# `ts.dataset()` returns a normal folder (a `pathlib.Path`). The first call on a PC copies
# the data from the Master (resumable, verified); later calls are instant. On the Master PC,
# or when the dataset was put on the USB stick, nothing is copied at all.

# %%
import numpy as np
import torch

root = ts.dataset(DATASET)
print("dataset folder on this worker:", root)
print("files:", sorted(p.name for p in root.iterdir()))

def load(split):
    arr = np.loadtxt(root / f"{split}.csv", delimiter=",", skiprows=1, dtype=np.float32)
    return torch.from_numpy(arr[:, :2]), torch.from_numpy(arr[:, 2]).long()

x_train, y_train = load("train")
x_test, y_test = load("test")
print(f"train {tuple(x_train.shape)}, test {tuple(x_test.shape)}, classes {int(y_train.max()) + 1}")

# %%
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

device = "cuda" if torch.cuda.is_available() else "cpu"
torch.manual_seed(0)

# num_workers=0: on Windows, DataLoader worker processes can't re-import code sent as a string.
loader = DataLoader(TensorDataset(x_train, y_train), batch_size=128, shuffle=True,
                    num_workers=0, pin_memory=(device == "cuda"))
model = nn.Sequential(nn.Linear(2, 128), nn.ReLU(), nn.Linear(128, 128), nn.ReLU(), nn.Linear(128, 3)).to(device)
opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
loss_fn = nn.CrossEntropyLoss()

t0 = time.time()
for epoch in range(1, 41):
    model.train()
    total = 0.0
    for xb, yb in loader:
        xb, yb = xb.to(device, non_blocking=True), yb.to(device, non_blocking=True)
        opt.zero_grad(set_to_none=True)
        loss = loss_fn(model(xb), yb)
        loss.backward()
        opt.step()
        total += loss.item() * len(xb)
    if epoch % 10 == 0:
        print(f"epoch {epoch:2d}  loss {total / len(x_train):.4f}")

model.eval()
with torch.no_grad():
    acc = (model(x_test.to(device)).argmax(1).cpu() == y_test).float().mean().item()
print(f"test accuracy {acc:.1%} on {device} ({torch.cuda.get_device_name(0) if device == 'cuda' else 'CPU'}) "
      f"in {time.time() - t0:.1f} s")

# %% [markdown]
# ## Publish the trained model
# Outputs written on a worker stay on that PC. `ts.upload()` sends them to the Master, so
# another notebook (on any PC) can load them with `ts.dataset("demo-spirals-model")`.

# %%
out = tempfile.mkdtemp(prefix="ts-model-")
torch.save({"state_dict": model.state_dict(), "test_accuracy": acc}, os.path.join(out, "model.pt"))
published = ts.upload(out, f"{DATASET}-model", description=f"MLP on {DATASET}, test accuracy {acc:.1%}")

result = {"dataset": ts.manifest(DATASET)["id"], "test_accuracy": round(acc, 4), "device": device,
          "model": published["id"]}
result
