// Dataset API client + a resumable, chunked uploader.
//
// The browser never reads a whole file into memory: each chunk is a File.slice() (a lazy view)
// sent as one PUT. The Master tells us exactly how many bytes it has per file, so after a
// dropped Wi-Fi connection, a closed tab or a Master restart the upload continues from there:
// pick the same files again and press Upload.

import { api, ApiError, normalizeBase, postJson, storageGet, storageSet } from "./api";
import type { Dataset, DatasetOp, DatasetStorage, DatasetTask } from "./types";

export const listDatasets = (base: string) => api<Dataset[]>(base, "/api/v1/datasets");
export const datasetStorage = (base: string) => api<DatasetStorage>(base, "/api/v1/datasets/storage");
export const listOperations = (base: string) => api<DatasetOp[]>(base, "/api/v1/datasets/operations");
export const deleteDataset = (base: string, id: string) =>
  api<{ deleted: string }>(base, `/api/v1/datasets/${encodeURIComponent(id)}`, { method: "DELETE" });
export const startDatasetTask = (base: string, id: string, action: "prefetch" | "evict", ips?: string[]) =>
  postJson<DatasetTask>(base, `/api/v1/datasets/${encodeURIComponent(id)}/${action}`, ips?.length ? { target_node_ips: ips } : {});
export const datasetTask = (base: string, taskId: string) => api<DatasetTask>(base, `/api/v1/datasets/tasks/${taskId}`);
export const startImport = (base: string, body: { name: string; url: string; description?: string; extract?: boolean | null }) =>
  postJson<DatasetOp>(base, "/api/v1/datasets/imports", body);
export const rescanDatasets = (base: string) => postJson<{ datasets: number }>(base, "/api/v1/datasets/rescan", {});

/** Mirrors tensorswarm_client.normalize_name(). */
export function normalizeDatasetName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64);
}

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;
export const isArchive = (path: string) => ARCHIVE_RE.test(path);

export interface PickedFile { file: File; path: string }

export interface UploadProgress {
  phase: "preparing" | "uploading" | "verifying" | "done" | "error" | "paused";
  sent: number;
  total: number;
  rateBps: number;
  etaSec: number | null;
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
  retrying?: string;
  resumedBytes?: number;
  datasetId?: string;
  error?: string;
}

const RESUME_KEY = "tensorswarm-upload-resume";

function signature(name: string, files: PickedFile[]): string {
  // Same dataset name + same paths, sizes and modification times = the same upload.
  let h = 0;
  const text = name + "|" + files.map((f) => `${f.path}:${f.file.size}:${f.file.lastModified}`).join("|");
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${name}:${files.length}:${(h >>> 0).toString(16)}`;
}

function loadResume(): Record<string, string> {
  try { return JSON.parse(storageGet(RESUME_KEY) || "{}"); } catch { return {}; }
}
function saveResume(sig: string, opId: string | null) {
  const all = loadResume();
  if (opId) all[sig] = opId; else delete all[sig];
  storageSet(RESUME_KEY, JSON.stringify(all));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

/**
 * Upload files as a new dataset version. Resolves with the dataset id (name@version).
 * Abort the signal to pause; calling again with the same files resumes.
 */
export async function uploadDataset(
  base: string,
  opts: { name: string; description: string; files: PickedFile[]; extract: boolean | null },
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<string> {
  const root = normalizeBase(base);
  const total = opts.files.reduce((a, f) => a + f.file.size, 0);
  const sig = signature(opts.name, opts.files);
  const prog: UploadProgress = { phase: "preparing", sent: 0, total, rateBps: 0, etaSec: null, filesDone: 0, filesTotal: opts.files.length };
  const emit = () => onProgress({ ...prog });
  emit();

  // 1. Resume an earlier upload of exactly these files, or start a new one.
  let op: DatasetOp | null = null;
  const prev = loadResume()[sig];
  if (prev) {
    try {
      const st = await api<DatasetOp>(base, `/api/v1/datasets/uploads/${prev}`);
      if ((st.status === "uploading" || st.status === "interrupted") && st.files.length === opts.files.length) op = st;
    } catch { /* expired or finished: start fresh */ }
  }
  if (!op) {
    op = await postJson<DatasetOp>(base, "/api/v1/datasets/uploads", {
      name: opts.name, description: opts.description, extract: opts.extract,
      files: opts.files.map((f) => ({ path: f.path, size: f.file.size })),
    });
    saveResume(sig, op.op_id);
  }
  const opId = op.op_id;
  const chunk = op.chunk_size || 8 * 1024 * 1024;
  const offsets = opts.files.map((f, i) => Math.min(op!.received?.[i] ?? 0, f.file.size));
  prog.resumedBytes = offsets.reduce((a, b) => a + b, 0);
  prog.sent = prog.resumedBytes;
  prog.filesDone = opts.files.filter((f, i) => offsets[i] >= f.file.size).length;
  prog.phase = "uploading";
  emit();

  // 2. Send chunks. Up to 3 files in parallel (helps many small files); each file in order.
  const t0 = performance.now();
  const startSent = prog.sent;
  const updateRate = () => {
    const secs = (performance.now() - t0) / 1000;
    prog.rateBps = secs > 0.5 ? (prog.sent - startSent) / secs : 0;
    prog.etaSec = prog.rateBps > 0 ? (prog.total - prog.sent) / prog.rateBps : null;
  };
  let next = 0;
  const sendFile = async (i: number) => {
    const f = opts.files[i];
    let off = offsets[i];
    let failures = 0;
    while (off < f.file.size) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      prog.currentFile = f.path;
      const end = Math.min(f.file.size, off + chunk);
      let res: Response;
      try {
        res = await fetch(`${root}/api/v1/datasets/uploads/${opId}/files/${i}?offset=${off}`, {
          method: "PUT", body: f.file.slice(off, end), signal,
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (err) {
        if (signal.aborted) throw err;
        failures++;
        if (failures > 10) throw new Error(`Network keeps failing while sending ${f.path}. Check the connection, then press Upload again to resume.`);
        prog.retrying = `Connection lost, retrying in ${Math.min(30, 2 ** failures)} s (attempt ${failures}/10)`;
        emit();
        await sleep(Math.min(30, 2 ** failures) * 1000, signal);
        continue;
      }
      if (res.status === 409) {                        // Master has a different amount: realign
        const body = await res.json().catch(() => ({}));
        if (typeof body.expected_offset === "number") {
          prog.sent += body.expected_offset - off;
          off = body.expected_offset;
          continue;
        }
        throw new ApiError(409, body.detail || "Upload is not accepting data any more.");
      }
      if (res.status >= 500 && failures < 10) {
        failures++;
        prog.retrying = `Master busy (HTTP ${res.status}), retrying…`;
        emit();
        await sleep(Math.min(30, 2 ** failures) * 1000, signal);
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.detail || `HTTP ${res.status}`);
      }
      prog.sent += end - off;
      off = end;
      failures = 0;
      prog.retrying = undefined;
      updateRate();
      emit();
    }
    prog.filesDone++;
    emit();
  };
  const workers = Array.from({ length: Math.min(3, opts.files.length) }, async () => {
    while (next < opts.files.length) {
      const i = next++;
      if (offsets[i] < opts.files[i].file.size) await sendFile(i);
    }
  });
  await Promise.all(workers);

  // 3. The Master hashes every file (SHA-256) and seals the dataset.
  prog.phase = "verifying";
  prog.currentFile = undefined;
  emit();
  await postJson(base, `/api/v1/datasets/uploads/${opId}/complete`, {});
  for (;;) {
    await sleep(800, signal);
    const st = await api<DatasetOp>(base, `/api/v1/datasets/uploads/${opId}`);
    if (st.status === "done" && st.dataset_id) {
      saveResume(sig, null);
      prog.phase = "done";
      prog.datasetId = st.dataset_id;
      emit();
      return st.dataset_id;
    }
    if (st.status === "error" || st.status === "cancelled") {
      saveResume(sig, null);
      throw new Error(st.error || "The Master could not store this dataset.");
    }
    prog.sent = prog.total;
    prog.etaSec = null;
    prog.rateBps = 0;
    if (st.hashed !== undefined && st.bytes_total) prog.retrying = `Verifying checksums ${Math.round((100 * st.hashed) / st.bytes_total)}%`;
    emit();
  }
}

export async function discardUpload(base: string, name: string, files: PickedFile[]) {
  const sig = signature(name, files);
  const opId = loadResume()[sig];
  saveResume(sig, null);
  if (opId) await api(base, `/api/v1/datasets/uploads/${opId}`, { method: "DELETE" }).catch(() => undefined);
}

/** Read a drag-and-drop, including whole folders (keeps relative paths). */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string;
    file?: (ok: (f: File) => void, err: (e: unknown) => void) => void; createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void } };
  const walk = async (entry: Entry, prefix: string): Promise<void> => {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      for (;;) {                                        // readEntries returns batches of ~100
        const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = Array.from(dt.items)
    .map((it) => (it as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.())
    .filter(Boolean) as Entry[];
  if (entries.length) {
    for (const e of entries) await walk(e, "");
  } else {
    for (const f of Array.from(dt.files)) out.push({ file: f, path: f.name });
  }
  return out;
}

/** <input type=file webkitdirectory> gives webkitRelativePath; plain picks give the name. */
export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list).map((file) => ({
    file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

/** Copy text even on plain-http pages (http://<MASTER_IP>:8000 is not a "secure context",
 *  so navigator.clipboard is unavailable there): falls back to a hidden textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return u === 0 ? `${v} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

/** The code a user pastes into a cell. */
export function datasetSnippet(d: Dataset, pinned = false): string {
  const ref = pinned ? d.id : d.name;
  const first = d.preview[0]?.path;
  if (!d.archive && d.file_count === 1 && first) return `path = ts.dataset("${ref}") / "${first}"`;
  return `root = ts.dataset("${ref}")   # folder on the worker`;
}
