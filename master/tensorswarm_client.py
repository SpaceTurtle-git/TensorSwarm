"""
TensorSwarm data client: ``import tensorswarm as ts`` inside notebooks and jobs.

    path = ts.dataset("mnist")            # local folder with the dataset, synced if needed
    csv  = ts.dataset("iris") / "iris.csv"
    f    = ts.download("https://.../file.zip", extract=True)      # cached internet download
    f    = ts.hf_download("ylecun/mnist", "mnist/train-00000-of-00001.parquet")

How a dataset reaches the GPU (fastest first):
  1. Already in this PC's cache            C:\\ProgramData\\TensorSwarm\\datasets\\cache\\<id>
  2. In this PC's store                    ...\\datasets\\store\\<id>  (the Master PC itself, or a
     copy seeded from the USB stick by install.cmd)   -> used in place, no network
  3. Pulled from the Master over HTTP (Tailscale), resumable, SHA-256 verified, then cached.

Datasets are immutable and content-addressed: "<name>@<version>", where version is a hash of
every file's path, size and SHA-256. A cached copy is therefore valid forever, two jobs can
never see half-updated data, and re-uploading identical files is a no-op.

This file is ALSO imported by the Master's server (shared helpers), and its source text is
shipped to every Ray worker and installed as the module ``tensorswarm`` there, so workers need
nothing besides the portable Python. Standard library + requests only.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote, urlparse

CLIENT_VERSION = "1"
MANIFEST = "manifest.json"
READY = ".ready"
VERSION_LEN = 12
CHUNK = 1 << 20
ARCHIVE_SUFFIXES = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_WIN_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
_BAD_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')

MASTER_API = os.environ.get("TENSORSWARM_MASTER_API", "").rstrip("/")


class DatasetError(RuntimeError):
    """Anything that stops a dataset from being made available. The message says what to do."""


def configure(master_api: Optional[str] = None) -> None:
    """Set the Master API URL (done automatically inside TensorSwarm notebooks and jobs)."""
    global MASTER_API
    if master_api:
        MASTER_API = master_api.rstrip("/")
        os.environ["TENSORSWARM_MASTER_API"] = MASTER_API


# ==============================================================================
# Locations (identical on every PC, independent of the Windows user)
# ==============================================================================

def data_root() -> Path:
    env = os.environ.get("TENSORSWARM_DATA_DIR")
    if env:
        return Path(env)
    if os.name == "nt":
        return Path(os.environ.get("ProgramData") or r"C:\ProgramData") / "TensorSwarm" / "datasets"
    return Path.home() / ".tensorswarm" / "datasets"


def store_dir() -> Path:
    """Authoritative copies (Master) and USB-seeded copies (any PC)."""
    return data_root() / "store"


def cache_dir() -> Path:
    """Copies pulled from the Master, and extracted archives."""
    return data_root() / "cache"


def downloads_dir() -> Path:
    """ts.download() / ts.hf_download() internet cache."""
    return data_root() / "downloads"


def _fs(p: Path) -> str:
    """Path string safe for long paths on Windows (\\\\?\\ prefix), even when LongPathsEnabled is off."""
    s = str(Path(p).absolute())
    if os.name == "nt" and len(s) > 240 and not s.startswith("\\\\?\\"):
        return "\\\\?\\" + s
    return s


# ==============================================================================
# Names, versions, manifests (shared with the Master)
# ==============================================================================

def normalize_name(name: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", (name or "").strip().lower()).strip("-._")
    if not _NAME_RE.match(s):
        raise ValueError("Dataset name must contain letters or digits (a-z, 0-9, '.', '_', '-'; max 64).")
    return s


def parse_ref(ref: str) -> Tuple[str, Optional[str]]:
    """'mnist' -> ('mnist', None); 'mnist@3f2a9c1b7d0e' -> ('mnist', '3f2a9c1b7d0e')."""
    ref = (ref or "").strip()
    name, _, ver = ref.partition("@")
    name = normalize_name(name)
    ver = ver.strip().lower() or None
    if ver is not None and not re.fullmatch(r"[0-9a-f]{4,64}", ver):
        raise ValueError(f"Bad dataset version in {ref!r}: expected hex digits after '@'.")
    return name, ver


def safe_relpath(path: str) -> str:
    """Validate a relative file path inside a dataset (as sent by a browser or found in a folder).
    Returns it with forward slashes. Rejects traversal, drive letters and names Windows can't store."""
    p = (path or "").replace("\\", "/").strip("/")
    parts = p.split("/")
    if not p or len(p) > 400:
        raise ValueError(f"Bad file path {path!r}.")
    for part in parts:
        if part in ("", ".", "..") or _BAD_CHARS.search(part) or part.endswith((" ", ".")):
            raise ValueError(f"Bad file path {path!r}: '{part}' is not allowed on Windows.")
        if part.split(".")[0].lower() in _WIN_RESERVED:
            raise ValueError(f"Bad file path {path!r}: '{part}' is a reserved Windows name.")
    return "/".join(parts)


def is_archive_name(path: str) -> bool:
    return path.lower().endswith(ARCHIVE_SUFFIXES)


def compute_version(files: Iterable[Dict[str, Any]], archive: bool) -> str:
    h = hashlib.sha256()
    for f in sorted(files, key=lambda f: f["path"]):
        h.update(f"{f['path']}\t{int(f['size'])}\t{f['sha256']}\n".encode())
    h.update(b"archive" if archive else b"files")
    return h.hexdigest()[:VERSION_LEN]


def sha256_file(path: Path, on_bytes: Optional[Callable[[int], None]] = None) -> str:
    h = hashlib.sha256()
    with open(_fs(path), "rb") as f:
        while True:
            b = f.read(4 * CHUNK)
            if not b:
                break
            h.update(b)
            if on_bytes:
                on_bytes(len(b))
    return h.hexdigest()


def write_json_atomic(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(_fs(tmp), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(_fs(tmp), _fs(path))


def read_manifest(folder: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(_fs(folder / MANIFEST), encoding="utf-8") as f:
            m = json.load(f)
        if isinstance(m, dict) and m.get("id") and m.get("version") and isinstance(m.get("files"), list):
            return m
    except (OSError, ValueError):
        pass
    return None


def data_subdir(manifest: Dict[str, Any]) -> str:
    """Inside a dataset folder, user data lives in files\\ (plain files) or data\\ (extracted archive)."""
    return "data" if manifest.get("archive") else "files"


def files_present(folder: Path, manifest: Dict[str, Any]) -> bool:
    """Cheap integrity check: every file exists with the right size (hashes were checked on arrival)."""
    for f in manifest["files"]:
        try:
            if os.path.getsize(_fs(folder / "files" / f["path"])) != int(f["size"]):
                return False
        except OSError:
            return False
    return True


def build_dataset(staging_files: Path, name: str, description: str = "", source: Optional[Dict[str, Any]] = None,
                  extract: Optional[bool] = None, on_bytes: Optional[Callable[[int], None]] = None) -> Dict[str, Any]:
    """Seal a staging folder (on the same disk as the store) into an immutable store entry.
    Hashes every file, derives the version, and MOVES the folder into store\\<name>@<version>
    with one rename, so a reader never sees a half-written dataset. Identical content that is
    already stored is de-duplicated (the staging copy is discarded). Returns the manifest.

    extract=None: a dataset that is a single .zip/.tar(.gz) archive is extracted on the workers
    (one big file transfers far faster than thousands of small ones); False keeps it as a file."""
    name = normalize_name(name)
    staging_files = Path(staging_files)
    files: List[Dict[str, Any]] = []
    for root, _dirs, fnames in os.walk(_fs(staging_files)):
        for fn in fnames:
            full = Path(root) / fn
            rel = safe_relpath(os.path.relpath(full, _fs(staging_files)))
            files.append({"path": rel, "size": os.path.getsize(full), "full": full})
    if not files:
        raise DatasetError("The dataset has no files.")
    for f in files:
        f["sha256"] = sha256_file(f.pop("full"), on_bytes)
    files.sort(key=lambda f: f["path"])
    archive = (len(files) == 1 and is_archive_name(files[0]["path"])) if extract is None else bool(extract)
    if archive and not (len(files) == 1 and is_archive_name(files[0]["path"])):
        raise DatasetError("extract=True needs exactly one .zip / .tar / .tar.gz file.")
    version = compute_version(files, archive)
    dsid = f"{name}@{version}"
    extracted = None
    if archive and files[0]["path"].lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(_fs(staging_files / files[0]["path"])) as z:
                extracted = sum(i.file_size for i in z.infolist())
        except zipfile.BadZipFile as exc:
            raise DatasetError(f"{files[0]['path']} is not a valid zip file ({exc}).") from None
    m = {
        "format": 1, "id": dsid, "name": name, "version": version,
        "description": (description or "").strip()[:500],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source or {"type": "upload"},
        "archive": archive, "extracted_bytes": extracted,
        "file_count": len(files), "total_bytes": sum(f["size"] for f in files),
        "files": files,
    }
    target = store_dir() / dsid
    if read_manifest(target) and files_present(target, m):
        shutil.rmtree(_fs(staging_files), ignore_errors=True)
        return read_manifest(target)                          # same content already stored
    tmp = store_dir() / f".{dsid}.{os.getpid()}.tmp"
    shutil.rmtree(_fs(tmp), ignore_errors=True)
    tmp.mkdir(parents=True)
    os.replace(_fs(staging_files), _fs(tmp / "files"))
    write_json_atomic(tmp / MANIFEST, m)
    shutil.rmtree(_fs(target), ignore_errors=True)           # a broken leftover, never a valid one
    os.replace(_fs(tmp), _fs(target))
    return m


# ==============================================================================
# Small infrastructure: file lock, HTTP, progress
# ==============================================================================

class FileLock:
    """Inter-process lock (two notebooks on one PC syncing the same dataset). The OS releases it
    if the process dies, so a crash never leaves a stale lock behind."""

    def __init__(self, path: Path, label: str = ""):
        self.path, self.label, self._f = path, label, None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._f = open(_fs(self.path), "a+b")
        announced = False
        while True:
            try:
                self._f.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self._f.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self._f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if not announced:
                    _say(f"{self.label}: another process on this PC is busy with it, waiting ...")
                    announced = True
                time.sleep(0.5)

    def __exit__(self, *exc):
        try:
            self._f.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self._f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._f.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self._f.close()


def _say(msg: str) -> None:
    print(f"[tensorswarm] {msg}", flush=True)


def _session(internet: bool = False):
    import requests

    s = requests.Session()
    # Master traffic goes straight over Tailscale; a lab's system proxy would break it.
    # Internet downloads DO honour the proxy settings (some labs only reach the web through one).
    s.trust_env = internet
    s.headers["User-Agent"] = f"tensorswarm-client/{CLIENT_VERSION}"
    return s


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n} B"


class _Progress:
    def __init__(self, label: str, total: int, verbose: bool):
        self.label, self.total, self.verbose = label, max(0, int(total)), verbose
        self.done = 0
        self._lock = threading.Lock()
        self._t0 = self._last = time.time()
        self._base = 0

    def start_from(self, already: int):
        with self._lock:
            self.done = self._base = already

    def add(self, n: int):
        with self._lock:
            self.done += n
            now = time.time()
            if self.verbose and now - self._last >= 3:
                self._last = now
                rate = (self.done - self._base) / max(1e-6, now - self._t0)
                pct = f" ({100 * self.done / self.total:.0f}%)" if self.total else ""
                eta = f", ETA {int((self.total - self.done) / rate)} s" if rate > 0 and self.total else ""
                _say(f"{self.label}: {_human(self.done)} / {_human(self.total)}{pct} at {_human(rate)}/s{eta}")

    def finish(self, what: str):
        if self.verbose:
            dt = max(1e-6, time.time() - self._t0)
            moved = self.done - self._base
            _say(f"{self.label}: {what} {_human(moved)} in {dt:.1f} s ({_human(moved / dt)}/s)")


def _check_space(folder: Path, need: int, what: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(_fs(folder)).free
    margin = 512 * 1024 ** 2
    if free < need + margin:
        raise DatasetError(
            f"Not enough disk space on this PC for {what}: needs {_human(need)} (+512 MB margin), "
            f"{_human(free)} free on {folder.anchor or folder}. Free space, or run ts.evict() to clear old cached datasets.")


def _fetch(sess, url: str, dest: Path, size: Optional[int], sha256: Optional[str],
           progress: _Progress, headers: Optional[Dict[str, str]] = None, attempts: int = 8) -> None:
    """Resumable, verified download of one file. Partial data survives dropped Wi-Fi, a sleeping
    laptop or a restarted runtime: the next call continues from the last byte (HTTP Range)."""
    import requests

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    last_err: Optional[BaseException] = None
    for attempt in range(1, attempts + 1):
        have = os.path.getsize(_fs(part)) if os.path.exists(_fs(part)) else 0
        if size is not None and have > size:
            os.remove(_fs(part))
            have = 0
        if size is None or have < size:
            hdrs = dict(headers or {})
            if have:
                hdrs["Range"] = f"bytes={have}-"
            try:
                with sess.get(url, headers=hdrs, stream=True, timeout=(10, 60)) as r:
                    if r.status_code == 416 and have:          # we already have everything
                        pass
                    elif r.status_code in (200, 206):
                        if r.status_code == 200 and have:      # server ignored Range: start over
                            progress.add(-have)
                            have = 0
                        if size is None and r.headers.get("Content-Length") and r.status_code == 200:
                            size = int(r.headers["Content-Length"])
                            progress.total = progress.total or size
                        with open(_fs(part), "ab" if have else "wb") as f:
                            for chunk in r.iter_content(CHUNK):
                                if chunk:
                                    f.write(chunk)
                                    progress.add(len(chunk))
                    elif r.status_code in (401, 403, 404, 410):
                        raise DatasetError(f"{url}: HTTP {r.status_code} {r.reason}. "
                                           + ("Check the URL / access token." if r.status_code != 404 else "Not found."))
                    else:
                        raise requests.HTTPError(f"HTTP {r.status_code} {r.reason}")
            except DatasetError:
                raise
            except (requests.RequestException, OSError) as exc:
                last_err = exc
                wait = min(30, 2 ** attempt)
                _say(f"{dest.name}: transfer interrupted ({type(exc).__name__}); retry {attempt}/{attempts} in {wait} s")
                time.sleep(wait)
                continue
        got = os.path.getsize(_fs(part))
        if size is not None and got < size:
            continue                                            # short read: resume
        if sha256 and sha256_file(part) != sha256:
            os.remove(_fs(part))
            progress.add(-got)
            last_err = DatasetError(f"{dest.name}: SHA-256 mismatch (corrupted transfer)")
            _say(f"{dest.name}: checksum mismatch, downloading again")
            continue
        os.replace(_fs(part), _fs(dest))
        return
    raise DatasetError(f"Could not download {dest.name} after {attempts} attempts: {last_err}. "
                       "The partial file is kept; running the cell again resumes it.")


def _safe_member(name: str) -> Optional[str]:
    """Archive member -> safe relative path (None = skip). Blocks zip-slip and absolute paths."""
    p = name.replace("\\", "/")
    if p.endswith("/") or not p.strip("/"):
        return None
    parts = [x for x in p.split("/") if x not in ("", ".")]
    if not parts or ".." in parts or ":" in parts[0]:
        return None
    if os.name == "nt":
        parts = [_BAD_CHARS.sub("_", x).rstrip(" .") or "_" for x in parts]
    return "/".join(parts)


def extract_archive(archive: Path, target: Path, label: str = "", verbose: bool = True) -> None:
    """Extract into target atomically (a .tmp folder renamed at the end)."""
    tmp = target.with_name(target.name + ".tmp")
    shutil.rmtree(_fs(tmp), ignore_errors=True)
    tmp.mkdir(parents=True)
    lower = archive.name.lower()
    t0 = time.time()
    if lower.endswith(".zip"):
        with zipfile.ZipFile(_fs(archive)) as z:
            members = [m for m in z.infolist() if not m.is_dir()]
            _check_space(target.parent, sum(m.file_size for m in members), f"extracting {archive.name}")
            for i, m in enumerate(members, 1):
                rel = _safe_member(m.filename)
                if rel is None:
                    continue
                out = tmp / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                with z.open(m) as src, open(_fs(out), "wb") as dst:
                    shutil.copyfileobj(src, dst, CHUNK)
                if verbose and i % 5000 == 0:
                    _say(f"{label}: extracted {i:,} / {len(members):,} files")
    else:
        with tarfile.open(_fs(archive)) as t:
            members = t.getmembers()
            _check_space(target.parent, sum(m.size for m in members if m.isfile()), f"extracting {archive.name}")
            try:
                t.extractall(_fs(tmp), filter="data")         # safe mode (Python 3.10.12+)
            except TypeError:                                  # older Python: filter manually
                safe = [m for m in members if (m.isfile() or m.isdir()) and _safe_member(m.name)]
                t.extractall(_fs(tmp), members=safe)
    shutil.rmtree(_fs(target), ignore_errors=True)
    os.replace(_fs(tmp), _fs(target))
    if verbose:
        _say(f"{label}: extracted {archive.name} in {time.time() - t0:.1f} s")


# ==============================================================================
# Talking to the Master
# ==============================================================================

class _Unreachable(Exception):
    pass


def _master_json(path: str, timeout: float = 15, retries: int = 3) -> Any:
    import requests

    if not MASTER_API:
        raise _Unreachable("no Master API configured (TENSORSWARM_MASTER_API)")
    sess = _session()
    last: Optional[BaseException] = None
    for attempt in range(retries):
        try:
            r = sess.get(MASTER_API + path, timeout=timeout)
            if r.status_code == 404:
                try:
                    detail = r.json().get("detail")
                except ValueError:
                    detail = r.text
                raise DatasetError(str(detail or f"{path}: not found on the Master"))
            r.raise_for_status()
            return r.json()
        except DatasetError:
            raise
        except requests.RequestException as exc:
            last = exc
            time.sleep(1 + attempt * 2)
    raise _Unreachable(f"{MASTER_API} unreachable: {last}")


def manifest(ref: str) -> Dict[str, Any]:
    """The Master's manifest for 'name' (latest version) or 'name@version'."""
    parse_ref(ref)
    return _master_json(f"/api/v1/datasets/{quote(ref.strip(), safe='@')}/manifest")


def list_datasets() -> List[Dict[str, Any]]:
    """Datasets known to the Master."""
    return _master_json("/api/v1/datasets")


def _local_entries() -> List[Tuple[Dict[str, Any], Path, str]]:
    out = []
    for kind, root in (("cache", cache_dir()), ("store", store_dir())):
        if not root.is_dir():
            continue
        for d in root.iterdir():
            m = read_manifest(d)
            if not m:
                continue
            if kind == "cache" and not (d / READY).exists():
                continue
            if kind == "store" and not files_present(d, m):
                continue
            out.append((m, d, kind))
    return out


def cached() -> List[Dict[str, Any]]:
    """Datasets available on THIS PC without any network transfer."""
    rows = []
    for m, d, kind in _local_entries():
        rows.append({"id": m["id"], "name": m["name"], "version": m["version"], "location": kind,
                     "total_bytes": m.get("total_bytes"), "path": str(d / data_subdir(m)) if kind == "cache" or not m.get("archive") else str(d)})
    return rows


def _usable_path(m: Dict[str, Any]) -> Optional[Path]:
    """Ready-to-use local path for this exact version, without network. None if not local."""
    dsid = m["id"]
    c = cache_dir() / dsid
    cm = read_manifest(c)
    if cm and cm["version"] == m["version"] and (c / READY).exists() and (c / data_subdir(m)).exists():
        return c / data_subdir(m)
    s = store_dir() / dsid
    sm = read_manifest(s)
    if sm and sm["version"] == m["version"] and not m.get("archive") and files_present(s, m):
        return s / "files"                                   # Master PC / USB seed: zero-copy
    return None


def dataset(ref: str, verbose: bool = True) -> Path:
    """Local folder containing the dataset 'name' or 'name@version', synced from the Master if needed.

    Plain uploads: the folder holds the files exactly as uploaded (ts.dataset("iris") / "iris.csv").
    Archive datasets (.zip / .tar.gz): the folder holds the extracted contents.
    If the Master is unreachable, the newest local copy is used (with a warning)."""
    name, ver = parse_ref(ref)
    try:
        m = manifest(ref)
    except _Unreachable as exc:
        local = [(lm, d, k) for lm, d, k in _local_entries()
                 if lm["name"] == name and (ver is None or lm["version"].startswith(ver))]
        if not local:
            raise DatasetError(f"Dataset '{ref}' is not on this PC and the Master can't be reached ({exc}).") from None
        lm, d, kind = max(local, key=lambda e: str(e[0].get("created_at", "")))
        _say(f"WARNING: Master unreachable, using the local copy {lm['id']} ({kind}).")
        p = _usable_path(lm)
        if p is not None:
            return p
        m = lm                                                # archive in store: extract below
    return _ensure_local(m, verbose)


def _ensure_local(m: Dict[str, Any], verbose: bool = True) -> Path:
    dsid, label = m["id"], m["id"]
    p = _usable_path(m)
    if p is not None:
        return p
    c = cache_dir() / dsid
    with FileLock(cache_dir() / f"{dsid}.lock", label):
        p = _usable_path(m)                                   # someone else finished meanwhile
        if p is not None:
            return p
        c.mkdir(parents=True, exist_ok=True)
        (c / READY).unlink(missing_ok=True)
        store = store_dir() / dsid
        sm = read_manifest(store)
        if sm and sm["version"] == m["version"] and files_present(store, m):
            src_files = store / "files"                       # local archive (Master PC / USB seed)
        else:
            src_files = c / "files"
            _pull(m, src_files, verbose)
        if m.get("archive"):
            archive = src_files / m["files"][0]["path"]
            extract_archive(archive, c / "data", label, verbose)
            if src_files == c / "files":                      # extracted: drop the downloaded archive
                shutil.rmtree(_fs(src_files), ignore_errors=True)
        write_json_atomic(c / MANIFEST, m)
        write_json_atomic(c / READY, {"version": m["version"], "at": time.time()})
        return c / data_subdir(m)


def _pull(m: Dict[str, Any], dest: Path, verbose: bool) -> None:
    if not MASTER_API:
        raise DatasetError("No Master API configured: set TENSORSWARM_MASTER_API or call ts.configure(url).")
    todo, have = [], 0
    for f in m["files"]:
        target = dest / f["path"]
        if os.path.exists(_fs(target)) and os.path.getsize(_fs(target)) == int(f["size"]):
            have += int(f["size"])                            # finished in an earlier, interrupted sync
        else:
            todo.append(f)
    total = int(m.get("total_bytes") or sum(int(f["size"]) for f in m["files"]))
    partial = sum(os.path.getsize(_fs(dest / (f["path"] + ".part"))) for f in todo
                  if os.path.exists(_fs(dest / (f["path"] + ".part"))))
    _check_space(dest, total - have - partial, f"dataset {m['id']}")
    prog = _Progress(m["id"], total, verbose)
    prog.start_from(have + partial)
    if verbose and todo:
        _say(f"{m['id']}: fetching {len(todo):,} file(s), {_human(total - have - partial)} from the Master ...")
    sess = _session()

    def one(f):
        url = f"{MASTER_API}/api/v1/datasets/{quote(m['id'], safe='@')}/files/{quote(f['path'])}"
        _fetch(sess, url, dest / f["path"], int(f["size"]), f["sha256"], prog)

    if len(todo) == 1:
        one(todo[0])
    elif todo:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for fut in [pool.submit(one, f) for f in todo]:
                fut.result()
    if todo:
        prog.finish("received")


def upload(path, name: str, description: str = "", extract: Optional[bool] = None, verbose: bool = True) -> Dict[str, Any]:
    """Publish a local file or folder (e.g. a trained checkpoint, predictions) to the Master as a
    new dataset version, so any notebook on any PC can load it with ts.dataset(name).
    Uses the same resumable chunked protocol as the browser. Returns the dataset summary."""
    import requests

    src = Path(path)
    if not src.exists():
        raise DatasetError(f"{src} does not exist.")
    if not MASTER_API:
        raise DatasetError("No Master API configured.")
    if src.is_file():
        entries = [(src.name, src)]
    else:
        entries = [(p.relative_to(src).as_posix(), p) for p in sorted(src.rglob("*")) if p.is_file()]
    if not entries:
        raise DatasetError(f"{src} contains no files.")
    sess = _session()
    body = {"name": name, "description": description, "extract": extract,
            "files": [{"path": rel, "size": p.stat().st_size} for rel, p in entries]}
    r = sess.post(f"{MASTER_API}/api/v1/datasets/uploads", json=body, timeout=30)
    if r.status_code >= 400:
        raise DatasetError(f"Upload refused: {r.json().get('detail', r.text) if r.headers.get('content-type', '').startswith('application/json') else r.text}")
    op = r.json()
    op_id, chunk = op["op_id"], int(op.get("chunk_size") or 8 * CHUNK)
    total = sum(p.stat().st_size for _, p in entries)
    prog = _Progress(f"upload {name}", total, verbose)
    for index, (rel, p) in enumerate(entries):
        size, offset = p.stat().st_size, 0
        failures = 0
        while offset < size:
            with open(_fs(p), "rb") as f:
                f.seek(offset)
                data = f.read(chunk)
            try:
                resp = sess.put(f"{MASTER_API}/api/v1/datasets/uploads/{op_id}/files/{index}",
                                params={"offset": offset}, data=data, timeout=(10, 120),
                                headers={"Content-Type": "application/octet-stream"})
            except requests.RequestException as exc:
                failures += 1
                if failures > 8:
                    raise DatasetError(f"Upload of {rel} failed repeatedly: {exc}") from None
                time.sleep(min(30, 2 ** failures))
                continue
            if resp.status_code == 409 and "expected_offset" in resp.text:
                offset = int(resp.json()["expected_offset"])     # resync after a lost reply
                continue
            if resp.status_code >= 400:
                raise DatasetError(f"Upload of {rel} failed: HTTP {resp.status_code} {resp.text[:300]}")
            prog.add(len(data))
            offset += len(data)
            failures = 0
    r = sess.post(f"{MASTER_API}/api/v1/datasets/uploads/{op_id}/complete", timeout=30)
    if r.status_code >= 400:
        raise DatasetError(f"Finishing the upload failed: {r.text[:300]}")
    while True:                                                    # Master hashes the files
        st = sess.get(f"{MASTER_API}/api/v1/datasets/uploads/{op_id}", timeout=30).json()
        if st["status"] == "done":
            prog.finish("uploaded")
            if verbose:
                _say(f"published {st['dataset_id']}  ->  ts.dataset(\"{st['dataset_id'].split('@')[0]}\")")
            return _master_json(f"/api/v1/datasets/{quote(st['dataset_id'], safe='@')}")
        if st["status"] in ("error", "cancelled"):
            raise DatasetError(f"The Master could not store the upload: {st.get('error')}")
        time.sleep(1)


# ==============================================================================
# Internet downloads on the worker (Hugging Face, Kaggle/S3/public URLs)
# ==============================================================================

def _expand_hf(url: str) -> str:
    """hf://datasets/<owner>/<repo>/<path>  ->  https://huggingface.co/datasets/<owner>/<repo>/resolve/main/<path>
    (hf://<owner>/<repo>/<path> for model repos)."""
    if not url.startswith("hf://"):
        return url
    rest = url[5:].strip("/")
    prefix = ""
    if rest.startswith(("datasets/", "spaces/")):
        prefix, rest = rest.split("/", 1)
        prefix += "/"
    parts = rest.split("/")
    if len(parts) < 3:
        raise ValueError("hf:// URLs look like hf://datasets/<owner>/<repo>/<file path>")
    repo, rev = "/".join(parts[:2]), "main"
    if "@" in repo:
        repo, rev = repo.split("@", 1)
    return f"https://huggingface.co/{prefix}{repo}/resolve/{rev}/{'/'.join(parts[2:])}"


def download(url: str, filename: Optional[str] = None, sha256: Optional[str] = None,
             extract: bool = False, headers: Optional[Dict[str, str]] = None, verbose: bool = True) -> Path:
    """Download a URL on THIS worker, cached in ...\\datasets\\downloads (resumable, atomic).
    Returns the file, or the extracted folder with extract=True. Pass sha256= to verify.
    Use this when the lab's internet is faster than the link to the Master."""
    url = _expand_hf(url)
    key = hashlib.sha256(url.encode()).hexdigest()[:16]
    folder = downloads_dir() / key
    fname = filename or os.path.basename(urlparse(url).path) or "download"
    fname = _safe_member(fname) or "download"
    dest, data = folder / fname, folder / "data"
    marker = folder / READY
    if marker.exists() and dest.exists() and (not extract or data.exists()):
        return data if extract else dest
    with FileLock(downloads_dir() / f"{key}.lock", fname):
        if not (marker.exists() and dest.exists()):
            folder.mkdir(parents=True, exist_ok=True)
            prog = _Progress(fname, 0, verbose)
            if verbose:
                _say(f"downloading {url}")
            _fetch(_session(internet=True), url, dest, None, sha256, prog, headers=headers)
            prog.finish("downloaded")
            write_json_atomic(folder / MANIFEST, {"url": url, "file": fname, "sha256": sha256, "at": time.time()})
            write_json_atomic(marker, {"at": time.time()})
        if extract and not data.exists():
            extract_archive(dest, data, fname, verbose)
    return data if extract else dest


def hf_download(repo_id: str, filename: str, repo_type: str = "dataset", revision: str = "main",
                token: Optional[str] = None, verbose: bool = True) -> Path:
    """One file from a Hugging Face repo, without needing the huggingface_hub package.
    For private/gated repos pass token= (or set HF_TOKEN)."""
    prefix = {"dataset": "datasets/", "model": "", "space": "spaces/"}[repo_type]
    url = f"https://huggingface.co/{prefix}{repo_id}/resolve/{revision}/{quote(filename)}"
    token = token or os.environ.get("HF_TOKEN")
    return download(url, headers={"Authorization": f"Bearer {token}"} if token else None, verbose=verbose)


# ==============================================================================
# Parallel compute on the swarm's CPUs (and GPUs): ts.map / ts.cluster
# ==============================================================================

def _ray():
    try:
        import ray
    except ImportError as exc:
        raise RuntimeError("ts.map / ts.cluster need Ray: run them inside a TensorSwarm notebook or job.") from exc
    if not ray.is_initialized():
        raise RuntimeError("ts.map / ts.cluster run inside a TensorSwarm notebook or job (Ray is not initialized here).")
    return ray


def cluster() -> Dict[str, Any]:
    """CPU cores and GPUs of every PC in the swarm, and how many are free right now.

        ts.cluster()["cpus_free"]   # e.g. 22.0
    """
    ray = _ray()
    pcs: Dict[str, Dict[str, Any]] = {}
    for n in ray.nodes():
        if not n.get("Alive"):
            continue
        ip = n.get("NodeManagerAddress")
        r = n.get("Resources", {})
        pc = pcs.setdefault(ip, {"ip": ip, "hostname": n.get("NodeManagerHostname"), "cpus": 0.0, "gpus": 0.0})
        pc["cpus"] += r.get("CPU", 0.0)
        pc["gpus"] += r.get("GPU", 0.0)
    total, free = ray.cluster_resources(), ray.available_resources()
    return {"pcs": sorted(pcs.values(), key=lambda p: p["ip"] or ""),
            "cpus_total": total.get("CPU", 0.0), "cpus_free": free.get("CPU", 0.0),
            "gpus_total": total.get("GPU", 0.0), "gpus_free": free.get("GPU", 0.0)}


def map(fn: Callable[[Any], Any], items: Iterable[Any], num_cpus: float = 1, num_gpus: float = 0,
        retries: int = 1, verbose: bool = True) -> List[Any]:
    """Run ``fn(item)`` for every item IN PARALLEL on the free CPU cores of every PC in the
    swarm (PCs without a GPU included) and return the results in input order.

        def score(lr):                     # any function defined in the notebook
            return train_small_model(lr)
        results = ts.map(score, [1e-4, 3e-4, 1e-3, 3e-3])

    Each call reserves ``num_cpus`` cores (and ``num_gpus`` GPU share, default 0) on whichever
    PC has them free. ``fn`` may use ``ts.dataset(...)``: the data is copied to each PC once.
    Results travel back over the network, so return small values (numbers, dicts), not tensors
    of gigabytes. An exception in any call cancels the rest and is raised here.
    """
    ray = _ray()
    from ray import cloudpickle

    items = list(items)
    if not items:
        return []
    source, api = globals().get("_TS_SOURCE"), MASTER_API
    threads = max(1, int(num_cpus or 1))

    def _ts_map_task(payload, item, source, api, threads):
        # Runs on any PC. Install the `tensorswarm` module there first, so fn (and anything
        # it pickled by reference, like `ts`) can be loaded.
        import os
        import socket
        import sys
        import types
        os.environ["OMP_NUM_THREADS"] = os.environ["MKL_NUM_THREADS"] = str(threads)
        if source:
            mod = sys.modules.get("tensorswarm")
            if mod is None or mod.__dict__.get("_TS_SOURCE") != source:
                mod = types.ModuleType("tensorswarm", "TensorSwarm client")
                mod.__file__ = "tensorswarm_client.py"
                sys.modules["tensorswarm"] = mod
                exec(compile(source, "tensorswarm_client.py", "exec"), mod.__dict__)
                mod.__dict__["_TS_SOURCE"] = source
            mod._activate(api)
        if "torch" in sys.modules:
            try:
                sys.modules["torch"].set_num_threads(threads)
            except Exception:
                pass
        from ray import cloudpickle as _cp
        return socket.gethostname(), _cp.loads(payload)(item)

    if verbose:
        try:
            c = cluster()
            need = len(items) * float(num_cpus or 0)
            print(f"[ts.map] {len(items)} calls x {num_cpus:g} core(s){f' + {num_gpus:g} GPU' if num_gpus else ''} "
                  f"on {len(c['pcs'])} PC(s), {c['cpus_free']:g} of {c['cpus_total']:g} cores free now"
                  + ("" if c["cpus_free"] >= min(need, num_cpus or 0) else " (waiting for a free core)"), flush=True)
        except Exception:
            pass

    remote = ray.remote(num_cpus=num_cpus, num_gpus=num_gpus, max_retries=retries)(_ts_map_task)
    payload_ref = ray.put(cloudpickle.dumps(fn))
    refs = [remote.remote(payload_ref, x, source, api, threads) for x in items]
    position = {r: i for i, r in enumerate(refs)}
    results: List[Any] = [None] * len(items)
    per_host: Dict[str, int] = {}
    pending, done, t0, last = list(refs), 0, time.time(), 0.0
    try:
        while pending:
            ready, pending = ray.wait(pending, num_returns=len(pending), timeout=0.5)
            for r in ready:
                host, value = ray.get(r)
                results[position[r]] = value
                per_host[host] = per_host.get(host, 0) + 1
                done += 1
            if verbose and ready and (time.time() - last > 2 or not pending):
                last = time.time()
                print(f"[ts.map] {done}/{len(items)} done ({time.time() - t0:.1f} s)", flush=True)
    except BaseException:
        for r in pending:
            try:
                ray.cancel(r)
            except Exception:
                pass
        raise
    if verbose:
        spread = ", ".join(f"{h}: {n}" for h, n in sorted(per_host.items()))
        print(f"[ts.map] finished in {time.time() - t0:.1f} s on {len(per_host)} PC(s) ({spread})", flush=True)
    return results


# ==============================================================================
# Colab-style automatic package install
# ==============================================================================

# import name -> pip name, where they differ
PIP_NAMES = {
    "sklearn": "scikit-learn", "cv2": "opencv-python-headless", "PIL": "pillow", "yaml": "pyyaml",
    "bs4": "beautifulsoup4", "skimage": "scikit-image", "dateutil": "python-dateutil", "dotenv": "python-dotenv",
    "Crypto": "pycryptodome", "jwt": "PyJWT", "attr": "attrs", "serial": "pyserial", "umap": "umap-learn",
    "docx": "python-docx", "pptx": "python-pptx", "fitz": "pymupdf", "Levenshtein": "python-Levenshtein",
    "win32api": "pywin32", "win32con": "pywin32", "magic": "python-magic", "sentencepiece": "sentencepiece",
}
_AUTO_INSTALL_FAILED: set = set()          # don't retry a failed package on every cell


def missing_packages(code: str) -> List[str]:
    """pip names for modules the code imports that are not installed on this PC."""
    import ast
    import importlib.util

    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []                                         # the cell will report the error itself
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module.split(".")[0])
    out = []
    for name in sorted(names):
        if name in sys.stdlib_module_names or name in sys.builtin_module_names or name in ("tensorswarm", "__future__"):
            continue
        try:
            if importlib.util.find_spec(name) is not None:
                continue
        except (ImportError, ValueError):
            pass
        pip_name = PIP_NAMES.get(name, name)
        if pip_name not in out and pip_name not in _AUTO_INSTALL_FAILED:
            out.append(pip_name)
    return out


def ensure_packages(code: str) -> List[str]:
    """Like Colab: pip-install whatever `code` imports but this PC lacks, before it runs.
    Already-installed packages are pinned (pip constraints), so this never up- or downgrades
    torch, ray, numpy, ... and can't break the environment. Off: TENSORSWARM_AUTO_INSTALL=0."""
    import subprocess
    from importlib import invalidate_caches, metadata

    if os.environ.get("TENSORSWARM_AUTO_INSTALL", "1") == "0":
        return []
    pkgs = missing_packages(code)
    if not pkgs:
        return []
    root = data_root().parent
    root.mkdir(parents=True, exist_ok=True)
    with FileLock(root / "pip.lock", "package install"):  # two runtimes on one PC: one pip at a time
        pkgs = missing_packages(code)                      # the other may have installed them
        if not pkgs:
            return []
        pins = sorted({f"{d.metadata['Name']}=={d.version}" for d in metadata.distributions() if d.metadata["Name"]})
        constraints = root / f"pip-constraints-{os.getpid()}.txt"
        constraints.write_text("\n".join(pins) + "\n", encoding="utf-8")
        import socket
        _say(f"installing {', '.join(pkgs)} on {socket.gethostname()} (first use on this PC only) ...")
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
               "--progress-bar", "off", "-c", str(constraints), *pkgs]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                text=True, errors="replace")
        try:
            tail: List[str] = []
            for line in proc.stdout:                       # stream pip's progress into the cell
                line = line.rstrip()
                tail = (tail + [line])[-15:]
                if line.startswith(("Collecting", "Downloading", "Successfully", "ERROR")):
                    print(f"  {line}", flush=True)
            code_ = proc.wait(timeout=900)
        finally:
            if proc.poll() is None:
                proc.kill()
            constraints.unlink(missing_ok=True)
        invalidate_caches()
        if code_ != 0:
            _AUTO_INSTALL_FAILED.update(pkgs)
            hint = "\n    ".join(tail[-6:])
            _say(f"could not install {', '.join(pkgs)} (no internet on this PC, a typo, or it would need a "
                 f"different torch/numpy version). The import will fail below. pip said:\n    {hint}")
            return []
        _say(f"installed {', '.join(pkgs)}")
        return pkgs


# ==============================================================================
# Housekeeping
# ==============================================================================

def _du(p: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(_fs(p)):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def evict(ref: Optional[str] = None, downloads: bool = False) -> int:
    """Delete cached copies on THIS PC (never the Master's store). ref=None clears every cached
    dataset; downloads=True also clears ts.download() files. Returns bytes freed."""
    freed = 0
    root = cache_dir()
    if root.is_dir():
        name, ver = parse_ref(ref) if ref else (None, None)
        for d in list(root.iterdir()):
            if not d.is_dir():
                continue
            m = read_manifest(d)
            dname = (m or {}).get("name") or d.name.split("@")[0]
            dver = (m or {}).get("version") or d.name.partition("@")[2]
            if name and (dname != name or (ver and not dver.startswith(ver))):
                continue
            try:
                with FileLock(root / f"{d.name}.lock", d.name):
                    freed += _du(d)
                    shutil.rmtree(_fs(d), ignore_errors=True)
            except OSError:
                pass
    if downloads and downloads_dir().is_dir():
        freed += _du(downloads_dir())
        shutil.rmtree(_fs(downloads_dir()), ignore_errors=True)
    return freed


def info() -> Dict[str, Any]:
    root = data_root()
    usage = shutil.disk_usage(_fs(root if root.exists() else Path(root.anchor or ".")))
    return {"master_api": MASTER_API, "data_root": str(root), "free_bytes": usage.free,
            "cached": cached(), "client_version": CLIENT_VERSION}


# ==============================================================================
# Installing this file as the `tensorswarm` module on a Ray worker
# ==============================================================================

def _activate(master_api: Optional[str]) -> None:
    """Called on the worker right after the Master's loader (server._install_ts_client) runs
    this source as the module `tensorswarm`. Points the Hugging Face / torch hub caches at the
    shared, user-independent folder so downloads are reused by every runtime on this PC."""
    configure(master_api)
    base = data_root().parent / "cache"
    os.environ.setdefault("HF_HOME", str(base / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(base / "torch"))
