"""
TensorSwarm dataset tool (runs with the portable Python, no server needed).

    python_env\\python.exe scripts\\ts_dataset.py add D:\\data\\cifar10 --name cifar10
    python_env\\python.exe scripts\\ts_dataset.py add D:\\data\\iris.csv --name iris
    python_env\\python.exe scripts\\ts_dataset.py list
    python_env\\python.exe scripts\\ts_dataset.py verify cifar10
    python_env\\python.exe scripts\\ts_dataset.py export --to E:\\TensorSwarm\\datasets cifar10 iris
    python_env\\python.exe scripts\\ts_dataset.py seed E:\\TensorSwarm\\datasets     (install.cmd does this)
    python_env\\python.exe scripts\\ts_dataset.py evict [name]

`add` puts a file or folder into THIS PC's store (the same store the dashboard uploads to).
Folders with many files are packed into one uncompressed .zip first: one big file copies to
the USB and over the network many times faster than thousands of small ones, and workers
extract it locally. Use it for datasets too big to upload comfortably through the browser.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "master"))
import tensorswarm_client as tsc  # noqa: E402

PACK_THRESHOLD = 500


def _say(msg: str):
    print(f"[ts_dataset] {msg}", flush=True)


def _notify_master():
    """Ask a running Master on this PC to re-read its store (harmless if none is running)."""
    try:
        import requests
        s = requests.Session()
        s.trust_env = False
        s.post("http://127.0.0.1:8000/api/v1/datasets/rescan", timeout=2)
        _say("The running Master picked it up.")
    except Exception:
        _say("Start (or restart) the Master to see it in the dashboard.")


def _selected(names):
    out = []
    root = tsc.store_dir()
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        m = tsc.read_manifest(d)
        if not m or d.name.startswith("."):
            continue
        if names and not any(m["id"] == n or m["name"] == n or m["id"].startswith(n + "@") for n in names):
            continue
        out.append((m, d))
    return out


def cmd_add(a):
    src = Path(a.path)
    if not src.exists():
        sys.exit(f"Not found: {src}")
    name = tsc.normalize_name(a.name or src.stem)
    staging = tsc.data_root() / "uploads" / f"cli_{uuid.uuid4().hex[:10]}" / "files"
    staging.mkdir(parents=True)
    try:
        if src.is_file():
            need = src.stat().st_size
            tsc._check_space(staging, need, "the copy")
            _say(f"Copying {src.name} ({tsc._human(need)}) ...")
            shutil.copyfile(src, staging / src.name)
            extract = None
        else:
            files = [p for p in src.rglob("*") if p.is_file()]
            need = sum(p.stat().st_size for p in files)
            tsc._check_space(staging, need, "the copy")
            pack = a.pack == "zip" or (a.pack == "auto" and len(files) > PACK_THRESHOLD)
            if pack:
                target = staging / f"{name}.zip"
                _say(f"Packing {len(files):,} files ({tsc._human(need)}) into {target.name} (uncompressed) ...")
                t0 = time.time()
                with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
                    for i, p in enumerate(files, 1):
                        z.write(p, arcname=p.relative_to(src).as_posix())
                        if i % 5000 == 0:
                            _say(f"  {i:,} / {len(files):,}")
                _say(f"Packed in {time.time() - t0:.0f} s.")
                extract = True
            else:
                _say(f"Copying {len(files):,} files ({tsc._human(need)}) ...")
                for p in files:
                    dest = staging / tsc.safe_relpath(p.relative_to(src).as_posix())
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(p, dest)
                extract = False if a.pack == "none" else None
        _say("Hashing (SHA-256) ...")
        m = tsc.build_dataset(staging, name, a.description or "", {"type": "local", "path": str(src)}, extract)
    finally:
        shutil.rmtree(staging.parent, ignore_errors=True)
    _say(f"Added {m['id']}: {m['file_count']:,} file(s), {tsc._human(m['total_bytes'])}"
         + (" (extracted on each worker)" if m["archive"] else ""))
    _say(f'Use it in a notebook:  path = ts.dataset("{m["name"]}")')
    _notify_master()


def cmd_list(a):
    rows = [(m, "store") for m, _ in _selected([])]
    if tsc.cache_dir().is_dir():
        for d in sorted(tsc.cache_dir().iterdir()):
            m = tsc.read_manifest(d)
            if m and (d / tsc.READY).exists():
                rows.append((m, "cache"))
    if not rows:
        _say(f"No datasets on this PC ({tsc.data_root()}).")
        return
    print(f"{'DATASET':40} {'WHERE':6} {'FILES':>8} {'SIZE':>12}  CREATED")
    for m, where in rows:
        print(f"{m['id']:40} {where:6} {m['file_count']:>8,} {tsc._human(m['total_bytes']):>12}  {m.get('created_at', '')}")


def cmd_verify(a):
    bad = 0
    for m, d in _selected(a.names):
        _say(f"Verifying {m['id']} ...")
        for f in m["files"]:
            p = d / "files" / f["path"]
            if not p.exists() or p.stat().st_size != f["size"] or tsc.sha256_file(p) != f["sha256"]:
                _say(f"  BAD: {f['path']}")
                bad += 1
    _say("All files OK." if not bad else f"{bad} bad file(s): delete the dataset and add it again.")
    sys.exit(1 if bad else 0)


def cmd_export(a):
    """Copy store entries to a folder (the USB stick). Manifest goes last, so an interrupted
    copy is recognised as incomplete and ignored by `seed`."""
    sel = _selected(a.names)
    if not sel:
        sys.exit("No matching datasets in this PC's store. Add one first (ts_dataset.py add ...).")
    to = Path(a.to)
    to.mkdir(parents=True, exist_ok=True)
    for m, _ in sel:
        too_big = [f for f in m["files"] if a.max_file_bytes and f["size"] > a.max_file_bytes]
        if too_big:
            sys.exit(f"{m['id']}: {too_big[0]['path']} is {tsc._human(too_big[0]['size'])}, larger than this drive allows "
                     "(FAT32: 4 GB per file). Reformat the stick as exFAT/NTFS, or upload this dataset over the network.")
    need = sum(f["size"] for m, _ in sel for f in m["files"]
               if not ((to / m["id"] / "files" / f["path"]).exists() and (to / m["id"] / "files" / f["path"]).stat().st_size == f["size"]))
    free = shutil.disk_usage(to).free
    if need > free:
        sys.exit(f"Not enough space on {to}: {tsc._human(need)} needed, {tsc._human(free)} free.")
    for m, d in sel:
        dest = to / m["id"]
        copied = 0
        for f in m["files"]:
            s, t = d / "files" / f["path"], dest / "files" / f["path"]
            if t.exists() and t.stat().st_size == f["size"]:
                continue
            t.parent.mkdir(parents=True, exist_ok=True)
            if f["size"] > 200 * 1024 ** 2:
                _say(f"  {m['id']}: copying {f['path']} ({tsc._human(f['size'])}) ...")
            shutil.copyfile(s, t)
            copied += f["size"]
        shutil.copyfile(d / tsc.MANIFEST, dest / tsc.MANIFEST)
        _say(f"{m['id']}: on the stick ({tsc._human(copied)} copied" + (", rest was already there)." if copied < m["total_bytes"] else ")."))


def cmd_seed(a):
    """Copy datasets from a folder (the stick) into this PC's store. Skips identical ones."""
    src = Path(a.source)
    if not src.is_dir():
        _say(f"No datasets folder at {src}; nothing to seed.")
        return
    store = tsc.store_dir()
    store.mkdir(parents=True, exist_ok=True)
    n = 0
    for d in sorted(src.iterdir()):
        m = tsc.read_manifest(d)
        if not m or m["id"] != d.name:
            continue
        if not tsc.files_present(d, m):
            _say(f"Skipping {d.name}: incomplete on the stick (re-run prepare_usb).")
            continue
        target = store / m["id"]
        tm = tsc.read_manifest(target)
        if tm and tm["version"] == m["version"] and tsc.files_present(target, m):
            _say(f"{m['id']}: already on this PC.")
            continue
        tsc._check_space(store, m["total_bytes"], m["id"])
        tmp = store / f".{m['id']}.seed"
        shutil.rmtree(tmp, ignore_errors=True)
        _say(f"{m['id']}: copying {tsc._human(m['total_bytes'])} from the stick ...")
        for f in m["files"]:
            t = tmp / "files" / f["path"]
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(d / "files" / f["path"], t)
            if a.verify and tsc.sha256_file(t) != f["sha256"]:
                shutil.rmtree(tmp, ignore_errors=True)
                sys.exit(f"{m['id']}: {f['path']} is corrupted on the stick. Re-run prepare_usb.")
        shutil.copyfile(d / tsc.MANIFEST, tmp / tsc.MANIFEST)
        shutil.rmtree(target, ignore_errors=True)
        os.replace(tmp, target)
        n += 1
    _say(f"Seeded {n} dataset(s) into {store}.")


def cmd_evict(a):
    freed = tsc.evict(a.ref, downloads=a.downloads)
    _say(f"Freed {tsc._human(freed)} of cached data on this PC (the store was not touched).")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add", help="add a file or folder to this PC's store")
    p.add_argument("path")
    p.add_argument("--name")
    p.add_argument("--description", default="")
    p.add_argument("--pack", choices=["auto", "zip", "none"], default="auto",
                   help=f"zip a folder first (auto: when it has more than {PACK_THRESHOLD} files)")
    p.set_defaults(fn=cmd_add)
    p = sub.add_parser("list", help="datasets on this PC")
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("verify", help="re-check SHA-256 of stored datasets")
    p.add_argument("names", nargs="*")
    p.set_defaults(fn=cmd_verify)
    p = sub.add_parser("export", help="copy datasets to a folder (the USB stick)")
    p.add_argument("--to", required=True)
    p.add_argument("--max-file-bytes", type=int, default=0)
    p.add_argument("names", nargs="*", help="names or ids; none = all")
    p.set_defaults(fn=cmd_export)
    p = sub.add_parser("seed", help="copy datasets from a folder (the stick) into this PC's store")
    p.add_argument("source")
    p.add_argument("--verify", action="store_true", help="also re-check SHA-256 (slower)")
    p.set_defaults(fn=cmd_seed)
    p = sub.add_parser("evict", help="delete cached (not stored) datasets on this PC")
    p.add_argument("ref", nargs="?")
    p.add_argument("--downloads", action="store_true", help="also clear ts.download() files")
    p.set_defaults(fn=cmd_evict)
    a = ap.parse_args()
    try:
        a.fn(a)
    except (tsc.DatasetError, ValueError) as exc:
        sys.exit(f"[ts_dataset] ERROR: {exc}")


if __name__ == "__main__":
    main()
