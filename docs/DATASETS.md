# TensorSwarm data layer: design

How datasets get from wherever they start (your PC, the internet, a USB stick) to the GPU
that trains on them, on a Windows-only cluster linked by Tailscale over college Wi-Fi.

---

## 1. Constraints

| Constraint | Consequence for the design |
| :--- | :--- |
| Links can be slow or flaky (campus Wi-Fi, hotspots, Tailscale relays) | Transfers must **resume** where they stopped, never restart. Nothing may depend on one long, unbroken HTTP request. |
| Native Windows only: no NFS, GlusterFS, SMB-over-Tailscale setup, or FUSE | Use **plain files plus HTTP**: the FastAPI server and `requests` that every node already has. |
| No package installs on lab PCs | Standard library plus `requests` only. No `huggingface_hub`, no `python-multipart`, no new wheels. |
| Lab PCs may be wiped, shared by several Windows accounts, or locked down | Data lives in one user-independent folder (`C:\ProgramData\TensorSwarm\datasets`). The disk is checked before writing. The cache is safe to delete at any time. |
| Several notebooks and jobs can run on one PC at once | The cache must be **concurrency-safe** (inter-process lock), and readers must never see half-written data. |
| Results must be reproducible across a class or a week | Datasets are **immutable, content-addressed versions**. |

## 2. Options evaluated

**A. Upload to the Master, workers pull over HTTP**

| | |
| :--- | :--- |
| Strengths | Works for any data on anyone's PC. One source of truth. Workers fetch only what they use. |
| Weaknesses | The Master's uplink is shared: N workers × size. If Tailscale falls back to a relay (DERP), throughput drops to a few MB/s. |
| Best for | Small and medium datasets (≲ 2–5 GB), and data that changes often. |

**B. Pre-load on the USB stick**

| | |
| :--- | :--- |
| Strengths | Zero network. The stick already visits every PC for `install.cmd`. Copy speed is the USB's. |
| Weaknesses | Needs planning (the data is fixed when the stick is written). FAT32 sticks have a 4 GB per-file limit. Every PC gets the data even if it never uses it. |
| Best for | Big, stable datasets (≳ 5 GB) used all term. |

**C. Workers download from the internet**

| | |
| :--- | :--- |
| Strengths | No load on the Master. Good when the lab's internet beats the Master's link. |
| Weaknesses | Every PC uses the (shared) campus internet. Proxies and captive portals. Remote files can change unless pinned by SHA-256. Gated data needs tokens on every worker. |
| Best for | Public datasets and model weights, with fast internet. |

None of them wins everywhere, so TensorSwarm does not pick one. It has **one dataset model,
three ways in, and one way out**:

```
   ways in                              one model                      one way out
   ─────────────────────────            ─────────────────────          ──────────────────────────
   Browser upload (A)  ───────┐
   URL / hf:// import (A+C) ──┼──►  store\<name>@<version>\  ──►  ts.dataset("name") on any worker
   ts_dataset.py add (B) ─────┤     (immutable, content-       │     1. this PC's cache       (instant)
   ts.upload() from a job ────┘      addressed, on the Master) │     2. this PC's store       (USB seed / Master PC: in place)
                                                                │     3. pull from the Master  (resumable, verified)
   USB stick (B) ── install.cmd seeds store\ on every PC ──────┘
   ts.download(url) (C) ── straight from the internet into this worker's cache
```

## 3. Recommendation for a college lab

| Dataset | Use | Why |
| :--- | :--- | :--- |
| Up to about 1 GB, or still changing | **Upload** in the Datasets tab | One click. Workers copy it on first use, then it's cached. |
| 1–5 GB | **Upload**, then **Copy to all PCs** before the session | The copy happens in the background, in parallel, while nobody is waiting. |
| Over 5 GB, or the same set all term | **USB:** `prepare_usb.cmd -Datasets name` | `install.cmd` puts it on every PC. The network is never used. |
| Public, from Hugging Face or a URL, Master online | **Import from URL** in the Datasets tab | The Master downloads it **once** from the internet; workers pull it over the lab network. |
| Public, and every PC has fast internet | `ts.download(url, sha256=...)` in the script | No Master involvement. Cached per PC. |
| Results: checkpoints, predictions | `ts.upload(path, "name")` | Outputs become a dataset that any notebook can load. |

Many small files (image folders) should travel **as one archive**. The dashboard warns above
1,000 files. `ts_dataset.py add` zips folders over 500 files automatically, uncompressed, so
it's fast. Workers extract archives locally after one transfer. Per-file overhead (one HTTP
request, one hash and one NTFS file create per file) dominates on slow links otherwise.

**Check the link before a big transfer:** `tailscale ping <MASTER_IP>` says `via DERP(...)`
when traffic is relayed (slow), or shows a direct `ip:port` (LAN speed).

## 4. Design details

### Storage layout (identical on every PC)

```
C:\ProgramData\TensorSwarm\datasets\        (TENSORSWARM_DATA_DIR overrides)
├── store\<name>@<version>\                  authoritative copy (Master) or USB seed (any PC)
│   ├── manifest.json                        every file: path, size, SHA-256
│   └── files\...                            the files exactly as uploaded
├── cache\<name>@<version>\                  copies pulled from the Master
│   ├── manifest.json, .ready                .ready is written LAST: present = complete
│   ├── files\...                            plain datasets
│   └── data\...                             extracted archive datasets
├── downloads\<url-hash>\                    ts.download() cache
└── uploads\<op_id>\                         in-flight uploads and imports (resumable)
```

- **Version = hash of (path, size, SHA-256) of every file.** The same content always gives
  the same id, so uploading identical files again is a no-op. New content becomes a new
  version, and older versions stay usable. `ts.dataset("name")` means the latest;
  `ts.dataset("name@3f2a9c1b7d0e")` is pinned.
- **Atomic publish:** files are staged next to the store and become visible with **one
  directory rename**. Cache entries become valid with **one marker file**. A crash at any
  point leaves either the old state or the new one, never a half-dataset.
- **No database.** The catalog is rebuilt by scanning `store\` at start-up, so a power cut,
  a restart or a hand-copied folder never needs repair.

### Upload protocol (browser and `ts.upload` → Master)

1. `POST /api/v1/datasets/uploads` with the name and the file list (paths and sizes). The
   Master validates paths (no `..`, no drive letters, no reserved Windows names, no
   case-insensitive duplicates) and checks free disk space up front (`507` if it won't fit).
2. `PUT .../uploads/{op}/files/{i}?offset=N` with the raw bytes of one chunk (8 MB). The Master
   appends **only if `N` equals what it already has**. Otherwise it answers
   `409 {expected_offset}` and the client continues from there. Retries, duplicate chunks and
   lost replies are therefore harmless. The browser sends `File.slice()` views, so memory use
   stays flat for any file size.
3. `POST .../complete`: the Master hashes every file (SHA-256) and seals the version.
4. Resume: `GET .../uploads/{op}` returns the bytes received per file. The browser remembers
   the upload id per file set, so picking the same files again continues the upload. This
   survives a closed tab or a **Master restart** (`op.json` is on disk).

### Pull protocol (worker ← Master)

`GET /api/v1/datasets/{id}/manifest`, then for each missing file
`GET .../files/{path}` with `Range: bytes=<have>-`. Every file is written to `*.part`,
verified against its SHA-256 and renamed into place. Interrupted transfers resume from the
partial file. A corrupted partial fails the hash and is fetched again. Up to 4 files transfer
in parallel. Each attempt retries with exponential back-off (8 attempts). The partial file is
always kept, so re-running the cell resumes.

### Concurrency and multi-user safety

- An OS file lock (`msvcrt.locking` / `flock`) per dataset per PC means two runtimes asking
  for the same dataset produce one download; the second waits. The OS releases the lock if a
  process dies, so a stale lock is impossible.
- `install.cmd`, run as Administrator, grants `BUILTIN\Users` Modify on
  `C:\ProgramData\TensorSwarm`. A PC used by different Windows accounts on different days can
  then still update the shared cache.
- Long paths: file operations use `\\?\` paths, so deep dataset trees work even where
  Windows' `LongPathsEnabled` is off.

### Scheduling next to the data

Each agent heartbeat lists the datasets its PC holds. A job or runtime that declares
`datasets: [...]`, without a pinned worker, gets a **soft** node affinity for a PC that
already has them. Ray still uses another PC if that one is busy, so it never waits for
locality. Jobs with `datasets` also sync them **before** the script starts and fail at
submit time (404) if a name is wrong.

### Prefetch and eviction

`POST /api/v1/datasets/{id}/prefetch` starts one zero-CPU, zero-GPU Ray task per PC that runs
`ts.dataset(id)` there, so it works even while that GPU trains. `.../evict` deletes cached
copies; it never touches the Master's store or USB-seeded copies. The dashboard shows, per
PC, whether a dataset is *local copy*, *cached* or *not yet*.

## 5. Failure behaviour

| What goes wrong | What happens |
| :--- | :--- |
| Wi-Fi drops during an upload | The browser retries with back-off, up to 10 times per chunk. Then **Resume upload** continues from the Master's byte count. |
| Tab closed, laptop sleeps | Pick the same files again: the upload resumes. |
| Master restarts mid-upload | The upload resumes after the restart. Finished datasets are re-read from disk. |
| Wi-Fi drops while a worker pulls | It retries. The partial file is kept; running the cell again resumes from it. |
| Corrupted bytes (bad RAM or disk) | The SHA-256 mismatch is detected and that file is fetched again. |
| Master unreachable when a job starts | `ts.dataset()` uses the newest local copy, with a warning. It fails clearly if none exists. |
| Disk full | Checked **before** the transfer, with a message giving the free space and `ts.evict()`. |
| Two runtimes request the same dataset | One downloads; the other waits on the lock, then uses the same copy. |
| Stick pulled during `prepare_usb` or `install` | The manifest is written last on the stick; incomplete datasets are skipped, never half-installed. |
| Wrong dataset name in a job | `404` at submit, with a list of known names, before any GPU is reserved. |

## 6. API

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/v1/datasets` | List, with versions, sizes, and which PCs hold a copy |
| `GET /api/v1/datasets/{ref}`, `.../{ref}/manifest` | Details / full manifest (`ref` = `name` or `name@version`) |
| `GET /api/v1/datasets/{id}/files/{path}` | File download with HTTP Range |
| `POST /api/v1/datasets/uploads`, `PUT .../uploads/{op}/files/{i}?offset=`, `POST .../complete`, `GET`/`DELETE .../uploads/{op}` | Resumable upload |
| `POST /api/v1/datasets/imports`, `GET .../imports/{op}`, `GET /api/v1/datasets/operations` | URL / `hf://` import on the Master |
| `POST /api/v1/datasets/{ref}/prefetch`, `.../evict`, `GET /api/v1/datasets/tasks/{id}` | Cluster-wide copy / clear |
| `DELETE /api/v1/datasets/{id}` | Delete a version from the Master |
| `GET /api/v1/datasets/storage`, `POST /api/v1/datasets/rescan` | Disk space; re-read the store |
| `POST /api/v1/jobs/submit`, `POST /api/v1/kernels`: `datasets: [...]` | Sync before running; schedule near the data |

## 7. Known limits and next steps

- **The Master is the only server.** With many workers pulling a big dataset at once, its
  uplink is the bottleneck. Prefetching before class, or using the USB, avoids this in
  practice. A next step would be peer-to-peer pulls, where a worker that already has a
  dataset serves it to others, using the same manifest and Range protocol.
- **The cache grows until cleared.** Use **Clear worker caches**, `ts.evict()`, or
  `ts_dataset.py evict`. Automatic LRU eviction under disk pressure is a possible addition.
- **No access control.** Anyone on the tailnet can read and upload datasets, as with jobs.
  Keep sensitive data off a shared tailnet, or restrict port 8000 with Tailscale ACLs.
