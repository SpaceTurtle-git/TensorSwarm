"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, postJson } from "../../lib/api";
import { useCluster, useSamples } from "../../lib/cluster";
import { fmtMB, pct } from "../../lib/format";
import {
  type Cell, type CellStatus, type Notebook, download, fromIpynb, fromPercentPy, loadNotebooks, newCell,
  newNotebook, saveNotebooks, toIpynb, toPercentPy, toScript,
} from "../../lib/notebook";
import { describeSpec, useRuntime, type RuntimeSpec } from "../../lib/runtime";
import type { ExecutionPoll, JobResult, Sample } from "../../lib/types";
import { IconClose, IconJobs, IconRefresh, IconStop } from "../icons";
import PageHeader from "../PageHeader";
import RuntimeProgress from "../RuntimeProgress";
import { Button, StatusPill } from "../ui";
import ConnectDialog from "./ConnectDialog";
import NotebookCell from "./NotebookCell";
import SidePanel from "./SidePanel";

const STATUS_MAP: Record<ExecutionPoll["status"], CellStatus> = {
  QUEUED: "queued", RUNNING: "running", OK: "ok", ERROR: "error",
  INTERRUPTED: "interrupted", CANCELLED: "cancelled", UNKNOWN: "error",
};
const TERMINAL = new Set(["OK", "ERROR", "INTERRUPTED", "CANCELLED", "UNKNOWN"]);

interface ExecEntry { nbId: string; cellId: string; kernelId: string; since: number }
interface Store { notebooks: Notebook[]; activeId: string }

const WELCOME = (): Notebook =>
  newNotebook("Welcome", [
    newCell("markdown", "# TensorSwarm notebook\nCells run in a **persistent Python runtime on a worker's GPU** (or CPU only, on any PC). Press **Connect** to pick GPU seats or CPU cores, then **Shift+Enter** to run a cell. Open the *Samples* tab on the right for ready-made tests, and the *Data* tab for datasets. `ts.map(fn, items)` spreads work over the CPU cores of every PC."),
    newCell("code", 'import torch, socket\nprint("Running on", socket.gethostname())\nprint("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none (CPU)")'),
    newCell("code", "x = torch.randn(4096, 4096, device=\"cuda\" if torch.cuda.is_available() else \"cpu\")\n(x @ x).norm()"),
  ]);

export default function NotebookApp() {
  const { base, nodes } = useCluster();
  const router = useRouter();
  const params = useSearchParams();
  const { samples } = useSamples();

  const [store, setStore] = useState<Store | null>(null);
  const storeRef = useRef<Store | null>(null);
  storeRef.current = store;
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);   // new cells focus once their editor mounts
  const [showConnect, setShowConnect] = useState(false);
  const [varsVersion, setVarsVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const execs = useRef(new Map<string, ExecEntry>());
  // Latest editor text per cell, updated synchronously on every keystroke. React state lags a
  // render behind, so Shift+Enter right after typing would otherwise run stale code.
  const liveSource = useRef(new Map<string, string>());
  const [execCount, setExecCount] = useState(0);   // bumps the poll loop
  const pending = useRef<{ nbId: string; ids: string[] } | null>(null);
  const handledSample = useRef(false);

  // ---------------------------------------------------------------- load + autosave
  useEffect(() => {
    const { notebooks, activeId } = loadNotebooks();
    const nbs = notebooks.length ? notebooks : [WELCOME()];
    const active = activeId && nbs.some((n) => n.id === activeId) ? activeId : nbs[0].id;
    setStore({ notebooks: nbs, activeId: active });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!store) return;
    const t = setTimeout(() => {
      const res = saveNotebooks(store.notebooks, store.activeId);
      if (res === "no-outputs") setNotice("Browser storage is full: notebooks were saved without their outputs.");
      if (res === "failed") setNotice("Could not save notebooks in this browser (storage blocked). Export them to keep your work.");
    }, 600);
    return () => clearTimeout(t);
  }, [store]);

  const nb = store?.notebooks.find((n) => n.id === store.activeId) ?? null;

  const updateNb = useCallback((nbId: string, fn: (n: Notebook) => Notebook) => {
    setStore((s) => (s ? { ...s, notebooks: s.notebooks.map((n) => (n.id === nbId ? { ...fn(n), updatedAt: Date.now() } : n)) } : s));
  }, []);
  const updateCell = useCallback((nbId: string, cellId: string, fn: (c: Cell) => Cell) => {
    updateNb(nbId, (n) => ({ ...n, cells: n.cells.map((c) => (c.id === cellId ? fn(c) : c)) }));
  }, [updateNb]);

  // ---------------------------------------------------------------- runtime
  // One runtime per browser (lib/runtime.ts), shared by every page: it follows the open notebook.
  const runtime = useRuntime();
  const kernel = runtime.kernel;

  // Cells still running on a runtime that is being replaced or released can never finish.
  const abandonExecs = useCallback(() => {
    for (const e of Array.from(execs.current.values())) {
      updateCell(e.nbId, e.cellId, (c) => ({ ...c, status: c.status === "running" || c.status === "queued" ? "cancelled" : c.status }));
    }
    execs.current.clear();
  }, [updateCell]);

  const connect = useCallback((spec: RuntimeSpec) => {
    setShowConnect(false);
    abandonExecs();
    runtime.start(spec, nb?.name);
  }, [abandonExecs, runtime, nb?.name]);

  // Picked on the Cluster page: start it here, on the notebook you last had open.
  const hasStore = store !== null;
  useEffect(() => {
    if (hasStore && runtime.loaded && runtime.pending) connect(runtime.pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStore, runtime.loaded, runtime.pending]);

  // Notebooks saved before the shared runtime each held their own: keep one, free the rest.
  const migrated = useRef(false);
  useEffect(() => {
    if (!store || !runtime.loaded || migrated.current) return;
    migrated.current = true;
    const ids = Array.from(new Set(store.notebooks.map((n) => n.kernelId).filter(Boolean) as string[]));
    if (!ids.length) return;
    const keep = runtime.kernelId ?? store.notebooks.find((n) => n.id === store.activeId)?.kernelId ?? ids[0];
    runtime.adopt(keep);
    const extra = ids.filter((id) => id !== keep);
    for (const id of extra) api(base, `/api/v1/kernels/${id}`, { method: "DELETE" }).catch(() => {});
    if (extra.length) setNotice(`Freed ${extra.length} older runtime${extra.length === 1 ? "" : "s"} held by other notebooks: this browser now keeps one runtime at a time.`);
    setStore((st) => (st ? { ...st, notebooks: st.notebooks.map((n) => ({ ...n, kernelId: null })) } : st));
  }, [store, runtime, base]);

  // ---------------------------------------------------------------- execution
  const submit = useCallback(async (nbId: string, ids: string[], kernelId: string) => {
    const book = storeRef.current?.notebooks.find((n) => n.id === nbId);
    if (!book) return;
    const ranOn = kernel?.info ? `${kernel.info.hostname} · ${kernel.info.gpu_name ?? "CPU"}` : null;
    for (const id of ids) {
      const cell = book.cells.find((c) => c.id === id);
      const code = liveSource.current.get(id) ?? cell?.source ?? "";
      if (!cell || cell.type !== "code" || !code.trim()) continue;
      updateCell(nbId, id, (c) => ({ ...c, status: "queued", outputs: [], durationSec: null, vramPeakMb: null, ranOn }));
      try {
        const r = await postJson<{ exec_id: string }>(base, `/api/v1/kernels/${kernelId}/execute`, { code });
        execs.current.set(r.exec_id, { nbId, cellId: id, kernelId, since: 0 });
        setExecCount((n) => n + 1);
      } catch (e) {
        updateCell(nbId, id, (c) => ({ ...c, status: "error", outputs: [{ output_type: "error", ename: "TensorSwarm", evalue: "Could not send the cell to the runtime", traceback: e instanceof Error ? e.message : String(e) }] }));
        if (e instanceof ApiError && (e.status === 409 || e.status === 410)) runtime.markDead();
        break;
      }
    }
  }, [base, kernel, runtime, updateCell]);

  const runCells = useCallback((ids: string[]) => {
    if (!nb) return;
    const codeIds = ids.filter((id) => nb.cells.find((c) => c.id === id)?.type === "code");
    if (!codeIds.length) return;
    if (runtime.ready && kernel) {
      submit(nb.id, codeIds, kernel.kernel_id);
      return;
    }
    // Not connected: queue the cells; they run once a runtime is ready. No runtime yet = pick one.
    pending.current = { nbId: nb.id, ids: codeIds };
    for (const id of codeIds) updateCell(nb.id, id, (c) => ({ ...c, status: "queued", outputs: [] }));
    if (!runtime.busy) setShowConnect(true);
  }, [nb, kernel, runtime, submit, updateCell]);

  const unqueue = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    for (const id of p.ids) updateCell(p.nbId, id, (c) => ({ ...c, status: c.status === "queued" ? "idle" : c.status }));
  }, [updateCell]);

  const release = useCallback(async () => {
    abandonExecs();
    unqueue();
    await runtime.release();
    setShowConnect(true);
  }, [abandonExecs, unqueue, runtime]);

  // Flush cells queued while the runtime was starting.
  useEffect(() => {
    const p = pending.current;
    if (!p || !kernel) return;
    if (kernel.status === "READY") {
      pending.current = null;
      submit(p.nbId, p.ids, kernel.kernel_id);
    }
  }, [kernel, submit]);
  useEffect(() => {
    if (runtime.phase === "error") unqueue();   // the progress panel says why
  }, [runtime.phase, unqueue]);

  // Poll running executions and splice their streamed outputs into the cells.
  useEffect(() => {
    if (!execs.current.size) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || !execs.current.size) return;
      busy = true;
      try {
        for (const [execId, e] of Array.from(execs.current.entries())) {
          let res: ExecutionPoll;
          try {
            res = await api<ExecutionPoll>(base, `/api/v1/kernels/${e.kernelId}/executions/${execId}?since=${e.since}`);
          } catch (err) {
            if (err instanceof ApiError && (err.status === 410 || err.status === 409 || err.status === 404)) {
              execs.current.delete(execId);
              runtime.markDead();
              updateCell(e.nbId, e.cellId, (c) => ({ ...c, status: "error", outputs: [...c.outputs, { output_type: "error", ename: "RuntimeDied", evalue: "The runtime stopped", traceback: err.message }] }));
            }
            continue;
          }
          e.since = res.start + res.outputs.length;
          updateCell(e.nbId, e.cellId, (c) => ({
            ...c,
            outputs: c.outputs.slice(0, res.start).concat(res.outputs),
            status: STATUS_MAP[res.status] ?? "error",
            execCount: res.count ?? c.execCount,
            durationSec: res.duration_sec ?? c.durationSec,
            vramPeakMb: res.vram_peak_mb ?? c.vramPeakMb,
          }));
          if (TERMINAL.has(res.status)) {
            execs.current.delete(execId);
            setVarsVersion((v) => v + 1);
          }
        }
      } finally {
        busy = false;
        if (!execs.current.size) setExecCount((n) => n + 1);
      }
    }, 400);
    return () => clearInterval(timer);
  }, [base, execCount, runtime, updateCell]);

  // ---------------------------------------------------------------- cell operations
  const focusCell = useCallback((id: string) => {
    setActiveCell(id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-cell="${id}"] .cm-content`);
      el?.focus();
    });
  }, []);

  const insertCell = useCallback((relativeTo: string | null, where: "above" | "below", type: "code" | "markdown" = "code", source = "") => {
    if (!nb) return null;
    const cell = newCell(type, source);
    updateNb(nb.id, (n) => {
      const idx = relativeTo ? n.cells.findIndex((c) => c.id === relativeTo) : n.cells.length - 1;
      const at = idx < 0 ? n.cells.length : where === "above" ? idx : idx + 1;
      const cells = [...n.cells];
      cells.splice(at, 0, cell);
      return { ...n, cells };
    });
    setActiveCell(cell.id);
    setAutoFocusId(cell.id);
    return cell.id;
  }, [nb, updateNb, focusCell]);

  const deleteCell = useCallback((id: string) => {
    if (!nb) return;
    updateNb(nb.id, (n) => {
      const cells = n.cells.filter((c) => c.id !== id);
      return { ...n, cells: cells.length ? cells : [newCell()] };
    });
  }, [nb, updateNb]);

  const moveCell = useCallback((id: string, dir: -1 | 1) => {
    if (!nb) return;
    updateNb(nb.id, (n) => {
      const i = n.cells.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= n.cells.length) return n;
      const cells = [...n.cells];
      [cells[i], cells[j]] = [cells[j], cells[i]];
      return { ...n, cells };
    });
  }, [nb, updateNb]);

  const runAdvance = useCallback((id: string) => {
    if (!nb) return;
    runCells([id]);
    const i = nb.cells.findIndex((c) => c.id === id);
    const next = nb.cells[i + 1];
    if (next) focusCell(next.id);
    else insertCell(id, "below");
  }, [nb, runCells, focusCell, insertCell]);

  const restart = useCallback(() => {
    if (!nb || !runtime.spec) return;
    abandonExecs();
    runtime.start(runtime.spec, nb.name);
    setNotice("Restarting the runtime on the same hardware: all variables are cleared.");
  }, [nb, runtime, abandonExecs]);

  const runAll = useCallback((which: "all" | "before" | "after") => {
    if (!nb) return;
    const i = activeCell ? nb.cells.findIndex((c) => c.id === activeCell) : -1;
    const cells = which === "all" ? nb.cells : which === "before" ? nb.cells.slice(0, Math.max(0, i)) : nb.cells.slice(Math.max(0, i));
    runCells(cells.map((c) => c.id));
  }, [nb, activeCell, runCells]);

  const clearOutputs = useCallback(() => {
    if (!nb) return;
    updateNb(nb.id, (n) => ({ ...n, cells: n.cells.map((c) => ({ ...c, outputs: [], status: "idle", execCount: null, durationSec: null, vramPeakMb: null })) }));
  }, [nb, updateNb]);

  // ---------------------------------------------------------------- notebooks (files)
  const addNotebook = useCallback((book: Notebook) => {
    setStore((s) => (s ? { notebooks: [book, ...s.notebooks], activeId: book.id } : { notebooks: [book], activeId: book.id }));
  }, []);

  const openSample = useCallback((s: Sample) => {
    addNotebook(fromPercentPy(s.code, s.title));
  }, [addNotebook]);

  const insertSample = useCallback((s: Sample) => {
    if (!nb) return;
    const cells = fromPercentPy(s.code, s.title).cells;
    updateNb(nb.id, (n) => ({ ...n, cells: [...n.cells, ...cells] }));
    setNotice(`Inserted ${cells.length} cells from "${s.title}" at the end.`);
  }, [nb, updateNb]);

  const insertCode = useCallback((code: string) => {
    if (!nb) return;
    const cell = newCell("code", code);
    updateNb(nb.id, (n) => ({ ...n, cells: [...n.cells, cell] }));
    setNotice("Inserted a dataset cell at the end.");
  }, [nb, updateNb]);

  // ?sample=<id> from the Jobs page opens that sample as a new notebook (once).
  useEffect(() => {
    const id = params.get("sample");
    if (!id || handledSample.current || !store || !samples.length) return;
    const s = samples.find((x) => x.id === id);
    handledSample.current = true;
    if (s) openSample(s);
    router.replace("/notebook");
  }, [params, samples, store, openSample, router]);

  const importFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const name = file.name.replace(/\.(ipynb|py)$/i, "");
      addNotebook(file.name.toLowerCase().endsWith(".ipynb") ? fromIpynb(text, name) : fromPercentPy(text, name));
      setNotice(`Imported ${file.name}.`);
    } catch (e) {
      setNotice(`Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [addNotebook]);

  const safeName = (nb?.name || "notebook").replace(/[^\w.-]+/g, "_");

  const runAsJob = useCallback(async () => {
    if (!nb) return;
    const share = runtime.spec?.gpus ?? 1;
    if (kernel?.status === "READY" && share > 0 && kernel.num_gpus + share > 1 &&
        !window.confirm("This notebook's runtime still holds its GPU share, so the job waits until you disconnect it. Submit anyway?")) {
      return;
    }
    try {
      const job = await postJson<JobResult>(base, "/api/v1/jobs/submit", {
        script_code: toScript(nb), target_node_ip: runtime.spec?.ip || null, num_gpus: share, job_name: nb.name,
      });
      router.push(`/jobs?job=${job.job_id}`);
    } catch (e) {
      setNotice(`Job submission failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [base, nb, kernel, router, runtime.spec]);

  // ---------------------------------------------------------------- keyboard (Colab-style Ctrl+M chords)
  const chord = useRef(0);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (nb) download(`${safeName}.ipynb`, toIpynb(nb));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        chord.current = Date.now();
        return;
      }
      if (Date.now() - chord.current > 1500 || !nb) return;
      chord.current = 0;
      const id = activeCell ?? nb.cells[nb.cells.length - 1]?.id ?? null;
      const k = e.key.toLowerCase();
      if (k === "i") runtime.interrupt();
      else if (k === "b") insertCell(id, "below");
      else if (k === "a") insertCell(id, "above");
      else if (k === "d" && id) deleteCell(id);
      else if (k === "m" && id) updateCell(nb.id, id, (c) => ({ ...c, type: "markdown", outputs: [] }));
      else if (k === "y" && id) updateCell(nb.id, id, (c) => ({ ...c, type: "code" }));
      else if (k === ".") restart();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nb, activeCell, runtime, insertCell, deleteCell, updateCell, restart, safeName]);

  // ---------------------------------------------------------------- header resource chip
  const runtimeNode = useMemo(() => {
    const ip = kernel?.target_node_ip || kernel?.info?.node_ip || runtime.spec?.ip;
    if (!ip) return undefined;
    const same = nodes.filter((n) => n.tailscale_ip === ip);
    return same.find((n) => n.gpu_count > 0) ?? same[0];
  }, [nodes, kernel, runtime.spec?.ip]);
  const runtimeGpu = runtimeNode?.gpus[0];
  const anyRunning = nb?.cells.some((c) => c.status === "running" || c.status === "queued") ?? false;
  // Where a runtime error shows: start failures in the progress panel, a stopped runtime in the
  // "No runtime" prompt, anything else (e.g. interrupt failed) in the notice bar.
  const startFailed = runtime.phase === "error" && runtime.errorKind !== "stopped";
  const stopped = runtime.phase === "error" && runtime.errorKind === "stopped";
  const otherError = runtime.error && runtime.phase !== "error" ? runtime.error : null;

  if (!store || !nb) return <div className="p-10 text-center text-sm text-muted">Loading notebooks…</div>;

  return (
    <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-6">
    <PageHeader compact title="Notebook" subtitle="Cells run in a persistent Python runtime on a worker's GPU, or CPU only on any PC." />
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        {/* ------------------------------------------------------------ header */}
        <div className="sticky top-14 z-20 -mx-1 mb-3 rounded-2xl border border-line glass-border glass px-3 py-2 lg:top-3">
          <div className="flex flex-wrap items-center gap-2">
            {renaming ? (
              <input autoFocus defaultValue={nb.name}
                onBlur={(e) => { updateNb(nb.id, (n) => ({ ...n, name: e.target.value.trim() || n.name })); setRenaming(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="w-56 rounded-lg border border-accent bg-elevated px-2 py-1 text-[15px] font-semibold text-fg focus:outline-none" />
            ) : (
              <button onClick={() => setRenaming(true)} title="Rename" className="max-w-[18rem] truncate rounded-lg px-2 py-1 text-[15px] font-semibold text-fg transition-colors duration-150 hover:bg-elevated">
                {nb.name}
              </button>
            )}
            <select value={nb.id} onChange={(e) => setStore((s) => (s ? { ...s, activeId: e.target.value } : s))}
              className="max-w-[12rem] rounded-lg border border-line bg-elevated px-2 py-1.5 text-[12.5px] text-fg/90 transition-colors duration-150 hover:border-line-strong" aria-label="Switch notebook">
              {store.notebooks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            <ToolGroup label="Notebook files">
            <Button variant="ghost" className={TOOL} onClick={() => addNotebook(newNotebook())}>New</Button>
            <Button variant="ghost" className={TOOL} onClick={() => fileInput.current?.click()} title="Open a .ipynb (Colab/Jupyter) or .py file">Import</Button>
            <Button variant="ghost" className={TOOL} onClick={() => download(`${safeName}.ipynb`, toIpynb(nb))} title="Download as .ipynb (opens in Colab/Jupyter)">Export .ipynb</Button>
            <Button variant="ghost" className={TOOL} onClick={() => download(`${safeName}.py`, toPercentPy(nb), "text/x-python")}>Export .py</Button>
            <Button variant="ghost" className={TOOL} onClick={() => {
              if (window.confirm(`Delete notebook "${nb.name}"? This cannot be undone.`)) {
                setStore((s) => {
                  if (!s) return s;
                  const rest = s.notebooks.filter((n) => n.id !== nb.id);
                  const list = rest.length ? rest : [WELCOME()];
                  return { notebooks: list, activeId: list[0].id };
                });
              }
            }}>Delete</Button>
            </ToolGroup>
            <input ref={fileInput} type="file" accept=".ipynb,.py" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />

            {/* runtime chip */}
            <div className="ml-auto flex items-center gap-2">
              {kernel && <StatusPill status={kernel.status} />}
              {runtime.ready && runtime.spec && (
                <span className="hidden items-center gap-2 rounded-lg border border-line px-2 py-1 text-[11px] text-fg/85 lg:flex"
                  title="The runtime this notebook uses, with live telemetry of its PC">
                  <span className="max-w-[16rem] truncate">{runtime.spec.hostname} · {describeSpec(runtime.spec, runtime.spec.gpus > 0 ? runtimeGpu?.name : null)}</span>
                  {runtime.spec.gpus > 0 && runtimeGpu ? (
                    <>
                      <MiniBar label="GPU" value={runtimeGpu.gpu_utilization_pct} />
                      <MiniBar label="VRAM" value={pct(runtimeGpu.used_vram_mb, runtimeGpu.total_vram_mb)} title={`${fmtMB(runtimeGpu.used_vram_mb)} / ${fmtMB(runtimeGpu.total_vram_mb)}`} />
                    </>
                  ) : runtimeNode ? (
                    <MiniBar label="CPU" value={runtimeNode.host.cpu_utilization_pct} />
                  ) : null}
                </span>
              )}
              {runtime.kernelId || runtime.busy ? (
                <Button onClick={release} title="Stop the runtime and free its GPU seats and CPU cores">Disconnect &amp; release</Button>
              ) : (
                <Button variant="primary" onClick={() => setShowConnect(true)}>Connect</Button>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line/80 pt-2">
            <ToolGroup label="Add cells">
              <Button variant="ghost" className={TOOL} onClick={() => insertCell(activeCell, "below", "code")}>+ Code</Button>
              <Button variant="ghost" className={TOOL} onClick={() => insertCell(activeCell, "below", "markdown")}>+ Text</Button>
            </ToolGroup>
            <ToolGroup label="Run cells">
              <Button variant="ghost" className={`${TOOL} font-semibold`} onClick={() => runAll("all")} title="Run every cell from the top"><IconJobs size={14} /> Run all</Button>
              <Button variant="ghost" className={TOOL} onClick={() => runAll("before")} disabled={!activeCell}>Run before</Button>
              <Button variant="ghost" className={TOOL} onClick={() => runAll("after")} disabled={!activeCell}>Run selected & after</Button>
            </ToolGroup>
            <ToolGroup label="Runtime control">
              <Button variant="ghost" className={TOOL} onClick={() => runtime.interrupt()} disabled={!anyRunning} title="Ctrl+M I"><IconStop size={13} /> Interrupt</Button>
              <Button variant="ghost" className={TOOL} onClick={restart} disabled={!kernel || kernel.status !== "READY"} title="Clears all variables (Ctrl+M .)"><IconRefresh size={14} /> Restart</Button>
              <Button variant="ghost" className={TOOL} onClick={clearOutputs}>Clear outputs</Button>
            </ToolGroup>
            <ToolGroup label="Batch">
              <Button variant="ghost" className={TOOL} onClick={runAsJob} title="Submit all code cells as one batch job (Jobs page)">Run as batch job</Button>
            </ToolGroup>
            <span className="ml-auto text-[12px] text-muted">
              {runtime.kernelId && runtime.spec ? `${runtime.spec.hostname} · ${describeSpec(runtime.spec)}` : "No runtime"}
            </span>
          </div>
        </div>

        {(runtime.busy || startFailed) && (
          <RuntimeProgress phase={runtime.phase} spec={runtime.spec} error={runtime.error} startedAt={runtime.startedAt}
            failedAfterAccept={runtime.errorKind === "failed"}
            onCancel={() => { unqueue(); runtime.release(); }}
            onRetry={() => runtime.spec && connect(runtime.spec)}
            onPickOther={() => { runtime.setError(null); setShowConnect(true); }} />
        )}

        {runtime.loaded && !runtime.kernelId && !runtime.busy && !startFailed && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-line-strong bg-surface/70 px-4 py-3">
            <div className="text-[13px]">
              <div className={`font-semibold ${stopped ? "text-warn-fg" : "text-fg"}`}>{stopped ? runtime.error : "No runtime connected"}</div>
              <div className="text-muted">Pick GPU seats for a GPU runtime, or only CPU cores for a CPU runtime. Cells you run wait for it.</div>
            </div>
            <Button variant="primary" onClick={() => { runtime.setError(null); setShowConnect(true); }}>Connect</Button>
          </div>
        )}

        {(notice || otherError) && (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs text-fg/85">
            <span className={otherError ? "text-danger-fg" : ""}>{otherError ?? notice}</span>
            <button onClick={() => { setNotice(null); if (otherError) runtime.setError(null); }} className="text-muted hover:text-fg" aria-label="Dismiss"><IconClose size={14} /></button>
          </div>
        )}

        {/* ------------------------------------------------------------ cells */}
        <div className="space-y-0.5 pb-40 pt-2">
          {nb.cells.map((cell) => (
            <div key={cell.id} data-cell={cell.id}>
              <NotebookCell
                cell={cell}
                active={activeCell === cell.id}
                autoFocus={autoFocusId === cell.id}
                actions={{
                  onChange: (src) => { liveSource.current.set(cell.id, src); updateCell(nb.id, cell.id, (c) => ({ ...c, source: src })); },
                  onFocus: () => setActiveCell(cell.id),
                  onRun: () => runCells([cell.id]),
                  onRunAdvance: () => runAdvance(cell.id),
                  onRunInsert: () => { runCells([cell.id]); insertCell(cell.id, "below"); },
                  onDelete: () => deleteCell(cell.id),
                  onMove: (d) => moveCell(cell.id, d),
                  onClearOutput: () => updateCell(nb.id, cell.id, (c) => ({ ...c, outputs: [], status: "idle", durationSec: null, vramPeakMb: null })),
                  onToggleType: () => updateCell(nb.id, cell.id, (c) => ({ ...c, type: c.type === "code" ? "markdown" : "code", outputs: [], status: "idle" })),
                  onInsert: (where, type) => insertCell(cell.id, where, type),
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="xl:sticky xl:top-3 xl:h-[calc(100vh-24px)]">
        <SidePanel kernel={kernel} kernelError={runtime.error} varsVersion={varsVersion} onInsertSample={insertSample} onOpenSample={openSample} onInsertCode={insertCode} />
      </div>

      {showConnect && (
        <ConnectDialog onConnect={connect}
          onClose={() => { setShowConnect(false); if (!runtime.busy && !runtime.ready) unqueue(); }} />
      )}
    </div>
    </main>
  );
}

/** Layout-only: a bordered cluster of related toolbar buttons. */
const TOOL = "min-h-[30px] px-2.5 text-[12.5px]";
function ToolGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <div role="group" aria-label={label} className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-elevated/60 p-0.5">{children}</div>;
}

function MiniBar({ label, value, title }: { label: string; value: number; title?: string }) {
  return (
    <span className="flex items-center gap-1" title={title ?? `${Math.round(value)}%`}>
      <span className="text-muted">{label}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-elevated">
        <span className="block h-1.5 rounded-full bg-viz transition-[width] duration-[400ms]" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
    </span>
  );
}
