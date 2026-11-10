# ⚡ TensorSwarm

**Pool the NVIDIA GPUs of several ordinary PCs into one private, Colab-style GPU cluster.**

TensorSwarm connects laptops and lab PCs over [Tailscale](https://tailscale.com), even across different networks, NATs and mobile hotspots, and schedules Python and PyTorch work on their GPUs with [Ray](https://www.ray.io/). You write code in a browser notebook or submit scripts as jobs, and they run on whichever PC has a free GPU, or on one you pick.

- **Zero-install on Windows lab PCs:** a portable Python with PyTorch, CUDA and Ray is installed from **one USB stick** in about 3 minutes per PC. No admin rights, Docker, WSL or internet needed on the lab network. Only Tailscale.
- **Use it from any PC:** the dashboard is served by the Master at `http://<MASTER_IP>:8000`, so every PC in the swarm (and any laptop on the tailnet) can open it in a browser, write notebooks and send jobs. Not just the Master. No Node.js needed; every PC gets a **TensorSwarm Dashboard** shortcut.
- **Colab-style notebook:** persistent variables, `!nvidia-smi` / `!pip`, live output, images, interrupt and restart, variable inspector, `.ipynb` import and export.
- **Datasets for training:** upload files or folders in the browser (resumable, any size), import from a URL or Hugging Face, or ship big ones on the USB stick. In code, `ts.dataset("name")` gives the local folder on whichever worker runs it: copied once, verified, cached.
- **CPUs too, not just GPUs:** run notebooks and jobs **CPU only** on any PC (PCs without a GPU included) with as many cores as you pick, or spread work over the cores of **every** PC at once with `ts.map(fn, items)`.
- **Detailed GPU telemetry:** load, VRAM, temperature, power, clocks, PCIe link, throttle reasons, processes and 30 minutes of history per GPU.
- **Built-in test suite:** sample scripts to benchmark and validate every worker (TFLOPS, bandwidth, VRAM, stress, training).
- **Linux too:** Linux nodes can run in Docker with the scripts in `master/` and `worker/`.

---

## Contents

1. [How it works](#-how-it-works)
2. [What you need](#-what-you-need)
3. [Quick start (Windows)](#-quick-start-windows)
4. [Step by step](#-step-by-step)
   - [A. Build the environment (once, at home)](#a-build-the-environment-once-at-home)
   - [B. Write the USB stick](#b-write-the-usb-stick)
   - [C. Install on a PC](#c-install-on-a-pc)
   - [D. Start the swarm](#d-start-the-swarm)
   - [E. Open the dashboard](#e-open-the-dashboard)
   - [F. Stop](#f-stop)
   - [G. Update the code later](#g-update-the-code-later)
5. [Common setups](#-common-setups)
6. [Lab day checklist](#-lab-day-checklist)
7. [Using TensorSwarm](#-using-tensorswarm)
8. [FAQ](#-faq)
9. [Troubleshooting](#-troubleshooting)
10. [Linux / Docker nodes](#-linux--docker-nodes)
11. [Reference](#-reference): ports, folders, API, repository structure
12. [Security](#-security)
13. [Limitations and tips](#-limitations-and-tips)
14. [Developing TensorSwarm](#-developing-tensorswarm)

---

## 🧠 How it works

```
                       Tailscale mesh VPN (encrypted, 100.x.y.z addresses)
  ┌─────────────────────────────────┐          ┌──────────────────────────────┐
  │ MASTER PC                       │          │ WORKER PC (one per GPU PC)   │
  │  • Ray head: scheduler, 0 GPUs  │◄────────►│  • Ray worker: offers GPU    │
  │  • FastAPI  :8000               │          │  • Telemetry agent: GPU stats│
  │     - REST API                  │◄─────────│    every 5 s to the Master   │
  │     - Dashboard (web UI)        │          └──────────────────────────────┘
  │  • Local worker (its own GPU)   │          ┌──────────────────────────────┐
  └───────────────▲─────────────────┘          │ WORKER PC ...                │
                  │ browser                    └──────────────────────────────┘
       any PC: http://<MASTER_IP>:8000
```

| Piece | Runs on | What it does |
| :--- | :--- | :--- |
| **Ray head** | Master | The scheduler. It claims **0 GPUs**, so the Master is a pure orchestrator. |
| **FastAPI server** (`master/server.py`) | Master | Receives telemetry, runs jobs and notebook runtimes through Ray, and **serves the dashboard** on the same port 8000. |
| **Local worker** | Master (optional) | A normal Ray worker on the Master PC that offers its GPU, like any other worker. Started automatically; skip it with `-NoLocalWorker`. |
| **Ray worker** | Every GPU PC | Joins the Master's Ray cluster and offers this PC's GPU(s). |
| **Telemetry agent** (`agent.py`) | Every PC | Reads the GPU through NVML and posts a heartbeat to the Master every 5 s. |
| **Dashboard** (`frontend/`) | Any browser | Next.js app, pre-built into static files (`master/dashboard/`) that the Master serves. |

**How your code reaches a GPU:** browser → `POST /api/v1/...` on the Master → Ray schedules a task or actor on a worker with a free GPU share → the code runs on that PC's GPU → the output streams back to your browser.

**How the software gets onto the lab PCs:** you have **one** USB stick, so it's used as an **installer**, not as the place TensorSwarm runs from:

```
 your PC (once)                       USB stick                    each PC
 build_usb_env.cmd  ─►  prepare_usb.cmd  ─►  E:\TensorSwarm\  ─►  install.cmd  ─►  C:\TensorSwarm\
 python_env\ (~5 GB,     packs it into ONE     code + 2.5 GB        ~3 min           runs from the
 31,000+ files)          archive (cached)      archive                               local disk
```

Copying 31,000 small files to a USB takes 10+ minutes. One archive copies at full speed. Every PC also ends up with a **byte-identical** environment, which Ray requires: all nodes must run the exact same Python and Ray versions.

---

## 🛠️ What you need

| Where | Needs | Notes |
| :--- | :--- | :--- |
| **Every PC** | Windows 10/11, an NVIDIA driver, **Tailscale** signed in to the same account | A PC without an NVIDIA GPU can still be the Master. |
| **Your build PC** (once) | Good internet, ~12 GB free disk | Builds the environment and writes the stick. |
| **USB stick** | ≥ 4 GB free, any format (NTFS, exFAT, or FAT32) | The archive is ~2.5 GB, under FAT32's 4 GB file limit. |
| **Node.js 18+** | **Only** on the PC where you *change* the frontend | Not needed to use the dashboard: the Master serves a pre-built copy. |

**NVIDIA driver versions:** the default build (CUDA 12.1) needs driver **≥ 527.41**. For older locked-down lab drivers, build with `-Cuda cu118` (needs ≥ 452.39). Check a PC's driver with `nvidia-smi`.

---

## ⚡ Quick start (Windows)

**At home:**
```powershell
git clone https://github.com/<you>/TensorSwarm.git
cd TensorSwarm
.\build_usb_env.cmd      # once: builds the portable Python (30–60 min, needs internet)
.\prepare_usb.cmd        # writes the USB installer (~15 min the first time, seconds afterwards)
```

**On every PC, Master first:** install Tailscale, then double-click **`E:\TensorSwarm\install.cmd`**, click **Yes** on the admin prompt, wait for *"You can unplug the USB stick now"*, and move to the next PC.

**Run:**

| PC | Double-click | Then |
| :--- | :--- | :--- |
| Master | **TensorSwarm Master** (Desktop) | Note the IP it prints, e.g. `100.101.102.103`. |
| Every other PC | **TensorSwarm Worker** (Desktop) | Type the Master's IP and press Enter. |
| **Any** PC (Master, worker, or a laptop) | **TensorSwarm Dashboard** (Desktop), or open **`http://<MASTER_IP>:8000`** in a browser | Cluster, Notebook, Jobs & Samples. Everyone can write and send code. |

**Stop:** the **TensorSwarm Stop** shortcut on each PC.

---

## 📋 Step by step

### A. Build the environment (once, at home)

Run this in the project folder **on your own disk**, not on the stick, because it's much faster:

```powershell
.\build_usb_env.cmd                    # default: CPython 3.10.15 + torch 2.5.1 (CUDA 12.1)
.\build_usb_env.cmd -Cuda cu118        # for lab PCs with NVIDIA drivers older than 527.41
.\build_usb_env.cmd -Cuda cpu          # CPU-only build (smaller)
```

What it does:
1. Downloads a relocatable CPython 3.10 ([python-build-standalone](https://github.com/astral-sh/python-build-standalone)) into `python_env\`. No virtualenv: a venv hard-codes its drive letter and breaks when the stick becomes `F:` on another PC.
2. **Download phase (online):** fetches every wheel into `wheelhouse\` with long timeouts and automatic retries. A dropped connection only costs the file in progress.
3. **Install phase (offline):** installs from `wheelhouse\` into `python_env\`.
4. Runs `scripts\verify_env.py` and records the versions in `python_env\tensorswarm_env.json`.

> It can look frozen for several minutes while pip checks the 2.5 GB torch wheel. That's normal; leave it running.

Check the build at any time with `python_env\python.exe scripts\verify_env.py`. You should see `RESULT: OK`.

### B. Write the USB stick

Plug in the stick, then:

```powershell
.\prepare_usb.cmd               # finds the stick by itself (asks if there are several)
.\prepare_usb.cmd -Drive F      # or name the drive
.\prepare_usb.cmd -CodeOnly     # after changing only code: refreshes the stick in seconds
.\prepare_usb.cmd -Repack       # force a fresh archive
```

What it does:
1. Checks the environment: the imports work and `ray start` actually runs.
2. Packs `python_env\` into **`dist\python_env.tar.gz`** (~2.5 GB, ~10 min). The archive is **cached** and repacked only when the installed packages change, and verified by file count.
3. **Rebuilds the dashboard** into `master\dashboard\` if the frontend source changed and Node.js is available. Otherwise it ships the existing build.
4. Copies the code and the archive to `E:\TensorSwarm\`. Only changed files are copied.

### C. Install on a PC

1. Install **Tailscale** from <https://tailscale.com/download/windows> and sign in with the swarm's account. Wait until the tray icon says **Connected**.
2. Double-click **`E:\TensorSwarm\install.cmd`**.
3. Click **Yes** on the Administrator prompt. This creates the firewall rules **once**, so the other PCs can connect to this one. They allow only Tailscale addresses (`100.64.0.0/10`).
   - No admin rights? Click **No**. The install still works, but you must click **Allow access** on the Windows firewall popups for `python.exe`, `raylet.exe` and `gcs_server.exe`. **The Master PC really needs the firewall rules.**
4. Wait for *"TensorSwarm installed"* (~3 min). Then unplug the stick.

Result: `C:\TensorSwarm\` plus four Desktop shortcuts: **TensorSwarm Master**, **TensorSwarm Worker**, **TensorSwarm Dashboard** and **TensorSwarm Stop**.

Options:
- `install.cmd -Destination D:\TensorSwarm`: for lab PCs that wipe `C:` on reboot (Deep Freeze).
- `install.cmd -Force`: re-unpack the environment even when it's up to date.

Running `install.cmd` again is safe. It updates the code and skips the 3-minute unpack when the environment hasn't changed.

### D. Start the swarm

**1. Master PC first.** Double-click **TensorSwarm Master**, or run:
```powershell
C:\TensorSwarm\master\start_master.cmd                 # orchestrator + this PC's GPU as a worker
C:\TensorSwarm\master\start_master.cmd -NoLocalWorker  # orchestrator only (e.g. a laptop without a GPU)
```
Wait for **"TensorSwarm Master is UP"**. It prints:
- the Tailscale IP of the Master: give this to the workers;
- **Dashboard:** `http://<MASTER_IP>:8000`;
- the Ray dashboard: `http://<MASTER_IP>:8265`.

**2. Every other PC.** Double-click **TensorSwarm Worker**, type the Master's IP and press Enter. Next time, Enter alone reuses the last IP. Or run:
```powershell
C:\TensorSwarm\worker\start_worker.cmd 100.101.102.103
```
Wait for **"TensorSwarm Worker is UP and connected"**.

> Closing a TensorSwarm window or pressing **Ctrl+C** only stops the **log display**. The services keep running in the background until you use **TensorSwarm Stop**.

### E. Open the dashboard

The dashboard is **not** tied to the Master PC. From **any** PC on the tailnet (the Master, any worker, or your own laptop), double-click **TensorSwarm Dashboard**, or open:

```
http://<MASTER_IP>:8000
```

The shortcut (`C:\TensorSwarm\open_dashboard.cmd`) picks the address by itself: `localhost` on the Master, the last Master IP on a worker, or it asks. `open_dashboard.cmd 100.101.102.103` opens a specific Master.

Every user sees the same cluster and can run notebooks and jobs **at the same time**; Ray hands each one a free GPU. Each browser keeps its own notebooks. A PC that has no TensorSwarm install (e.g. a teammate's laptop) only needs Tailscale and a browser.

### F. Stop

Double-click **TensorSwarm Stop** on each PC, or run `C:\TensorSwarm\stop_tensorswarm.cmd`.
- It only stops processes started from `C:\TensorSwarm\python_env\`. The PC's own Python, Jupyter or Anaconda are never touched.
- `stop_tensorswarm.cmd -WhatIf` lists what it would stop.
- Stopping the Master disconnects every worker. Stopping a worker only removes that PC's GPU.

### G. Update the code later

At home, after editing code:
```powershell
.\prepare_usb.cmd -CodeOnly    # seconds; rebuilds the dashboard too if you changed the frontend
```
Then run `E:\TensorSwarm\install.cmd` on each PC. That also takes seconds, because the environment is unchanged. Restart the Master and the workers afterwards.

If you changed **Python packages** (e.g. `pip install` into `python_env`), run `prepare_usb.cmd` **without** `-CodeOnly`, then `install.cmd` everywhere. Every node must have the new environment, or Ray will refuse to connect them.

---

## 🧩 Common setups

### 1. Test everything on one PC (home)
One PC can be both Master and worker. **TensorSwarm Master** starts the GPU-less Ray head **and** a local worker for its GPU, on separate ports.
1. Run `.\prepare_usb.cmd`, then `E:\TensorSwarm\install.cmd`, clicking **Yes**.
2. Double-click **TensorSwarm Master**.
3. Open `http://localhost:8000`. **Cluster** shows your GPU. In **Notebook**, choose *Samples → Notebook Tour → Run all*.
4. Optional: the Ray dashboard at `http://<your-ip>:8265` shows **2 nodes, 1 GPU**: the head and the local worker.

### 2. Laptop without a GPU as the Master, GPU PC as the worker
1. Install on both from the stick, clicking **Yes** on the admin prompt, especially on the laptop.
2. On the laptop: `C:\TensorSwarm\master\start_master.cmd -NoLocalWorker`. Note its IP.
3. On the GPU PC: **TensorSwarm Worker**, then enter the laptop's IP.
4. On either one: **TensorSwarm Dashboard**, or open `http://<LAPTOP_IP>:8000`. Run *GPU & Environment Info*: it reports the GPU PC's card.

### 3. College lab (one Master, many workers)
1. **Install** (~3–5 min per PC, Master PC first): Tailscale → `install.cmd` → **Yes** → unplug → next PC.
2. **Master PC:** **TensorSwarm Master**. Write its IP on the board.
3. **Every other PC:** **TensorSwarm Worker**, then enter the IP.
4. **Everyone, at any PC:** **TensorSwarm Dashboard**, or open `http://<MASTER_IP>:8000` in a browser.
5. **Check the swarm:** Cluster shows one card per PC. In **Jobs & Samples**, pick *GPU & Environment Info* or *Matrix Multiply TFLOPS* and **Run on every GPU** to compare all workers side by side.
6. **When done:** **TensorSwarm Stop** on each PC.

---

## ✅ Lab day checklist

**The night before (at home):**
- [ ] `.\prepare_usb.cmd` (or `-CodeOnly` if you only changed code), and wait for *"Installer USB ready"*.
- [ ] Big datasets for the session: add them (`scripts\ts_dataset.py add ...` or the Datasets tab at home), then `.\prepare_usb.cmd -CodeOnly -Datasets name`.
- [ ] Optional: `E:\TensorSwarm\install.cmd` on your own PC and a quick **TensorSwarm Master** test.
- [ ] Note which NVIDIA driver the lab PCs have. Older than 527.41 needs a `-Cuda cu118` build.

**In the lab:**
- [ ] Every PC: Tailscale installed, signed in to the swarm account, tray icon **Connected**.
- [ ] Every PC, Master first: `E:\TensorSwarm\install.cmd`, **Yes** on the admin prompt, unplug, next PC.
- [ ] Every PC: disable sleep (Settings → System → Power → *Never*) and keep it plugged in.
- [ ] Master: **TensorSwarm Master**, then write its IP on the board.
- [ ] Every other PC: **TensorSwarm Worker**, then type the IP.
- [ ] Any PC: **TensorSwarm Dashboard**. Cluster shows one card per PC.
- [ ] Jobs & Samples: *GPU & Environment Info* → **Run on every GPU**. Every PC answers.
- [ ] Datasets: upload what you need, then **Copy to all PCs** before people start training.

**Before you leave:**
- [ ] Export any notebook you want to keep (**Export .ipynb**).
- [ ] **TensorSwarm Stop** on every PC (workers first, then the Master).

---

## 🖥️ Using TensorSwarm

### Dashboard pages

| Page | What it shows |
| :--- | :--- |
| **Cluster** | One card per PC. **Live:** GPU load, VRAM used/total, temperature, power vs. limit, SM and memory clocks, fan, P-state, throttle reasons. **History:** charts for the last 10–30 minutes. **Specs:** architecture, compute capability, CUDA cores, PCIe link, driver and CUDA version, CPU and RAM. **Processes** using the GPU. **Ray scheduler:** total and free GPU shares. |
| **Notebook** | A Colab-style notebook. See below. |
| **Datasets** | Every dataset on the Master: versions, size, files, and **which PCs already have a copy**. Upload (drag a folder in), import from a URL, **Copy to all PCs**, **Clear worker caches**, copy the code for a notebook. |
| **Jobs & Samples** | Ready-made test scripts. Run them on one node or **on every GPU at once**. Also a batch script editor and the job history with full output, run time and peak VRAM. |

The address in the top-right corner shows which Master the page talks to. **"this server"** means the Master that served the page, which is what you want in almost every case.

### The notebook

- **Connect** starts a persistent Python runtime on the PC you pick, or on "any free GPU". Running a cell also connects automatically.
- **GPU share:** **1** reserves the whole GPU; **0.5 / 0.25** shares it with other notebooks or jobs; **CPU only** reserves none and can run on **any** PC, including PCs without a GPU.
- **CPU cores:** 1, 2, 4 or 8 cores reserved for the runtime. PyTorch and NumPy use that many threads. GPU work rarely needs more than 1–2; CPU-only training wants 4+.
- **Variables persist between cells**, as in Colab. **Restart** clears them; **Interrupt** stops a running cell.
- **Keyboard:**
  - **Shift+Enter** runs the cell and moves to the next one; **Ctrl+Enter** runs it and stays; **Alt+Enter** runs it and inserts a new cell.
  - **Ctrl+M** then `B`/`A` inserts a cell below/above, `D` deletes, `M`/`Y` switches to text/code, `I` interrupts, `.` restarts.
- **Output:**
  - Live stdout and stderr.
  - The value of the last line as `Out[n]`.
  - Images via `display(...)` (PIL, matplotlib) and HTML tables (pandas).
  - Tracebacks that point at your own cell's lines.
  - Run time and **peak VRAM** per cell.
- **Shell:** `!nvidia-smi`, `!pip install <pkg>`, and other `!` lines run on the **worker's** shell.
- **Side panel:**
  - **Runtime:** the worker and GPU, live meters, PyTorch's memory use, and the **other active runtimes**, each with a Stop button to free its GPU.
  - **Variables:** an inspector.
  - **Samples:** open a sample as a notebook, or insert its cells.
  - **Shortcuts.**
- **Files:** notebooks are saved in your browser. **Import/Export `.ipynb`** works with Colab, Jupyter and VS Code; **`.py`** uses the `# %%` cell format. **Run as batch job** sends the whole notebook as one job.
- **Limits:** an idle runtime stops itself after 60 minutes (`TENSORSWARM_KERNEL_IDLE_MINUTES`). If no GPU share is free, Connect tells you immediately which runtimes hold it.

> **Missing libraries install themselves, like Colab.** When a cell or job imports something the worker doesn't have (`import pandas`, `from sklearn import ...`), TensorSwarm runs `pip install` on **that** PC first, shows the progress in the output, then runs your code. It happens once per PC; later runs start instantly. Import names are mapped to pip names (`sklearn` → `scikit-learn`, `cv2` → `opencv-python-headless`, `PIL` → `pillow`, `yaml` → `pyyaml`, ...). Everything already installed is pinned during the install, so it never changes `torch`, `ray`, `numpy` or `click`. A package that would need different versions fails with a message instead. Needs internet on the worker. Turn it off with the environment variable `TENSORSWARM_AUTO_INSTALL=0`. `!pip install <pkg>` still works for anything else. For packages the whole lab needs **offline**, add them to the build at home and redistribute the stick.

### Datasets

Workers can only read files that are **on that worker**. The data layer gets them there.
The full design is in [docs/DATASETS.md](docs/DATASETS.md).

**In code** (`ts` is pre-imported in every notebook and job):
```python
root = ts.dataset("cifar10")              # local folder on this worker (copied once, then cached)
csv  = ts.dataset("iris") / "Iris.csv"    # a single-file dataset
root = ts.dataset("cifar10@3f2a9c1b7d0e") # pinned version (reproducible runs)

from torchvision.datasets import ImageFolder
train = ImageFolder(root / "train")       # DataLoader(..., num_workers=0) on Windows

ts.upload("runs/best", "cifar10-model")   # publish results; load anywhere with ts.dataset(...)
ts.download("https://.../data.zip", extract=True, sha256="...")   # internet -> this worker, cached
ts.hf_download("ylecun/mnist", "mnist/train-00000-of-00001.parquet")
```
The **Data** tab in the notebook's side panel lists datasets and inserts the right line for
you. The sample **Train on a Dataset** shows the whole loop.

**Getting data in: pick by size**

| Dataset | How | Notes |
| :--- | :--- | :--- |
| Up to ~1 GB | **Datasets → Upload** (files, a folder, or a `.zip`) | Resumes after a dropped connection: pick the same files and press **Resume upload**. |
| 1–5 GB | Upload, then **Copy to all PCs** before the session | Workers copy it in parallel, in the background. |
| Over 5 GB / used all term | `prepare_usb.cmd -Datasets name` | `install.cmd` puts it on every PC; no network at all. |
| Public URL / Hugging Face | **Datasets → Import from a URL** (`https://…` or `hf://datasets/owner/repo/file`) | The Master downloads it once; workers then use the lab network. |
| Already on the Master PC's disk | `python_env\python.exe scripts\ts_dataset.py add D:\data\cifar10 --name cifar10` | Big folders are zipped first (one transfer, extracted on each worker). |

- **Many small files** (image folders): upload them **as one `.zip`**. Workers extract it
  locally. Thousands of separate files are far slower over Wi-Fi.
- **Versions:** uploading new content under the same name creates a new version. Old ones stay
  until deleted. Identical content is stored once.
- **Jobs:** `POST /api/v1/jobs/submit` with `"datasets": ["cifar10"]` copies the data before the
  script starts, and prefers a worker that already has it.
- **Where it lives:** `C:\ProgramData\TensorSwarm\datasets\` on every PC (`store\` on the Master,
  `cache\` on workers). Free space on a PC with **Clear worker caches** or `ts.evict()`.

### CPU compute: every PC's cores

Every PC offers its CPU cores to the swarm, the ones without a GPU too. Three ways to use them:

| How | Where | Use it for |
| :--- | :--- | :--- |
| **CPU only** runtime + **CPU cores** | Notebook → Connect | Interactive CPU work on one PC (pick the PC, or "Any PC with free cores") |
| **CPU only** + cores in **Jobs & Samples** | Batch jobs; **Run on every PC** compares them | Scripts that don't need a GPU (preprocessing, classic ML, small models) |
| `ts.map(fn, items, num_cpus=1)` | Inside any notebook or job | Many independent pieces **in parallel across all PCs**: hyperparameter searches, cross-validation folds, simulations, file conversion |

```python
def score(cfg):                          # imports go INSIDE: it runs on another PC
    import torch
    root = ts.dataset("wine-red")         # works there too: copied to that PC once
    ...
    return {"cfg": cfg, "acc": acc}       # return small values, not big tensors

results = ts.map(score, configs)          # in input order; prints progress per PC
ts.cluster()                              # cores and GPUs per PC, how many are free
ts.map(fn, items, num_gpus=0.5)           # the same on GPU shares
```

- Each call to `fn` should take **seconds or more**; for tiny functions the network round trip dominates.
- An error in any call stops the rest and is raised in your cell, with the remote traceback.
- A lab PC's user can keep it responsive: start its worker with fewer cores, e.g. `start_worker.cmd <MASTER_IP> -NumCpus 4`.
- The Master PC counts its cores once: its local worker offers them, the Ray head offers none. With `-NoLocalWorker` (e.g. a laptop Master) the head offers the laptop's cores.
- The sample **CPU Swarm: Parallel Hyperparameter Search** shows the whole pattern.

### Sample scripts (`master/samples/`)

| Sample | What it tests | Time |
| :--- | :--- | :--- |
| GPU & Environment Info | GPU, driver, CUDA and PyTorch the worker really sees. Run this first on a new node. | ~5 s |
| GPU Correctness Check | GPU results vs. a float64 CPU reference. Catches broken drivers and bad VRAM. | ~10 s |
| Usable VRAM Check | Fills free VRAM in 256 MB blocks and verifies every block | ~10 s |
| Matrix Multiply TFLOPS | FP32 and FP16 compute at several sizes | ~20 s |
| Memory Bandwidth | VRAM bandwidth and PCIe bandwidth (pageable vs. pinned) | ~15 s |
| CPU vs GPU Speed-up | The same workloads on both devices | ~20 s |
| 60-Second Stress Test | Sustained load with temperature, power and clocks. Reveals thermal throttling. | ~65 s |
| Train a CNN (Synthetic Data) | A real training loop with mixed precision, no dataset download | ~40 s |
| Train on a Dataset | Publishes a CSV dataset, loads it with `ts.dataset()`, trains a PyTorch model, publishes the checkpoint | ~30 s |
| CPU Swarm: Parallel Hyperparameter Search | `ts.map()` trains 12 models with different settings on the CPU cores of every PC | ~40 s |
| Notebook Tour | Notebook features (notebook only) | ~30 s |

Reference numbers for a **GTX 1650 (4 GB)**: ~2.7 TFLOPS FP32, ~0.4 TFLOPS FP16 (no Tensor Cores), ~3 GB usable VRAM, ~2,800 img/s on the CNN sample.

**Add your own sample:** drop a `.py` file into `master/samples/`. Start it with these header lines, split it into cells with `# %%`, and set a variable named `result` to return a value. The dashboard picks it up on the next page load.
```python
# title: My Benchmark
# description: One line shown on the card.
# category: Benchmarks
# runtime: ~10 s
# gpu: required
```

### Jobs from Python or the command line

The API is open to every PC on the tailnet. Interactive docs are at `http://<MASTER_IP>:8000/docs`.

```powershell
# PowerShell: run a script on any free GPU
$body = @{ script_code = 'import torch; result = torch.cuda.get_device_name(0)'; num_gpus = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://100.101.102.103:8000/api/v1/jobs/submit -Body $body -ContentType application/json
Invoke-RestMethod http://100.101.102.103:8000/api/v1/jobs      # list jobs and their output
```

Set `target_node_ip` to run on one specific PC, `num_gpus` to `0.5` to share a GPU or `0` for CPU only (any PC), and `num_cpus` to the cores the job gets (default 1). Add `"datasets": ["name"]` to copy data to the worker before the script starts. For Ray-native code, `master/submit_example.py` connects with `ray.init("ray://<MASTER_IP>:10001")`. That only works from a PC with the **same** Python and Ray build, so use `C:\TensorSwarm\python_env\python.exe`.

---

## ❓ FAQ

**Can only the Master use the dashboard or send jobs?**
No. The Master *hosts* the dashboard and the API on port 8000, but every PC on the tailnet can open it and send notebooks and jobs. The Master only decides **where** the code runs.

**Do I start Master or Worker on a PC without a GPU?**
Master, with `start_master.cmd -NoLocalWorker`. A Worker exists to offer a GPU. The Master needs none: it's a pure orchestrator.

**Which PC should be the Master?**
The one that stays on the longest and has the most stable connection. Stopping or restarting the Master disconnects all workers and ends every running notebook and job.

**Where does my code run?**
On the worker that was picked (Runtime panel / job details show the PC and GPU), never in your browser. Files your code reads must exist on **that** PC.

**Can several people use the swarm at once?**
Yes. Each notebook or job reserves a GPU share (1, 0.5, 0.25 or 0). When all shares are taken, new requests are refused immediately with the list of holders, instead of waiting.

**How do the workers get my training data?**
Upload it in the **Datasets** tab (or import a URL, or put it on the USB stick), then use `ts.dataset("name")` in your code. Each worker copies it from the Master the first time and keeps it cached. See [Datasets](#datasets).

**Can one model use the GPUs of several PCs together?**
Not automatically. TensorSwarm runs many jobs in parallel, one PC each. Splitting a single model needs distributed training code.

**Does it work without Tailscale?**
No. Tailscale gives every PC a fixed `100.x.y.z` address that works across networks and NATs, and the firewall rules only allow those addresses.

**Do lab PCs need internet?**
Only for Tailscale to connect. Everything else comes from the stick.

**Is installing to `C:\TensorSwarm` required?**
No: `install.cmd -Destination D:\TensorSwarm` works too (useful when `C:` is wiped on reboot). Don't run from the stick itself: it's slow, and the start scripts refuse to run from the packed stick.

---

## 🩺 Troubleshooting

**First stops:**
- the start window's last lines;
- `C:\TensorSwarm\logs\master\` or `logs\worker\` (`<service>.out.log` / `.err.log`; the previous run is kept as `.prev`);
- Ray's own logs in `C:\ProgramData\TensorSwarm\ray\session_latest\logs`.

### Install and start

| Symptom | Cause / fix |
| :--- | :--- |
| `running scripts is disabled on this system` | Use the `.cmd` files. They bypass the execution policy for that one process only. |
| `Portable Python not found` | The environment isn't built. Run `build_usb_env.cmd` at home. If you started from the stick, run `install.cmd` and use the Desktop shortcuts. |
| `packed environment but it is not installed yet` | You ran a start script from the stick. Run `install.cmd`, then start from `C:\TensorSwarm`. |
| `install.cmd`: archive missing or incomplete | The copy to the stick was interrupted or the stick was pulled early. Re-run `prepare_usb.cmd`; it re-copies only what's missing. |
| `Tailscale is not installed` / no Tailscale IP | Install Tailscale, sign in, and make sure the tray icon says **Connected**. Check with `tailscale ip -4`. |
| `ValueError: ... is not a valid Sentinel` from `ray start` | `click` ≥ 8.3 breaks Ray 2.35's CLI. Run `python_env\python.exe -m pip install "click<8.3"`. It's pinned in the requirements, so rebuilt environments are fine. |
| `could not import Ray` although the build finished | Old copy of the scripts. Run `prepare_usb.cmd -CodeOnly`, then `install.cmd`. |
| `Log file ... is locked` | An old run is still alive. Run **TensorSwarm Stop**, as Administrator if that run was started as Administrator, or reboot. |
| First start takes a minute or more | Windows Defender scans the new files the first time. Later starts are faster. |

### Workers joining the Master

| Symptom | Cause / fix |
| :--- | :--- |
| Worker: `Cannot reach the Ray head` | Is the Master running? Does `tailscale ping <MASTER_IP>` answer? Was the **Master** installed with **Yes** on the admin prompt (firewall)? If not, run `install.cmd` again on the Master and click **Yes**. |
| `PermissionError: [WinError 5] Access is denied: 'C:\\Users\\<name>'` | The Master runs old code that puts Ray's temp folder in its user profile, which workers can't create. Update the **Master** (`prepare_usb.cmd -CodeOnly`, then `install.cmd`). Current code uses `C:\ProgramData\TensorSwarm\ray` on every PC. |
| `Version mismatch` in `logs\worker\ray-worker.out.log` | This PC's environment differs from the Master's. Install **both** from the same stick. A Linux/Docker node must match the Python patch version too; see [Linux / Docker](#-linux--docker-nodes). |
| Firewall popup for `python.exe` / `raylet.exe` / `gcs_server.exe` | Click **Allow access** (private and public), or run `install.cmd` once with **Yes**. |
| Worker joins, then shows **offline** after a while | The PC went to sleep, or Tailscale disconnected. Keep swarm PCs plugged in with sleep disabled. |

### Dashboard

| Symptom | Cause / fix |
| :--- | :--- |
| `http://<MASTER_IP>:8000` doesn't load from another PC | Check, in order: the Master is running; it loads on the Master itself at `http://localhost:8000`; `tailscale ping <MASTER_IP>` works; the Master has the firewall rules (`install.cmd` with **Yes**). |
| **TensorSwarm Dashboard** opens the wrong Master | It reuses the IP this worker joined last. Run `C:\TensorSwarm\open_dashboard.cmd <MASTER_IP>`, or start the worker with the new IP once. |
| The **Datasets** tab (or another page) shows **404** while the rest works | That PC was installed by an older `prepare_usb`/`install` that skipped every folder named `datasets`, including the page itself. Run `prepare_usb.cmd -CodeOnly`, then `install.cmd` on that PC (the Master matters most). Check: `C:\TensorSwarm\master\dashboard\datasets\index.html` must exist. |
| The page shows JSON *"the dashboard is not built"* | `master\dashboard\` is missing. On a PC with Node.js: `cd frontend`, `npm install`, `npm run build:static`. Then `prepare_usb.cmd -CodeOnly` and `install.cmd`. |
| Red banner *"Could not reach the Master API"* | The Master stopped, or the top-right address points at an old Master. Click it and clear it to use **this server**. |
| A PC appears twice, or values flicker | Two telemetry agents report for the same PC, usually a leftover from an earlier run (e.g. one started as Administrator). Run **TensorSwarm Stop** on that PC as Administrator, or reboot it, then start again. |
| Per-process VRAM shows "n/a" | Windows (WDDM) doesn't report per-process VRAM. The process list and total VRAM are still correct. |

### Datasets

| Symptom | Cause / fix |
| :--- | :--- |
| `Dataset 'x' not found on the Master` | The name is wrong, or it was deleted. The message lists the known names. Names are lower-case. |
| Upload stops with *"Network keeps failing"* | Wi-Fi dropped for too long. Fix the connection and press **Resume upload**: finished bytes are kept. |
| Copying to workers is very slow | `tailscale ping <MASTER_IP>` from the worker: `via DERP` means relayed traffic. Put big datasets on the USB stick instead (`prepare_usb.cmd -Datasets name`). |
| `Not enough disk space on this PC` | Free space, or **Clear worker caches** on that dataset, or `ts.evict()` in a notebook on that PC. |
| `507` when uploading | The Master's disk is too full (it keeps 1 GB free). Delete old datasets or versions. |
| *"another process on this PC is busy with it, waiting"* | Normal: two runtimes asked for the same dataset (or package install) at once; the second waits for the first. |
| `Can't delete ...: files are in use` | A notebook on the Master PC has the files open. Stop it in **Runtime → Active runtimes**, then delete again. |
| `prepare_usb -Datasets`: *larger than this drive allows* | The stick is FAT32 (4 GB per file). Reformat it as exFAT or NTFS. |
| `WARNING: Master unreachable, using the local copy` | The worker couldn't reach the Master, so it used the copy it already had. Check Tailscale if this is unexpected. |

### Running code

| Symptom | Cause / fix |
| :--- | :--- |
| Connect fails immediately: *no free GPU share* | Another notebook or job holds the GPU. Stop it in **Runtime → Other active runtimes**, or connect with a 0.5 share or CPU only. |
| Jobs run on CPU although the PC has a GPU | The driver is too old for the CUDA build. Update it, or rebuild with `-Cuda cu118`. |
| `CUDA out of memory` | The GPU is full. On 4 GB cards: use smaller batches, `torch.cuda.empty_cache()`, or **Restart** the runtime. Check for other runtimes on the same GPU. |
| A cell hangs and Interrupt doesn't help | Code stuck inside a CUDA call can't be interrupted. Use **Restart**, which kills the runtime process and frees the GPU. |
| *"N CPU cores requested, but no PC offers more than M"* | Pick fewer cores, or a bigger PC. A runtime or job always lives on **one** PC; use `ts.map` to use several. |
| *"Only N CPU cores are free in the swarm"* | Other runtimes and jobs hold the cores. Stop one in **Runtime → Other active runtimes**, or pick fewer cores. |
| `ts.map` prints *"waiting for a free core"* and seems stuck | Every core is reserved (often by idle notebook runtimes). Disconnect unused runtimes; the calls start as soon as cores free up. |
| CPU-only job fails with `Invalid device id` | Fixed: an old Master. Update it (`prepare_usb.cmd -CodeOnly`, `install.cmd`). In your own code, check `torch.cuda.device_count() > 0`, not just `is_available()`. |
| *"could not install X"* above an import error | The worker has no internet, the name is a typo, or the package needs a different torch/numpy than the build has. Check the pip lines shown in the output. If the import name differs from the pip name, install it once with `!pip install <pip-name>`. |
| `DataLoader` hangs or crashes on Windows | Use `num_workers=0`. Windows starts subprocesses with *spawn*, which can't re-import code sent as a string. |
| File not found on a worker | Code runs on **the worker PC**, not on your PC. Copy data there, or download it inside the script. Use `pathlib` paths, never `/tmp/...`. |

---

## 🐧 Linux / Docker nodes

Linux PCs can join with Docker:

```bash
cd TensorSwarm/master && sudo ./start_master.sh                 # Master (Ray head + API in Docker)
cd TensorSwarm/worker && sudo ./start_worker.sh <MASTER_IP>      # Worker
sudo docker compose down                                         # stop (in master/ or worker/)
sudo docker compose logs -f                                      # logs
```

The scripts install Docker and the NVIDIA Container Toolkit if they're missing.

**Mixing Linux and Windows nodes:** Ray only connects nodes with the **same Ray version and Python patch version**. The Windows build is Python 3.10.15 with Ray 2.35.0. Check a container with `sudo docker exec tensorswarm_worker python -c "import sys, ray; print(sys.version, ray.__version__)"`. The Dockerfiles start from `rayproject/ray:2.58.0-py310-gpu` while `requirements.txt` pins `ray[default]==2.35.0`, so verify what actually ends up in the image before mixing. The Docker path hasn't been re-tested against the current server; the Windows path is the tested one.

---

## 📖 Reference

### Ports

All ports are reachable from Tailscale peers only. The firewall rules are program-based, in the rule group `TensorSwarm`.

| Port | Where | Used for |
| :--- | :--- | :--- |
| **8000** | Master | **Dashboard + REST API** (`/docs` for the interactive API docs) |
| 8265 | Master | Ray dashboard |
| 6379 | Master | Ray GCS (workers join here) |
| 10001 | Master | Ray client (`ray://`) |
| 20000–20050 | every node | Ray task-worker processes |
| 20100–20164, 52366 | Master PC | Its local worker, on separate ports from the head |

Remove the firewall rules with `Get-NetFirewallRule -Group TensorSwarm | Remove-NetFirewallRule`, run as Administrator.

### Folders on each PC

```
C:\TensorSwarm\
├── python_env\                 portable CPython 3.10 + torch, ray, fastapi ... (≈5 GB)
├── master\start_master.cmd     Master: Ray head + API/dashboard (+ local worker)
├── master\dashboard\           pre-built web UI, served at :8000
├── worker\start_worker.cmd     joins this PC's GPU to a Master
├── open_dashboard.cmd          opens the Master's dashboard in the browser
├── stop_tensorswarm.cmd        stops everything started from this folder
└── logs\master\, logs\worker\  service logs
C:\ProgramData\TensorSwarm\ray\ Ray's temp folder and internal logs (same path on every PC)
C:\ProgramData\TensorSwarm\datasets\  store\ (Master + USB seeds), cache\ (copies on workers)
```

**Uninstall:** run **TensorSwarm Stop**, then delete `C:\TensorSwarm`, `C:\ProgramData\TensorSwarm`, the four Desktop shortcuts and the firewall rules (above).

### What's on the stick

```
E:\TensorSwarm\
├── install.cmd                 run on each PC
├── payload\python_env.tar.gz   the whole environment in one file (+ file list and build id)
├── datasets\                   optional: datasets for install.cmd to seed (prepare_usb -Datasets)
└── master\, worker\, scripts\, frontend\ (source, no node_modules) ...
```

### Script options

| Script | Options |
| :--- | :--- |
| `build_usb_env.cmd` | `-Cuda cu121\|cu118\|cpu`, `-WinPythonDir <path>` (use WinPython instead), `-PythonVersion`, `-StandaloneRelease` |
| `prepare_usb.cmd` | `-Drive <letter>`, `-Destination <path>`, `-CodeOnly`, `-Repack`, `-Datasets <name,name \| *>` |
| `scripts\ts_dataset.py` | `add <path> --name N [--pack auto\|zip\|none]`, `list`, `verify`, `export --to <dir>`, `seed <dir>`, `evict [name]` (run with `python_env\python.exe`) |
| `install.cmd` | `-Destination <path>`, `-Force`, `-NoShortcuts`, `-NoElevate` |
| `start_master.cmd` | `-NoLocalWorker`, `-NoFollow` (don't stream logs), `-SkipFirewall`, `-ApiPort`, `-NumGpus`, `-NumCpus <n>` (cores the head offers; default: 0 with the local worker, all with `-NoLocalWorker`) |
| `start_worker.cmd` | `<MASTER_IP>`, `-NumGpus <n>` (offer fewer GPUs), `-NumCpus <n>` (offer fewer CPU cores; default all), `-NoFollow`, `-SkipFirewall` |
| `open_dashboard.cmd` | `<MASTER_IP>` (otherwise: localhost on the Master, else the last Master IP, else asks) |
| `stop_tensorswarm.cmd` | `-WhatIf`, `-Quiet` |

### API overview

| Endpoint | Purpose |
| :--- | :--- |
| `GET /healthz` | Health and Ray connection |
| `GET /api/v1/nodes`, `/api/v1/nodes/{id}/history`, `/api/v1/cluster/summary`, `/api/v1/ray/status` | Telemetry and cluster state |
| `POST /api/v1/jobs/submit`, `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}` | Batch jobs |
| `GET/POST /api/v1/kernels`, `DELETE /api/v1/kernels/{id}`, `POST .../execute`, `GET .../executions/{exec_id}`, `POST .../interrupt`, `GET .../variables`, `GET .../gpu` | Notebook runtimes |
| `GET /api/v1/samples` | Sample scripts |
| `GET /api/v1/datasets`, `POST .../uploads` (+ chunk `PUT`s), `POST .../imports`, `POST .../{name}/prefetch`, `GET .../{id}/files/{path}` | Datasets (full list in [docs/DATASETS.md](docs/DATASETS.md#6-api)) |
| `POST /api/v1/telemetry/heartbeat` | Used by the agents |

### Repository structure

```
TensorSwarm/
├── build_usb_env.cmd/.ps1     builds the portable Python environment (once, at home)
├── prepare_usb.cmd/.ps1       packs it, rebuilds the dashboard if needed, writes the USB
├── install.cmd/.ps1           installs from the USB to C:\TensorSwarm (+ firewall, shortcuts)
├── stop_tensorswarm.cmd/.ps1  stops everything started from this folder
├── open_dashboard.cmd/.ps1    opens the Master's dashboard (Desktop shortcut)
├── master/                    the Master: API server, scheduler glue, data layer
│   ├── start_master.cmd/.ps1    Windows Master launcher
│   ├── server.py                FastAPI: telemetry, jobs, notebook runtimes, serves the dashboard
│   ├── datasets_api.py          dataset store, resumable uploads, URL imports, Range file serving
│   ├── tensorswarm_client.py    `ts` client (ts.dataset, ts.map, ts.upload, ...), shipped to every worker
│   ├── agent.py                 telemetry agent (same file as worker/agent.py)
│   ├── samples/                 test and tutorial scripts shown in the dashboard
│   ├── dashboard/               pre-built web UI (generated by npm run build:static; don't edit)
│   ├── submit_example.py        Ray-native job example
│   └── start_master.sh, entrypoint.sh, docker-compose.yml, Dockerfile, requirements.txt   Linux/Docker
├── worker/                    a GPU (or CPU) node
│   ├── start_worker.cmd/.ps1    Windows worker launcher
│   ├── agent.py                 NVML telemetry agent
│   └── start_worker.sh, entrypoint.sh, docker-compose.yml, Dockerfile, requirements.txt   Linux/Docker
├── scripts/                   shared helpers used by the launchers
│   ├── TensorSwarm.Common.psm1  PowerShell helpers (Tailscale, GPUs, firewall, Ray temp folder, logs)
│   ├── verify_env.py            self-test of the environment
│   └── ts_dataset.py            dataset CLI: add / export to USB / seed / verify / evict
├── frontend/                  Next.js 14 + Tailwind dashboard source
│   ├── app/                     pages: / (Cluster), /notebook, /jobs, /datasets; api/ = dev proxy
│   ├── components/, lib/        UI components, API client, notebook model (.ipynb/.py)
│   └── build-static.js          static export → ../master/dashboard
└── docs/
    ├── DATASETS.md              data-layer design: options, protocols, failure behaviour
    ├── SECURITY_GUIDE.md        hardening workers, Tailscale ACLs
    └── TensorSwarm_Project_Overview.pdf   15-page overview (architecture, trade-offs, Q&A)
```

The Windows entry points stay in the root on purpose: on the USB stick they are what people
double-click (`install.cmd`, `prepare_usb.cmd`, ...).

**Not in the repository** (large or machine-specific; see `.gitignore`): `python_env\` and
`wheelhouse\` (made by `build_usb_env.cmd`), `dist\` (the packed archive), `logs\`,
`frontend\node_modules\`, `worker\.env`. After cloning, run `build_usb_env.cmd` once.

---

## 🔒 Security

- **Anyone who can reach the Master on port 8000 can run any code on every worker.** That's the point of the tool, but it means you should **only invite people you trust to the tailnet**. There are no user accounts or passwords.
- The firewall rules allow only Tailscale addresses (`100.64.0.0/10`), so other people on the lab LAN can't connect directly.
- **Datasets are readable by everyone on the tailnet**, like jobs. Don't upload private data to a shared tailnet.
- Code runs as the Windows user who started the worker, with that user's file access. Don't start workers from an account with access to sensitive files.
- Use Tailscale ACLs to limit who can reach port 8000 and 6379 if the tailnet is shared. See [docs/SECURITY_GUIDE.md](docs/SECURITY_GUIDE.md).

---

## 💡 Limitations and tips

- **Ray on Windows is beta**, and multi-node clusters are officially unsupported there. The scripts enable them (`RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1`), and it works well in testing. If you hit a Ray-on-Windows bug, a Linux Master is the fallback.
- **One job or runtime = one PC.** TensorSwarm runs many jobs on many GPUs in parallel. It doesn't split *one* model across PCs; that would need distributed training code (e.g. `torch.distributed`) over the network.
- **Network speed matters for data, not compute.** Send code and small data; download large datasets on the worker itself.
- **Don't let swarm PCs sleep.** Ray marks a sleeping node as dead and its running work fails.
- **RAM:** each Ray node uses ~0.5–1 GB of RAM. On 8 GB PCs, close heavy apps.
- **Lab proxies:** the agent and scripts force direct connections to Tailscale addresses, so a system proxy doesn't get in the way.
- **Notebooks live in your browser.** Export important ones as `.ipynb`: clearing browser data, or opening the dashboard from another PC or under another Master IP, starts with an empty list.

---

## 🧑‍💻 Developing TensorSwarm

**Frontend** (needs Node.js 18+):
```powershell
cd frontend
npm install
npm run dev              # live-reload dev server at http://localhost:3000, proxying to the Master
npm run build:static     # build the static dashboard into ../master/dashboard (what ships on the stick)
```
- In dev mode, `/api/*` goes through `app/api/[...path]/route.ts` to `MASTER_API_URL`, which defaults to `http://127.0.0.1:8000`. Set it in `frontend/.env.local`, or set the address in the top-right corner of the UI, to use a remote Master.
- `npm run build:static` writes to the same `.next` folder as `npm run build`. Run `npm run build` again before `npm start`.
- `prepare_usb.cmd` runs `build:static` automatically when the frontend source is newer than `master\dashboard`.

**Backend:** `master/server.py` is a single FastAPI file. Run it from the portable environment: start the Master normally, or for quick API work use `python_env\python.exe -m uvicorn server:app --app-dir master --port 8000`. `TENSORSWARM_DASHBOARD_DIR` overrides where it looks for the dashboard.

**Agent:** `master/agent.py` and `worker/agent.py` are the same file. Keep them identical.

**Data client:** `master/tensorswarm_client.py` is imported by the server **and** shipped as source to every notebook runtime and job, where it becomes `import tensorswarm as ts`. Keep it standard library + `requests` only, since workers have nothing else to rely on.

**After any change:** `prepare_usb.cmd -CodeOnly`, then `install.cmd` on each PC.

---

## 📄 License

[MIT](LICENSE). Security model and how to report a vulnerability: [SECURITY.md](SECURITY.md).
