"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, postJson } from "../../lib/api";
import { defaultCores, useCluster, useSamples } from "../../lib/cluster";
import { fmtMB, pct } from "../../lib/format";
import {
  type Cell, type CellStatus, type Notebook, download, fromIpynb, fromPercentPy, loadNotebooks, newCell,
  newNotebook, saveNotebooks, toIpynb, toPercentPy, toScript,
} from "../../lib/notebook";
import { useRuntime } from "../../lib/runtime";
import type { ExecutionPoll, JobResult, Sample } from "../../lib/types";
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
    newCell("markdown", "# TensorSwarm notebook\nCells run in a **persistent Python runtime on a worker's GPU** (or CPU only, on any PC). Press **Shift+Enter** to run a cell. Open the *Samples* tab on the right for ready-made tests, and the *Data* tab for datasets. `ts.map(fn, items)` spreads work over the CPU cores of every PC."),
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
    let active = activeId && nbs.some((n) => n.id === activeId) ? activeId : nbs[0].id;
    const target = params.get("target");
    if (target) {
      const nb = newNotebook(`Notebook on ${target}`);
      nb.target = target;
      nbs.unshift(nb);
      active = nb.id;
    }
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
  const activeId = store?.activeId ?? null;
  const setKernelId = useCallback((id: string | null) => {
    if (activeId) updateNb(activeId, (n) => ({ ...n, kernelId: id }));
  }, [activeId, updateNb]);
  const runtime = useRuntime(base, nb?.kernelId ?? null, setKernelId);
  const kernel = runtime.kernel;

  const connect = useCallback(async (target: string, share: number, cores: number) => {
    if (!nb) return;
    updateNb(nb.id, (n) => ({ ...n, target, gpuShare: share, cpuCores: cores }));
    try {
      if (kernel && (kernel.status === "READY" || kernel.status === "STARTING")) await runtime.disconnect();
      await runtime.connect(target, share, nb.name, cores);
    } catch (e) {
      runtime.setError(e instanceof Error ? e.message : String(e));
    }
  }, [nb, kernel, runtime, updateNb]);

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
    // Not connected: connect with this notebook's settings, then run (like Colab).
    pending.current = { nbId: nb.id, ids: codeIds };
    for (const id of codeIds) updateCell(nb.id, id, (c) => ({ ...c, status: "queued", outputs: [] }));
    if (!kernel || kernel.status === "DEAD" || kernel.status === "ERROR") {
      runtime.connect(nb.target || "", nb.gpuShare ?? 1, nb.name, nb.cpuCores ?? defaultCores(nb.gpuShare ?? 1)).catch((e) => {
        runtime.setError(e instanceof Error ? e.message : String(e));
        // Nothing will run these: put them back to idle instead of leaving them "queued".
        pending.current = null;
        for (const id of codeIds) updateCell(nb.id, id, (c) => ({ ...c, status: c.status === "queued" ? "idle" : c.status }));
      });
    }
  }, [nb, kernel, runtime, submit, updateCell]);

  // Flush cells queued while the runtime was starting.
  useEffect(() => {
    const p = pending.current;
    if (!p || !kernel) return;
    if (kernel.status === "READY") {
      pending.current = null;
      submit(p.nbId, p.ids, kernel.kernel_id);
    } else if (kernel.status === "ERROR" || kernel.status === "DEAD") {
      pending.current = null;
      for (const id of p.ids) {
        updateCell(p.nbId, id, (c) => ({ ...c, status: "error", outputs: [{ output_type: "error", ename: "RuntimeError", evalue: "Could not start the runtime", traceback: kernel.error ?? "The runtime failed to start." }] }));
      }
    }
  }, [kernel, submit, updateCell]);

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

  const restart = useCallback(async () => {
    if (!nb) return;
    const target = nb.target || "";
    await runtime.disconnect();
    updateNb(nb.id, (n) => ({ ...n, cells: n.cells.map((c) => ({ ...c, execCount: c.execCount, status: c.status === "running" || c.status === "queued" ? "cancelled" : c.status })) }));
    execs.current.clear();
    try {
      await runtime.connect(target, nb.gpuShare ?? 1, nb.name, nb.cpuCores ?? defaultCores(nb.gpuShare ?? 1));
      setNotice("Runtime restarted: all variables were cleared.");
    } catch (e) {
      runtime.setError(e instanceof Error ? e.message : String(e));
    }
  }, [nb, kernel, runtime, updateNb]);

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
    const book = fromPercentPy(s.code, s.title);
    book.target = nb?.target ?? "";
    addNotebook(book);
  }, [addNotebook, nb?.target]);

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
    const share = nb.gpuShare ?? 1;
    if (kernel?.status === "READY" && kernel.num_gpus + share > 1 &&
        !window.confirm("This notebook's runtime still holds its GPU share, so the job waits until you disconnect it. Submit anyway?")) {
      return;
    }
    try {
      const job = await postJson<JobResult>(base, "/api/v1/jobs/submit", {
        script_code: toScript(nb), target_node_ip: nb.target || null, num_gpus: share, job_name: nb.name,
      });
      router.push(`/jobs?job=${job.job_id}`);
    } catch (e) {
      setNotice(`Job submission failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [base, nb, kernel, router]);

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
    const ip = kernel?.target_node_ip || kernel?.info?.node_ip;
    if (!ip) return undefined;
    const same = nodes.filter((n) => n.tailscale_ip === ip);
    return same.find((n) => n.gpu_count > 0) ?? same[0];
  }, [nodes, kernel]);
  const runtimeGpu = runtimeNode?.gpus[0];
  const anyRunning = nb?.cells.some((c) => c.status === "running" || c.status === "queued") ?? false;

  if (!store || !nb) return <div className="p-10 text-center text-sm text-slate-500">Loading notebooks…</div>;

  return (
    <div className="mx-auto grid max-w-[1600px] gap-4 px-4 py-4 md:px-6 xl:grid-cols-[1fr_360px]">
      <div className="min-w-0">
        {/* ------------------------------------------------------------ header */}
        <div className="sticky top-[49px] z-20 -mx-1 mb-3 rounded-xl border border-slate-800 bg-slate-950/95 px-3 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            {renaming ? (
              <input autoFocus defaultValue={nb.name}
                onBlur={(e) => { updateNb(nb.id, (n) => ({ ...n, name: e.target.value.trim() || n.name })); setRenaming(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="w-56 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100 focus:outline-none" />
            ) : (
              <button onClick={() => setRenaming(true)} title="Rename" className="max-w-[18rem] truncate rounded px-1.5 py-1 text-sm font-semibold text-slate-100 hover:bg-slate-800">
                {nb.name}
              </button>
            )}
            <select value={nb.id} onChange={(e) => setStore((s) => (s ? { ...s, activeId: e.target.value } : s))}
              className="max-w-[12rem] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300" aria-label="Switch notebook">
              {store.notebooks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
            <Button variant="ghost" onClick={() => addNotebook(newNotebook())}>New</Button>
            <Button variant="ghost" onClick={() => fileInput.current?.click()} title="Open a .ipynb (Colab/Jupyter) or .py file">Import</Button>
            <Button variant="ghost" onClick={() => download(`${safeName}.ipynb`, toIpynb(nb))} title="Download as .ipynb (opens in Colab/Jupyter)">Export .ipynb</Button>
            <Button variant="ghost" onClick={() => download(`${safeName}.py`, toPercentPy(nb), "text/x-python")}>Export .py</Button>
            <Button variant="ghost" onClick={() => {
              if (window.confirm(`Delete notebook "${nb.name}"? This cannot be undone.`)) {
                if (kernel?.status === "READY") runtime.disconnect();
                setStore((s) => {
                  if (!s) return s;
                  const rest = s.notebooks.filter((n) => n.id !== nb.id);
                  const list = rest.length ? rest : [WELCOME()];
                  return { notebooks: list, activeId: list[0].id };
                });
              }
            }}>Delete</Button>
            <input ref={fileInput} type="file" accept=".ipynb,.py" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />

            {/* runtime chip */}
            <div className="ml-auto flex items-center gap-2">
              {kernel && <StatusPill status={kernel.status} />}
              {kernel?.status === "READY" && runtimeGpu && (
                <button onClick={() => setShowConnect(true)} className="hidden items-center gap-2 rounded-lg border border-slate-800 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-600 lg:flex"
                  title="Live GPU telemetry of the connected worker">
                  <span className="max-w-[10rem] truncate">{runtimeGpu.name.replace("NVIDIA GeForce ", "")} · {runtimeNode?.hostname}</span>
                  <MiniBar label="GPU" value={runtimeGpu.gpu_utilization_pct} />
                  <MiniBar label="VRAM" value={pct(runtimeGpu.used_vram_mb, runtimeGpu.total_vram_mb)} title={`${fmtMB(runtimeGpu.used_vram_mb)} / ${fmtMB(runtimeGpu.total_vram_mb)}`} />
                </button>
              )}
              {kernel?.status === "READY" || kernel?.status === "STARTING" ? (
                <Button onClick={() => runtime.disconnect()} title="Stop the runtime and free its GPU share">Disconnect</Button>
              ) : (
                <Button variant="primary" onClick={() => setShowConnect(true)}>Connect</Button>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-800/80 pt-2">
            <Button onClick={() => insertCell(activeCell, "below", "code")}>+ Code</Button>
            <Button onClick={() => insertCell(activeCell, "below", "markdown")}>+ Text</Button>
            <span className="mx-1 h-4 w-px bg-slate-800" />
            <Button onClick={() => runAll("all")} title="Run every cell from the top">▶ Run all</Button>
            <Button variant="ghost" onClick={() => runAll("before")} disabled={!activeCell}>Run before</Button>
            <Button variant="ghost" onClick={() => runAll("after")} disabled={!activeCell}>Run selected & after</Button>
            <Button variant="ghost" onClick={() => runtime.interrupt()} disabled={!anyRunning} title="Ctrl+M I">■ Interrupt</Button>
            <Button variant="ghost" onClick={restart} disabled={!kernel || kernel.status !== "READY"} title="Clears all variables (Ctrl+M .)">↻ Restart</Button>
            <Button variant="ghost" onClick={clearOutputs}>Clear outputs</Button>
            <span className="mx-1 h-4 w-px bg-slate-800" />
            <Button variant="ghost" onClick={runAsJob} title="Submit all code cells as one batch job (Jobs page)">Run as batch job</Button>
            <span className="ml-auto text-[11px] text-slate-500">
              {nb.target ? `target ${nb.target}` : "any GPU"} · share {nb.gpuShare ?? 1}
            </span>
          </div>
        </div>

        {(notice || runtime.error) && (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300">
            <span className={runtime.error ? "text-rose-300" : ""}>{runtime.error ?? notice}</span>
            <button onClick={() => { setNotice(null); runtime.setError(null); }} className="text-slate-500 hover:text-white" aria-label="Dismiss">✕</button>
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

      <div className="xl:sticky xl:top-[60px] xl:h-[calc(100vh-76px)]">
        <SidePanel kernel={kernel} kernelError={runtime.error} varsVersion={varsVersion} onInsertSample={insertSample} onOpenSample={openSample} onInsertCode={insertCode} />
      </div>

      {showConnect && (
        <ConnectDialog initialTarget={nb.target ?? ""} initialShare={nb.gpuShare ?? 1}
          initialCores={nb.cpuCores ?? defaultCores(nb.gpuShare ?? 1)}
          onClose={() => setShowConnect(false)}
          onConnect={(t, s, c) => { setShowConnect(false); connect(t, s, c); }} />
      )}
    </div>
  );
}

function MiniBar({ label, value, title }: { label: string; value: number; title?: string }) {
  return (
    <span className="flex items-center gap-1" title={title ?? `${Math.round(value)}%`}>
      <span className="text-slate-500">{label}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-800">
        <span className="block h-1.5 rounded-full" style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: "var(--viz-series)" }} />
      </span>
    </span>
  );
}
