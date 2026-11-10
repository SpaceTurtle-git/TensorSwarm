# title: CPU Swarm: Parallel Hyperparameter Search
# description: Uses the CPU cores of EVERY PC in the swarm (PCs without a GPU too): ts.map() trains 12 small models with different settings in parallel, each loading the dataset on whichever PC it lands on.
# category: Training
# runtime: ~40 s
# gpu: optional

# %% [markdown]
# # The swarm's CPUs
# GPUs are not the only compute in a lab: every PC also has 4–16 CPU cores. **`ts.map(fn, items)`**
# runs `fn(item)` for every item in parallel on the free cores of all PCs and returns the
# results in order, like Python's `map`.
#
# | Call | What it does |
# | :--- | :--- |
# | `ts.cluster()` | Cores and GPUs per PC, and how many are free |
# | `ts.map(fn, items, num_cpus=1)` | Parallel `fn(item)` on any PC with a free core |
# | `ts.map(fn, items, num_gpus=0.5)` | The same on GPUs (each call reserves a GPU share) |
#
# Good fits: hyperparameter searches, cross-validation folds, data preprocessing, simulations.
# Each call should take at least a few seconds, so the network overhead doesn't dominate.

# %%
c = ts.cluster()
print(f"{len(c['pcs'])} PC(s), {c['cpus_free']:g} of {c['cpus_total']:g} CPU cores free, {c['gpus_total']:g} GPU(s)\n")
for pc in c["pcs"]:
    print(f"  {pc['hostname']:<22} {pc['ip']:<16} {pc['cpus']:>4g} cores  {pc['gpus']:g} GPU")

# %% [markdown]
# ## A dataset every task can load
# The same 3-class spirals dataset as the *Train on a Dataset* sample. Each task calls
# `ts.dataset(...)` on its own PC: the first task on a PC copies it from the Master, the
# others reuse that copy.

# %%
import csv, math, os, random, tempfile

DATASET = "demo-spirals"

def make_spirals(folder, n_per_class=1500, classes=3, seed=0):
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
    print(f"Dataset '{DATASET}' is on the Master.")
except ts.DatasetError:
    tmp = tempfile.mkdtemp(prefix="ts-demo-")
    make_spirals(tmp)
    ts.upload(tmp, DATASET, description="3-class spirals (x, y, label), 3,600 train / 900 test rows")

# %% [markdown]
# ## One training run = one function call
# Everything the function needs is imported **inside** it: it runs in a fresh Python process
# on another PC.

# %%
def train_one(cfg):
    import socket, time
    import numpy as np
    import torch
    from torch import nn

    root = ts.dataset(DATASET, verbose=False)
    def load(split):
        a = np.loadtxt(root / f"{split}.csv", delimiter=",", skiprows=1, dtype=np.float32)
        return torch.from_numpy(a[:, :2]), torch.from_numpy(a[:, 2]).long()
    xtr, ytr = load("train")
    xte, yte = load("test")

    torch.manual_seed(cfg["seed"])
    layers, d = [], 2
    for _ in range(cfg["depth"]):
        layers += [nn.Linear(d, cfg["width"]), nn.ReLU()]
        d = cfg["width"]
    model = nn.Sequential(*layers, nn.Linear(d, 3))
    opt = torch.optim.AdamW(model.parameters(), lr=cfg["lr"])
    t0 = time.time()
    for epoch in range(cfg["epochs"]):
        perm = torch.randperm(len(xtr))
        for i in range(0, len(xtr), 128):
            idx = perm[i:i + 128]
            opt.zero_grad()
            nn.functional.cross_entropy(model(xtr[idx]), ytr[idx]).backward()
            opt.step()
    with torch.no_grad():
        acc = (model(xte).argmax(1) == yte).float().mean().item()
    return {**cfg, "test_acc": round(acc, 4), "seconds": round(time.time() - t0, 1), "pc": socket.gethostname()}

configs = [{"width": w, "depth": d, "lr": lr, "epochs": 30, "seed": 0}
           for w in (32, 128) for d in (1, 2, 3) for lr in (1e-3, 5e-3)]
print(f"{len(configs)} configurations")

# %%
results = ts.map(train_one, configs, num_cpus=1)

print(f"\n{'width':>5} {'depth':>5} {'lr':>7} {'test acc':>9} {'time':>6}  PC")
for r in sorted(results, key=lambda r: -r["test_acc"]):
    print(f"{r['width']:>5} {r['depth']:>5} {r['lr']:>7g} {r['test_acc']:>9.1%} {r['seconds']:>5.1f}s  {r['pc']}")

best = max(results, key=lambda r: r["test_acc"])
result = {"best": {k: best[k] for k in ("width", "depth", "lr", "test_acc")},
          "pcs_used": sorted({r["pc"] for r in results}), "runs": len(results)}
result
