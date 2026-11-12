"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCluster } from "../lib/cluster";
import {
  copyText, datasetSnippet, datasetStorage, datasetTask, deleteDataset, discardUpload, filesFromDrop, filesFromInput,
  fmtBytes, isArchive, listDatasets, listOperations, normalizeDatasetName, startDatasetTask, startImport,
  uploadDataset, type PickedFile, type UploadProgress,
} from "../lib/datasets";
import { fmtDuration, timeAgo } from "../lib/format";
import type { Dataset, DatasetOp, DatasetStorage, DatasetTask, NodeRecord } from "../lib/types";
import PageHeader from "./PageHeader";
import { Button, Card, StatTile } from "./ui";

const MANY_FILES = 1000;

export default function DatasetsApp() {
  const { base, nodes } = useCluster();
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [storage, setStorage] = useState<DatasetStorage | null>(null);
  const [ops, setOps] = useState<DatasetOp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Poll faster while the Master is downloading an import, so its progress bar moves.
  const importBusy = ops.some((o) => o.kind === "import" && (o.status === "downloading" || o.status === "finalizing"));

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [d, s, o] = await Promise.all([listDatasets(base), datasetStorage(base), listOperations(base)]);
        if (!alive) return;
        setDatasets(d); setStorage(s); setOps(o); setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, importBusy ? 1500 : 5000);
    return () => { alive = false; clearInterval(id); };
  }, [base, tick, importBusy]);

  const onlinePcs = useMemo(() => {
    const seen = new Map<string, NodeRecord>();
    for (const n of nodes) if (n.status !== "OFFLINE" && !seen.has(n.tailscale_ip)) seen.set(n.tailscale_ip, n);
    return Array.from(seen.values());
  }, [nodes]);

  const totalBytes = (datasets ?? []).reduce((a, d) => a + d.total_bytes, 0);
  const names = new Set((datasets ?? []).map((d) => d.name));

  return (
    <main className="min-w-0 flex-1 space-y-5 px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        title="Datasets"
        subtitle={<>Upload once to the Master; each worker copies a dataset the first time a notebook or job asks for it, then keeps it cached.
          In code, <code className="rounded-md border border-line bg-elevated px-1.5 py-0.5 font-mono text-[12.5px] text-fg">ts.dataset(&quot;name&quot;)</code> returns the local folder.</>}
      />

      {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-fg">{error}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Datasets" value={datasets ? names.size : "—"} sub={datasets ? `${datasets.length} version${datasets.length === 1 ? "" : "s"}` : undefined} />
        <StatTile label="Stored on the Master" value={fmtBytes(totalBytes)} />
        <StatTile label="Free on the Master" value={storage ? fmtBytes(storage.free_bytes) : "—"} sub={storage?.data_root} />
        <StatTile label="PCs online" value={onlinePcs.length} sub="each keeps its own cache" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-3">
          {datasets === null && !error && <p className="text-sm text-muted">Loading…</p>}
          {datasets?.length === 0 && (
            <Card className="border-dashed p-8 text-center text-sm text-muted">
              No datasets yet. Upload files or a folder on the right, import one from a URL, or put big ones on the USB stick
              (<code className="text-fg/85">prepare_usb.cmd -Datasets name</code>).
            </Card>
          )}
          {datasets?.map((d) => <DatasetCard key={d.id} d={d} pcs={onlinePcs} onChanged={refresh} />)}
        </div>
        <div className="space-y-4">
          <UploadPanel existing={names} onDone={refresh} />
          <ImportPanel existing={names} onStarted={refresh} ops={ops} />
          <HelpCard />
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <Button variant="ghost" title={text} onClick={async () => {
      setState((await copyText(text)) ? "ok" : "fail");
      setTimeout(() => setState("idle"), 1500);
    }}>
      {state === "ok" ? "✓ Copied" : state === "fail" ? "Select & copy manually" : label}
    </Button>
  );
}

function DatasetCard({ d, pcs, onChanged }: { d: Dataset; pcs: NodeRecord[]; onChanged: () => void }) {
  const { base } = useCluster();
  const [showFiles, setShowFiles] = useState(false);
  const [task, setTask] = useState<DatasetTask | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const holders = new Map(d.nodes.map((n) => [n.ip, n]));

  useEffect(() => {
    if (!task || Object.values(task.nodes).every((n) => n.status !== "RUNNING")) return;
    const id = setInterval(async () => {
      try {
        const t = await datasetTask(base, task.task_id);
        setTask(t);
        if (Object.values(t.nodes).every((n) => n.status !== "RUNNING")) onChanged();
      } catch { /* keep last state */ }
    }, 1500);
    return () => clearInterval(id);
  }, [task, base, onChanged]);

  const run = async (action: "prefetch" | "evict") => {
    setErr(null); setBusy(action);
    try { setTask(await startDatasetTask(base, d.id, action)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${d.id} from the Master?\n\nCopies already cached on workers are not deleted (use "Clear worker caches" first to free their disks).`)) return;
    setErr(null); setBusy("delete");
    try { await deleteDataset(base, d.id); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const snippet = datasetSnippet(d);
  const running = task && Object.values(task.nodes).some((n) => n.status === "RUNNING");

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-fg">{d.name}</h2>
            <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-muted" title="Version = hash of the content">@{d.version}</span>
            {d.latest
              ? <span className="rounded border border-ok/35 bg-ok/10 px-1.5 py-0.5 text-[11px] font-medium text-ok-fg">latest</span>
              : <span className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">older version</span>}
            {d.archive && <span className="rounded border border-line-strong bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg/85" title="Sent as one file, extracted on each worker">archive · extracted on workers</span>}
          </div>
          {d.description && <p className="mt-1 text-sm text-muted">{d.description}</p>}
          <p className="mt-1 text-xs text-muted">
            {fmtBytes(d.total_bytes)}
            {d.archive && d.extracted_bytes ? ` (${fmtBytes(d.extracted_bytes)} extracted)` : ""} · {d.file_count.toLocaleString()} file{d.file_count === 1 ? "" : "s"} ·
            {" "}{d.source.type === "url" ? "imported from URL" : d.source.type === "local" ? "added on the Master PC" : "uploaded"} {timeAgo(d.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => run("prefetch")} disabled={!!busy || !!running} title="Copy to every online PC now, so jobs start without waiting">
            {busy === "prefetch" ? "Starting…" : "Copy to all PCs"}
          </Button>
          <Button variant="ghost" onClick={() => run("evict")} disabled={!!busy || !!running} title="Delete cached copies on the workers (the Master keeps its copy)">Clear worker caches</Button>
          <Button variant="ghost" onClick={remove} disabled={!!busy}>Delete</Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-fg">{snippet}</code>
        <CopyButton text={snippet} label="Copy code" />
        <CopyButton text={datasetSnippet(d, true)} label="Copy pinned" />
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
          On {pcs.filter((p) => holders.has(p.tailscale_ip)).length} of {pcs.length} online PC{pcs.length === 1 ? "" : "s"}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pcs.map((p) => {
            const h = holders.get(p.tailscale_ip);
            const t = task?.nodes[p.tailscale_ip];
            const label = t?.status === "RUNNING" ? (task!.action === "sync" ? "copying…" : "clearing…")
              : t?.status === "FAILED" ? "failed" : h ? (h.location === "store" ? "local copy" : "cached") : "not yet";
            const cls = t?.status === "FAILED" ? "border-danger/40 text-danger-fg"
              : t?.status === "RUNNING" ? "border-line-strong text-fg/85"
              : h ? "border-ok/35 text-ok-fg" : "border-line-strong text-muted";
            return (
              <span key={p.tailscale_ip} title={t?.detail || p.tailscale_ip} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] ${cls}`}>
                <span aria-hidden>{t?.status === "FAILED" ? "■" : h && !t?.status?.startsWith("RUN") ? "✓" : "○"}</span>
                {p.hostname} · {label}
              </span>
            );
          })}
          {!pcs.length && <span className="text-xs text-muted">No PCs online.</span>}
        </div>
        {task && Object.entries(task.nodes).filter(([, n]) => n.status === "FAILED").map(([ip, n]) => (
          <p key={ip} className="mt-1 text-xs text-danger-fg">{n.hostname || ip}: {n.detail}</p>
        ))}
        {task && !running && task.action === "sync" && Object.values(task.nodes).every((n) => n.status === "COMPLETED") && (
          <p className="mt-1 text-xs text-ok-fg">✓ On every PC ({fmtDuration(Math.max(...Object.values(task.nodes).map((n) => n.seconds || 0)))}).</p>
        )}
      </div>

      {err && <p className="mt-2 text-xs text-danger-fg">{err}</p>}

      <button className="mt-3 text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => setShowFiles((v) => !v)}>
        {showFiles ? "Hide files" : `Show files${d.file_count > d.preview.length ? ` (first ${d.preview.length})` : ""}`}
      </button>
      {showFiles && (
        <ul className="mt-2 max-h-56 overflow-auto rounded-lg border border-line bg-canvas/60 p-2 font-mono text-[11px] text-fg/85">
          {d.preview.map((f) => (
            <li key={f.path} className="flex justify-between gap-3 py-0.5"><span className="truncate">{f.path}</span><span className="shrink-0 text-muted">{fmtBytes(f.size)}</span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

function UploadPanel({ existing, onDone }: { existing: Set<string>; onDone: () => void }) {
  const { base } = useCluster();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [extract, setExtract] = useState(true);
  const [prog, setProg] = useState<UploadProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const uploading = prog?.phase === "uploading" || prog?.phase === "preparing" || prog?.phase === "verifying";

  useEffect(() => {                                     // don't lose an upload to a stray click
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const pick = (list: PickedFile[]) => {
    if (!list.length) return;
    // One picked/dropped folder: its contents become the dataset root (ts.dataset("x") / "train"),
    // not ts.dataset("x") / "x" / "train". Several folders or loose files keep their paths.
    const tops = new Set(list.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
    const [only] = Array.from(tops);
    const folder = tops.size === 1 && only ? only : null;
    const files = folder ? list.map((f) => ({ ...f, path: f.path.slice(folder.length + 1) })) : list;
    setFiles(files);
    setProg(null);
    if (!nameTouched) {
      const base = folder ?? files[0].path.replace(/\.(tar\.(gz|bz2|xz))$/i, "").replace(/\.[^./]+$/, "");
      setName(normalizeDatasetName(base));
    }
  };

  const total = files.reduce((a, f) => a + f.file.size, 0);
  const single = files.length === 1;
  const archive = single && isArchive(files[0].path);
  const cleanName = normalizeDatasetName(name);

  const start = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const id = await uploadDataset(base, { name: cleanName, description, files, extract: archive ? extract : null }, setProg, ctl.signal);
      setProg((p) => p && { ...p, phase: "done", datasetId: id });
      onDone();
    } catch (e) {
      if ((e as Error).name === "AbortError") setProg((p) => p && { ...p, phase: "paused" });
      else setProg((p) => ({ ...(p ?? { sent: 0, total, rateBps: 0, etaSec: null, filesDone: 0, filesTotal: files.length }), phase: "error", error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const pct = prog && prog.total ? Math.min(100, (100 * prog.sent) / prog.total) : 0;

  return (
    <Card className="p-5">
      <h2 className="text-[16px] font-semibold text-fg">Upload a dataset</h2>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => { e.preventDefault(); setDragging(false); if (!uploading) pick(await filesFromDrop(e.dataTransfer)); }}
        className={`mt-3 rounded-xl border-2 border-dashed px-4 py-7 text-center text-[13px] transition-colors duration-150 ${dragging ? "border-accent bg-accent/[0.06] text-fg" : "border-line-strong bg-elevated/50 text-muted"}`}
      >
        Drop files or a folder here
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button onClick={() => fileInput.current?.click()} disabled={uploading}>Choose files</Button>
          <Button onClick={() => dirInput.current?.click()} disabled={uploading}>Choose folder</Button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) pick(filesFromInput(e.target.files)); e.target.value = ""; }} />
        <input ref={dirInput} type="file" hidden onChange={(e) => { if (e.target.files) pick(filesFromInput(e.target.files)); e.target.value = ""; }}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
      </div>

      {files.length > 0 && (
        <div className="mt-3 space-y-2.5">
          <p className="text-xs text-fg/85">
            {files.length.toLocaleString()} file{single ? "" : "s"}, {fmtBytes(total)}
            {single ? <span className="text-muted"> · {files[0].path}</span> : null}
          </p>
          {files.length > MANY_FILES && (
            <p className="rounded border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px] text-warn-fg">
              ▲ {files.length.toLocaleString()} separate files upload and copy slowly. Zip the folder and upload the .zip instead:
              it travels as one file and every worker extracts it locally.
            </p>
          )}
          {archive && (
            <label className="flex items-center gap-2 text-xs text-fg/85">
              <input type="checkbox" checked={extract} onChange={(e) => setExtract(e.target.checked)} disabled={uploading} />
              Extract on the workers (ts.dataset returns the extracted folder)
            </label>
          )}
          <label className="block text-xs text-muted">
            Name
            <input value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} disabled={uploading}
              className="mt-1 w-full rounded-md border border-line-strong bg-canvas px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-accent" />
          </label>
          {name && cleanName !== name && <p className="text-[11px] text-muted">Will be saved as <code>{cleanName || "(invalid)"}</code></p>}
          {existing.has(cleanName) && <p className="text-[11px] text-fg/85">A dataset with this name exists: this upload becomes its new latest version (older versions stay available).</p>}
          <label className="block text-xs text-muted">
            Description (optional)
            <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={uploading}
              className="mt-1 w-full rounded-md border border-line-strong bg-canvas px-2 py-1.5 text-sm text-fg outline-none focus:border-accent" />
          </label>

          {prog && (
            <div className="space-y-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-elevated" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-2 rounded-full transition-all" style={{ width: `${prog.phase === "verifying" ? 100 : pct}%`, background: prog.phase === "error" ? "rgb(var(--danger))" : "rgb(var(--viz))" }} />
              </div>
              <p className="text-[11px] text-muted">
                {prog.phase === "preparing" && "Contacting the Master…"}
                {prog.phase === "uploading" && <>
                  {fmtBytes(prog.sent)} / {fmtBytes(prog.total)} ({pct.toFixed(0)}%)
                  {prog.rateBps > 0 && ` · ${fmtBytes(prog.rateBps)}/s`}
                  {prog.etaSec !== null && ` · ${fmtDuration(prog.etaSec)} left`}
                  {prog.filesTotal > 1 && ` · ${prog.filesDone.toLocaleString()}/${prog.filesTotal.toLocaleString()} files`}
                  {prog.resumedBytes ? ` · resumed at ${fmtBytes(prog.resumedBytes)}` : ""}
                </>}
                {prog.phase === "verifying" && "Uploaded. The Master is verifying checksums…"}
                {prog.phase === "paused" && `Paused at ${fmtBytes(prog.sent)}. Press Upload to continue where it stopped.`}
                {prog.phase === "done" && <span className="text-ok-fg">✓ Stored as {prog.datasetId}{prog.resumedBytes ? ` (resumed from ${fmtBytes(prog.resumedBytes)})` : ""}</span>}
                {prog.phase === "error" && <span className="text-danger-fg">{prog.error} Press Upload to retry; finished parts are kept.</span>}
              </p>
              {prog.retrying && prog.phase !== "done" && <p className="text-[11px] text-warn-fg">{prog.retrying}</p>}
            </div>
          )}

          <div className="flex gap-2">
            {!uploading && prog?.phase !== "done" && (
              <Button variant="primary" onClick={start} disabled={!cleanName}>
                {prog?.phase === "paused" || prog?.phase === "error" ? "Resume upload" : "Upload"}
              </Button>
            )}
            {uploading && prog?.phase !== "verifying" && <Button onClick={() => abort.current?.abort()}>Pause</Button>}
            {!uploading && (
              <Button variant="ghost" onClick={async () => {
                if (prog && prog.phase !== "done") await discardUpload(base, cleanName, files);
                setFiles([]); setProg(null); setNameTouched(false); setName(""); setDescription("");
              }}>{prog?.phase === "done" ? "Upload another" : "Clear"}</Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

function ImportPanel({ existing, onStarted, ops }: { existing: Set<string>; onStarted: () => void; ops: DatasetOp[] }) {
  const { base } = useCluster();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imports = ops.filter((o) => o.kind === "import").slice(0, 5);

  const suggest = (u: string) => {
    const last = u.split("?")[0].split("/").filter(Boolean).pop() || "";
    return normalizeDatasetName(last.replace(/\.(zip|tar|tgz|gz|bz2|xz|csv|jsonl?|parquet|txt)$/gi, ""));
  };

  return (
    <Card className="p-5">
      <h2 className="text-[16px] font-semibold text-fg">Import from a URL</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
        The Master downloads it once; workers then copy it over the lab network instead of the internet.
        Hugging Face: <code className="text-fg/85">hf://datasets/owner/repo/path/file.csv</code>
      </p>
      <input value={url} onChange={(e) => { setUrl(e.target.value); if (!name) setName(""); }} placeholder="https://… or hf://datasets/…"
        className="mt-3 w-full rounded-lg border border-line-strong bg-elevated px-3 py-2 font-mono text-[12.5px] text-fg outline-none transition-colors duration-150 placeholder:text-muted/80 focus:border-accent" />
      <input value={name || suggest(url)} onChange={(e) => setName(e.target.value)} placeholder="dataset name"
        className="mt-3 w-full rounded-lg border border-line-strong bg-elevated px-3 py-2 font-mono text-[12.5px] text-fg outline-none transition-colors duration-150 placeholder:text-muted/80 focus:border-accent" />
      {existing.has(normalizeDatasetName(name || suggest(url))) && <p className="mt-1 text-[11px] text-fg/85">Adds a new version of an existing dataset.</p>}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" disabled={!url.trim() || busy || !normalizeDatasetName(name || suggest(url))} onClick={async () => {
          setErr(null); setBusy(true);
          try {
            await startImport(base, { name: normalizeDatasetName(name || suggest(url)), url: url.trim() });
            setUrl(""); setName(""); onStarted();
          } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}>{busy ? "Starting…" : "Import"}</Button>
      </div>
      {err && <p className="mt-2 text-xs text-danger-fg">{err}</p>}
      {imports.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {imports.map((o) => {
            const p = o.bytes_total ? Math.min(100, (100 * o.bytes_done) / o.bytes_total) : 0;
            return (
              <li key={o.op_id} className="rounded border border-line bg-canvas/50 px-2 py-1.5 text-[11px]">
                <div className="flex justify-between gap-2">
                  <span className="truncate font-mono text-fg/85" title={o.url}>{o.name}</span>
                  <span className={o.status === "error" ? "text-danger-fg" : o.status === "done" ? "text-ok-fg" : "text-fg/85"}>
                    {o.status === "downloading" ? `${fmtBytes(o.bytes_done)}${o.bytes_total ? ` / ${fmtBytes(o.bytes_total)}` : ""}` : o.status === "finalizing" ? "verifying…" : o.status}
                  </span>
                </div>
                {o.status === "downloading" && o.bytes_total > 0 && (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-elevated"><div className="h-1 rounded-full" style={{ width: `${p}%`, background: "rgb(var(--viz))" }} /></div>
                )}
                {o.error && <p className="mt-0.5 text-danger-fg">{o.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function HelpCard() {
  const code = `import tensorswarm as ts          # already imported as ts in notebooks and jobs
root = ts.dataset("my-images")    # local folder, copied from the Master once
from torchvision.datasets import ImageFolder
data = ImageFolder(root / "train")

ts.download("https://…/file.zip", extract=True)   # straight from the internet, cached
ts.upload("checkpoints", "my-model")              # publish results back to the Master`;
  return (
    <Card className="p-5">
      <h2 className="text-[16px] font-semibold text-fg">Using a dataset in code</h2>
      <pre className="thin-scroll mt-3 overflow-x-auto whitespace-pre rounded-xl border border-line bg-canvas/70 p-3 font-mono text-[11.5px] leading-relaxed text-fg/90">{code}</pre>
      <ul className="mt-3 list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed text-muted">
        <li>Very large datasets (several GB): put them on the USB stick with <code className="text-fg/85">prepare_usb.cmd -Datasets name</code>, so no PC downloads them.</li>
        <li>Versions are immutable. <code className="text-fg/85">ts.dataset(&quot;name&quot;)</code> means the latest; copy the pinned form to keep a run reproducible.</li>
        <li>Use <code className="text-fg/85">num_workers=0</code> in DataLoaders on Windows workers.</li>
      </ul>
    </Card>
  );
}
