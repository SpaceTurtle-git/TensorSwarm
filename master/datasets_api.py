"""
TensorSwarm dataset service (Master side), mounted by server.py.

    Browser ──chunked, resumable PUTs──►  Master store  ──HTTP Range pulls──►  worker cache
    URL / Hugging Face ──Master downloads once──►  Master store                   ▲
    USB stick (install.cmd seeds store\\ on every PC) ─────────────────────────────┘ zero network

Storage (same path on every PC, see tensorswarm_client.data_root()):
    store\\<name>@<version>\\manifest.json + files\\...   immutable, content-addressed datasets
    uploads\\<op_id>\\op.json + files\\...                in-flight uploads / imports (resumable)

Everything is plain files: the catalog is rebuilt by scanning store\\ at start-up, so a Master
restart, a power cut or a USB-seeded folder never needs a database repair.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, Field

import tensorswarm_client as tsc

logger = logging.getLogger("TensorSwarm.Datasets")

CHUNK_SIZE = int(os.getenv("TENSORSWARM_UPLOAD_CHUNK_MB", "8")) * 1024 * 1024
MAX_FILES = 200_000
STALE_OP_HOURS = float(os.getenv("TENSORSWARM_UPLOAD_STALE_HOURS", "48"))
RESERVED_NAMES = {"uploads", "imports", "operations", "rescan", "prefetch", "evict"}
SPACE_MARGIN = 1024 ** 3                                     # keep 1 GB free on the Master

router = APIRouter(prefix="/api/v1/datasets", tags=["Datasets"])

# Set by server.py: dataset id -> [{"ip":..., "hostname":..., "location": "cache"|"store"}]
hooks: Dict[str, Callable[..., Any]] = {}


def uploads_dir() -> Path:
    return tsc.data_root() / "uploads"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ==============================================================================
# Catalog
# ==============================================================================

class Catalog:
    def __init__(self):
        self._items: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def scan(self) -> int:
        root = tsc.store_dir()
        root.mkdir(parents=True, exist_ok=True)
        found: Dict[str, Dict[str, Any]] = {}
        for d in root.iterdir():
            if not d.is_dir() or d.name.startswith("."):
                continue
            m = tsc.read_manifest(d)
            if not m or m.get("id") != d.name:
                logger.warning("Ignoring %s: no valid manifest.json", d)
                continue
            if not tsc.files_present(d, m):
                logger.warning("Ignoring %s: files missing or wrong size (interrupted copy?)", d)
                continue
            found[m["id"]] = m
        with self._lock:
            self._items = found
        return len(found)

    def add(self, m: Dict[str, Any]):
        with self._lock:
            self._items[m["id"]] = m

    def remove(self, dsid: str):
        with self._lock:
            self._items.pop(dsid, None)

    def all(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._items.values())

    def resolve(self, ref: str) -> Dict[str, Any]:
        try:
            name, ver = tsc.parse_ref(ref)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        with self._lock:
            cands = [m for m in self._items.values()
                     if m["name"] == name and (ver is None or m["version"].startswith(ver))]
        if not cands:
            known = sorted({m["name"] for m in self.all()})
            raise HTTPException(status_code=404, detail=(
                f"Dataset '{ref}' not found on the Master. Known datasets: {', '.join(known) or 'none'}. "
                "Upload it in the Datasets tab."))
        if ver is not None and len({m["version"] for m in cands}) > 1:
            raise HTTPException(status_code=400, detail=f"'{ref}' matches several versions; use more digits.")
        return max(cands, key=lambda m: str(m.get("created_at", "")))


catalog = Catalog()


def _summary(m: Dict[str, Any], latest_ids: set) -> Dict[str, Any]:
    files = m.get("files", [])
    out = {k: m.get(k) for k in ("id", "name", "version", "description", "created_at", "source", "archive",
                                 "extracted_bytes", "file_count", "total_bytes")}
    out["latest"] = m["id"] in latest_ids
    out["preview"] = [{"path": f["path"], "size": f["size"]} for f in files[:25]]
    out["nodes"] = hooks["node_presence"](m["id"]) if "node_presence" in hooks else []
    return out


def _latest_ids(items: List[Dict[str, Any]]) -> set:
    best: Dict[str, Dict[str, Any]] = {}
    for m in items:
        cur = best.get(m["name"])
        if cur is None or str(m.get("created_at", "")) > str(cur.get("created_at", "")):
            best[m["name"]] = m
    return {m["id"] for m in best.values()}


# ==============================================================================
# Operations: uploads (browser -> Master) and imports (internet -> Master)
# ==============================================================================

class UploadFile(BaseModel):
    path: str = Field(..., description="Relative path inside the dataset, e.g. 'train/cat/001.jpg'")
    size: int = Field(..., ge=0)


class UploadCreate(BaseModel):
    name: str
    description: str = ""
    files: List[UploadFile]
    extract: Optional[bool] = Field(None, description="None = auto (a single .zip/.tar.gz is extracted on workers)")


class ImportCreate(BaseModel):
    name: str
    url: str = Field(..., description="http(s):// URL, or hf://datasets/<owner>/<repo>/<file>")
    description: str = ""
    filename: Optional[str] = None
    sha256: Optional[str] = None
    extract: Optional[bool] = None
    headers: Optional[Dict[str, str]] = Field(None, description="e.g. Authorization for gated downloads; not stored")


class Ops:
    """In-flight uploads and imports. op.json on disk makes them survive a Master restart."""

    def __init__(self):
        self._ops: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._file_locks: Dict[str, asyncio.Lock] = {}

    # ---- persistence ------------------------------------------------------------------
    def _dir(self, op_id: str) -> Path:
        if not op_id.replace("_", "").isalnum():
            raise HTTPException(status_code=400, detail="Bad operation id.")
        return uploads_dir() / op_id

    def _save(self, op: Dict[str, Any]):
        public = {k: v for k, v in op.items() if not k.startswith("_")}
        tsc.write_json_atomic(self._dir(op["op_id"]) / "op.json", public)

    def get(self, op_id: str) -> Dict[str, Any]:
        with self._lock:
            op = self._ops.get(op_id)
        if op is None:
            d = self._dir(op_id)
            try:
                op = json.loads((d / "op.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raise HTTPException(status_code=404, detail=f"Upload/import '{op_id}' not found (finished, cancelled or expired).")
            if op.get("status") in ("downloading", "finalizing"):
                op["status"] = "interrupted"              # the Master restarted mid-way
            with self._lock:
                self._ops[op_id] = op
        return op

    def public(self, op: Dict[str, Any]) -> Dict[str, Any]:
        out = {k: v for k, v in op.items() if not k.startswith("_")}
        if op["kind"] == "upload" and op["status"] in ("uploading", "interrupted"):
            files_dir = self._dir(op["op_id"]) / "files"
            received = []
            for f in op["files"]:
                p = files_dir / f["path"]
                received.append(os.path.getsize(tsc._fs(p)) if os.path.exists(tsc._fs(p)) else 0)
            out["received"] = received
            out["bytes_done"] = sum(received)
        out["chunk_size"] = CHUNK_SIZE
        return out

    def recent(self) -> List[Dict[str, Any]]:
        root = uploads_dir()
        if root.is_dir():
            for d in root.iterdir():
                if d.is_dir() and d.name not in self._ops:
                    try:
                        self.get(d.name)
                    except HTTPException:
                        pass
        with self._lock:
            ops = list(self._ops.values())
        ops.sort(key=lambda o: o.get("created_at", ""), reverse=True)
        return [self.public(o) for o in ops[:50]]

    # ---- uploads ----------------------------------------------------------------------
    def create_upload(self, req: UploadCreate) -> Dict[str, Any]:
        name = _check_name(req.name)
        if not req.files:
            raise HTTPException(status_code=400, detail="No files selected.")
        if len(req.files) > MAX_FILES:
            raise HTTPException(status_code=400, detail=f"Too many files ({len(req.files):,}). Zip the folder first.")
        seen, files = set(), []
        for f in req.files:
            try:
                rel = tsc.safe_relpath(f.path)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            key = rel.lower()                                 # Windows paths are case-insensitive
            if key in seen:
                raise HTTPException(status_code=400, detail=f"Duplicate file path '{rel}'.")
            seen.add(key)
            files.append({"path": rel, "size": f.size})
        total = sum(f["size"] for f in files)
        _check_master_space(total, "this upload")
        op_id = f"up_{uuid.uuid4().hex[:12]}"
        d = self._dir(op_id)
        (d / "files").mkdir(parents=True)
        for f in files:
            if f["size"] == 0:
                p = d / "files" / f["path"]
                p.parent.mkdir(parents=True, exist_ok=True)
                open(tsc._fs(p), "wb").close()
        op = {"op_id": op_id, "kind": "upload", "status": "uploading", "name": name,
              "description": req.description, "extract": req.extract, "files": files,
              "bytes_total": total, "bytes_done": 0, "created_at": _now(), "updated_at": _now(),
              "dataset_id": None, "error": None}
        with self._lock:
            self._ops[op_id] = op
        self._save(op)
        logger.info("Upload %s started: dataset '%s', %d file(s), %s", op_id, name, len(files), tsc._human(total))
        return self.public(op)

    async def put_chunk(self, op_id: str, index: int, offset: int, request: Request) -> Dict[str, Any]:
        op = self.get(op_id)
        if op["kind"] != "upload" or op["status"] not in ("uploading", "interrupted"):
            raise HTTPException(status_code=409, detail=f"Upload is {op['status']}, not accepting data.")
        if not 0 <= index < len(op["files"]):
            raise HTTPException(status_code=400, detail="Bad file index.")
        f = op["files"][index]
        path = self._dir(op_id) / "files" / f["path"]
        lock = self._file_locks.setdefault(f"{op_id}:{index}", asyncio.Lock())
        async with lock:
            have = os.path.getsize(tsc._fs(path)) if os.path.exists(tsc._fs(path)) else 0
            if offset != have:
                # The client and the Master disagree (retry after a dropped connection, a
                # duplicate chunk, a resumed page). Tell it where to continue; nothing is lost.
                return Response(status_code=409, media_type="application/json",
                                content=json.dumps({"detail": "offset mismatch", "expected_offset": have}))
            path.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with open(tsc._fs(path), "ab") as fh:
                async for piece in request.stream():
                    if not piece:
                        continue
                    if have + written + len(piece) > f["size"]:
                        fh.truncate(have + written)
                        raise HTTPException(status_code=400, detail=f"More data than the declared size of {f['path']}.")
                    fh.write(piece)
                    written += len(piece)
            op["status"] = "uploading"
            op["updated_at"] = _now()
            return {"received": have + written, "size": f["size"]}

    def complete_upload(self, op_id: str) -> Dict[str, Any]:
        op = self.get(op_id)
        if op["kind"] != "upload":
            raise HTTPException(status_code=400, detail="Not an upload.")
        if op["status"] in ("finalizing", "done"):
            return self.public(op)
        pub = self.public(op)
        missing = [f["path"] for f, got in zip(op["files"], pub["received"]) if got != f["size"]]
        if missing:
            raise HTTPException(status_code=409, detail=f"{len(missing)} file(s) incomplete, e.g. {missing[0]}. Resume the upload.")
        op.update(status="finalizing", bytes_done=op["bytes_total"], hashed=0, updated_at=_now())
        self._save(op)
        threading.Thread(target=self._finalize, args=(op, {"type": "upload"}), daemon=True).start()
        return self.public(op)

    # ---- imports ----------------------------------------------------------------------
    def create_import(self, req: ImportCreate) -> Dict[str, Any]:
        name = _check_name(req.name)
        url = tsc._expand_hf(req.url.strip())
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="URL must start with http://, https:// or hf://")
        fname = tsc._safe_member(req.filename or os.path.basename(tsc.urlparse(url).path) or "download") or "download"
        op_id = f"im_{uuid.uuid4().hex[:12]}"
        (self._dir(op_id) / "files").mkdir(parents=True)
        op = {"op_id": op_id, "kind": "import", "status": "downloading", "name": name, "url": url,
              "description": req.description, "extract": req.extract, "files": [{"path": fname, "size": None}],
              "sha256": req.sha256, "bytes_total": 0, "bytes_done": 0, "created_at": _now(),
              "updated_at": _now(), "dataset_id": None, "error": None}
        with self._lock:
            self._ops[op_id] = op
        self._save(op)
        threading.Thread(target=self._run_import, args=(op, req.headers), daemon=True).start()
        logger.info("Import %s started: %s -> dataset '%s'", op_id, url, name)
        return self.public(op)

    def _run_import(self, op: Dict[str, Any], headers: Optional[Dict[str, str]]):
        class _P(tsc._Progress):
            def add(inner, n):            # noqa: N805 - mirror progress into the op record
                super().add(n)
                op["bytes_done"], op["bytes_total"] = inner.done, inner.total

        try:
            dest = self._dir(op["op_id"]) / "files" / op["files"][0]["path"]
            prog = _P(op["name"], 0, verbose=False)
            tsc._fetch(tsc._session(internet=True), op["url"], dest, None, op.get("sha256"), prog, headers=headers)
            op["files"][0]["size"] = os.path.getsize(tsc._fs(dest))
            op.update(status="finalizing", bytes_total=op["files"][0]["size"], bytes_done=op["files"][0]["size"], hashed=0)
            self._save(op)
            self._finalize(op, {"type": "url", "url": op["url"]})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Import %s failed: %s", op["op_id"], exc)
            op.update(status="error", error=str(exc), updated_at=_now())
            self._save(op)

    # ---- shared -----------------------------------------------------------------------
    def _finalize(self, op: Dict[str, Any], source: Dict[str, Any]):
        def hashed(n):
            op["hashed"] = op.get("hashed", 0) + n

        try:
            m = tsc.build_dataset(self._dir(op["op_id"]) / "files", op["name"], op.get("description", ""),
                                  source, op.get("extract"), on_bytes=hashed)
            catalog.add(m)
            op.update(status="done", dataset_id=m["id"], updated_at=_now())
            self._save(op)
            logger.info("Dataset %s ready (%s, %d file(s))", m["id"], tsc._human(m["total_bytes"]), m["file_count"])
            # The staging folder was moved into the store; keep only op.json for status polls.
        except Exception as exc:  # noqa: BLE001
            logger.exception("Finalizing %s failed", op["op_id"])
            op.update(status="error", error=str(exc), updated_at=_now())
            self._save(op)

    def abort(self, op_id: str) -> Dict[str, Any]:
        op = self.get(op_id)
        if op["status"] == "finalizing":
            raise HTTPException(status_code=409, detail="Already verifying; wait for it to finish, then delete the dataset.")
        op["status"] = "cancelled"
        shutil.rmtree(tsc._fs(self._dir(op_id)), ignore_errors=True)
        with self._lock:
            self._ops.pop(op_id, None)
        return {"op_id": op_id, "status": "cancelled"}

    def cleanup(self):
        """Drop finished op records after an hour, and abandoned uploads after STALE_OP_HOURS."""
        root = uploads_dir()
        if not root.is_dir():
            return
        now = time.time()
        for d in root.iterdir():
            try:
                age_h = (now - (d / "op.json").stat().st_mtime) / 3600
                status = json.loads((d / "op.json").read_text(encoding="utf-8")).get("status")
            except (OSError, ValueError):
                age_h, status = (now - d.stat().st_mtime) / 3600, None
            if (status in ("done", "error", "cancelled") and age_h > 1) or age_h > STALE_OP_HOURS:
                if status == "finalizing":
                    continue
                shutil.rmtree(tsc._fs(d), ignore_errors=True)
                with self._lock:
                    self._ops.pop(d.name, None)


ops = Ops()


def _check_name(name: str) -> str:
    try:
        n = tsc.normalize_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if n in RESERVED_NAMES:
        raise HTTPException(status_code=400, detail=f"'{n}' is reserved; pick another name.")
    return n


def _check_master_space(need: int, what: str):
    root = tsc.data_root()
    root.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(tsc._fs(root)).free
    if free < need + SPACE_MARGIN:
        raise HTTPException(status_code=507, detail=(
            f"Not enough space on the Master for {what}: {tsc._human(need)} needed, {tsc._human(free)} free "
            f"(1 GB is kept free). Delete old datasets, or free space on {root.anchor}."))


# ==============================================================================
# File serving with HTTP Range (resumable worker pulls)
# ==============================================================================

def _file_response(path: Path, request: Request, etag: str) -> Response:
    size = os.path.getsize(tsc._fs(path))
    start, end, status_code = 0, size - 1, 200
    rng = request.headers.get("range")
    if rng and rng.startswith("bytes="):
        try:
            a, _, b = rng[6:].split(",")[0].strip().partition("-")
            if a:
                start = int(a)
                end = min(int(b), size - 1) if b else size - 1
            else:                                              # suffix range: last N bytes
                start, end = max(0, size - int(b)), size - 1
        except ValueError:
            raise HTTPException(status_code=400, detail="Bad Range header.")
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        status_code = 206
    length = end - start + 1

    def body():
        with open(tsc._fs(path), "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                b = f.read(min(1 << 20, left))
                if not b:
                    break
                left -= len(b)
                yield b

    headers = {"Accept-Ranges": "bytes", "Content-Length": str(length), "ETag": f'"{etag}"',
               "Cache-Control": "no-store"}
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(body(), status_code=status_code, headers=headers, media_type="application/octet-stream")


# ==============================================================================
# Routes (static paths first: "uploads", "imports", ... must not be taken for a dataset name)
# ==============================================================================

@router.get("")
async def list_datasets():
    """Every dataset in the Master's store, newest first, with which PCs already hold a copy."""
    items = catalog.all()
    latest = _latest_ids(items)
    items.sort(key=lambda m: (m["name"], str(m.get("created_at", ""))), reverse=False)
    out = [_summary(m, latest) for m in items]
    out.sort(key=lambda s: str(s.get("created_at", "")), reverse=True)
    return out


@router.get("/storage")
async def storage_info():
    root = tsc.data_root()
    root.mkdir(parents=True, exist_ok=True)
    u = shutil.disk_usage(tsc._fs(root))
    return {"data_root": str(root), "free_bytes": u.free, "total_bytes": u.total,
            "datasets_bytes": sum(int(m.get("total_bytes") or 0) for m in catalog.all()),
            "chunk_size": CHUNK_SIZE}


@router.post("/rescan")
async def rescan():
    """Re-read the store folder (after copying a dataset in by hand or from the USB stick)."""
    n = await asyncio.to_thread(catalog.scan)
    return {"datasets": n}


@router.get("/operations")
async def list_operations():
    return await asyncio.to_thread(ops.recent)


@router.post("/uploads", status_code=201)
async def create_upload(req: UploadCreate):
    return await asyncio.to_thread(ops.create_upload, req)


@router.get("/uploads/{op_id}")
async def upload_status(op_id: str):
    return await asyncio.to_thread(lambda: ops.public(ops.get(op_id)))


@router.put("/uploads/{op_id}/files/{index}")
async def upload_chunk(op_id: str, index: int, request: Request, offset: int = Query(..., ge=0)):
    """Raw bytes of one chunk (application/octet-stream) at `offset` of file `index`.
    409 + expected_offset when the Master already has a different amount: continue from there."""
    return await ops.put_chunk(op_id, index, offset, request)


@router.post("/uploads/{op_id}/complete", status_code=202)
async def complete_upload(op_id: str):
    return await asyncio.to_thread(ops.complete_upload, op_id)


@router.delete("/uploads/{op_id}")
async def abort_upload(op_id: str):
    return await asyncio.to_thread(ops.abort, op_id)


@router.post("/imports", status_code=202)
async def create_import(req: ImportCreate):
    """The Master downloads a URL (or hf:// file) once; workers then pull it over the LAN."""
    return await asyncio.to_thread(ops.create_import, req)


@router.get("/imports/{op_id}")
async def import_status(op_id: str):
    return await asyncio.to_thread(lambda: ops.public(ops.get(op_id)))


@router.get("/{ref}/manifest")
async def get_manifest(ref: str):
    """Full manifest (every file with size and SHA-256). Used by ts.dataset() on the workers."""
    return catalog.resolve(ref)


@router.get("/{dsid}/files/{path:path}")
async def get_file(dsid: str, path: str, request: Request):
    m = catalog.resolve(dsid)
    if m["id"] != dsid:
        raise HTTPException(status_code=400, detail="Use the full dataset id (name@version) to fetch files.")
    try:
        rel = tsc.safe_relpath(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not any(f["path"] == rel for f in m["files"]):
        raise HTTPException(status_code=404, detail=f"{rel} is not part of {dsid}.")
    full = tsc.store_dir() / dsid / "files" / rel
    if not os.path.exists(tsc._fs(full)):
        raise HTTPException(status_code=404, detail=f"{rel} is missing from the Master's store.")
    return _file_response(full, request, m["version"])


@router.get("/{ref}")
async def get_dataset(ref: str):
    m = catalog.resolve(ref)
    s = _summary(m, _latest_ids(catalog.all()))
    s["files"] = [{"path": f["path"], "size": f["size"]} for f in m["files"][:1000]]
    return s


@router.delete("/{dsid}")
async def delete_dataset(dsid: str):
    """Remove from the Master's store. Copies cached on workers stay usable for running work;
    use POST /api/v1/datasets/{id}/evict first to clear them too."""
    m = catalog.resolve(dsid)
    if m["id"] != dsid:
        raise HTTPException(status_code=400, detail="Use the full dataset id (name@version) to delete.")
    target = tsc.store_dir() / dsid
    trash = tsc.store_dir() / f".trash-{dsid}-{uuid.uuid4().hex[:6]}"
    try:
        os.replace(tsc._fs(target), tsc._fs(trash))           # atomic: readers see all or nothing
    except OSError as exc:
        raise HTTPException(status_code=409, detail=(
            f"Can't delete {dsid}: files are in use on the Master PC ({exc.strerror}). "
            "Stop notebooks using it (Runtime > Active runtimes) and try again."))
    catalog.remove(dsid)
    await asyncio.to_thread(shutil.rmtree, tsc._fs(trash), True)
    return {"deleted": dsid}
