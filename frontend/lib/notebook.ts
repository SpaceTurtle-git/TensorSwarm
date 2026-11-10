import type { CellOutput } from "./types";
import { storageGet, storageSet } from "./api";

export type CellType = "code" | "markdown";
export type CellStatus = "idle" | "queued" | "running" | "ok" | "error" | "interrupted" | "cancelled";

export interface Cell {
  id: string;
  type: CellType;
  source: string;
  outputs: CellOutput[];
  execCount?: number | null;
  status?: CellStatus;
  durationSec?: number | null;
  vramPeakMb?: number | null;
  ranOn?: string | null;          // "hostname · GPU" of the runtime that produced the outputs
}

export interface Notebook {
  id: string;
  name: string;
  cells: Cell[];
  updatedAt: number;
  kernelId?: string | null;       // runtime attached to this notebook (re-attached after reload)
  target?: string | null;         // preferred node IP ("" = any GPU)
  gpuShare?: number;
  cpuCores?: number;              // CPU cores reserved for the runtime (torch threads)
}

const STORE_KEY = "tensorswarm-notebooks-v1";
const ACTIVE_KEY = "tensorswarm-active-notebook";

export function uid(prefix = "c"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;
}

export function newCell(type: CellType = "code", source = ""): Cell {
  return { id: uid(), type, source, outputs: [], execCount: null, status: "idle" };
}

export function newNotebook(name = "Untitled notebook", cells?: Cell[]): Notebook {
  return {
    id: uid("nb"),
    name,
    cells: cells && cells.length ? cells : [newCell("code", 'import torch\nprint(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU only")')],
    updatedAt: Date.now(),
    kernelId: null,
    target: "",
    gpuShare: 1,
  };
}

export function loadNotebooks(): { notebooks: Notebook[]; activeId: string | null } {
  try {
    const raw = storageGet(STORE_KEY);
    const notebooks: Notebook[] = raw ? JSON.parse(raw) : [];
    // A reload interrupts anything that was running: nothing is "running" any more.
    for (const nb of notebooks) {
      for (const c of nb.cells) {
        if (c.status === "running" || c.status === "queued") c.status = "idle";
      }
    }
    return { notebooks, activeId: storageGet(ACTIVE_KEY) };
  } catch {
    return { notebooks: [], activeId: null };
  }
}

/** Saves all notebooks. Falls back to dropping outputs (images can be large) if storage is full. */
export function saveNotebooks(notebooks: Notebook[], activeId: string | null): "ok" | "no-outputs" | "failed" {
  storageSet(ACTIVE_KEY, activeId);
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(notebooks));
    return "ok";
  } catch {
    try {
      const slim = notebooks.map((nb) => ({ ...nb, cells: nb.cells.map((c) => ({ ...c, outputs: [] })) }));
      window.localStorage.setItem(STORE_KEY, JSON.stringify(slim));
      return "no-outputs";
    } catch {
      return "failed";
    }
  }
}

// ----------------------------------------------------------------------------
// Text helpers for outputs
// ----------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Terminal-ish rendering: strip ANSI colors, honor \r (progress bars overwrite their line). */
export function terminalText(text: string): string {
  const clean = text.replace(ANSI, "");
  if (!clean.includes("\r")) return clean;
  return clean
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      // "abc\r" at the end of a chunk means the next write overwrites; keep the last non-empty part
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
      return "";
    })
    .join("\n");
}

// ----------------------------------------------------------------------------
// Jupyter .ipynb (nbformat 4) import / export — opens in Colab, Jupyter and VS Code
// ----------------------------------------------------------------------------

function toLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  return parts.map((p, i) => (i < parts.length - 1 ? p + "\n" : p)).filter((p, i, a) => !(i === a.length - 1 && p === ""));
}

function joinSource(src: unknown): string {
  return Array.isArray(src) ? src.join("") : typeof src === "string" ? src : "";
}

export function toIpynb(nb: Notebook): string {
  const cells = nb.cells.map((c) => {
    if (c.type === "markdown") {
      return { cell_type: "markdown", id: c.id, metadata: {}, source: toLines(c.source) };
    }
    const outputs = c.outputs.map((o) => {
      switch (o.output_type) {
        case "stream":
          return { output_type: "stream", name: o.name, text: toLines(o.text) };
        case "error":
          return { output_type: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback.split("\n") };
        case "execute_result":
          return { output_type: "execute_result", execution_count: o.execution_count ?? c.execCount ?? null, metadata: {},
            data: Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, k.startsWith("image/") ? v : toLines(v)])) };
        default:
          return { output_type: "display_data", metadata: {},
            data: Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, k.startsWith("image/") ? v : toLines(v)])) };
      }
    });
    return { cell_type: "code", id: c.id, metadata: {}, execution_count: c.execCount ?? null, source: toLines(c.source), outputs };
  });
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python" },
      accelerator: "GPU",
      tensorswarm: { name: nb.name },
    },
    cells,
  }, null, 1);
}

export function fromIpynb(json: string, fallbackName: string): Notebook {
  const data = JSON.parse(json);
  if (!Array.isArray(data?.cells)) throw new Error("Not a Jupyter notebook (no 'cells' list).");
  const cells: Cell[] = data.cells
    .filter((c: { cell_type?: string }) => c.cell_type === "code" || c.cell_type === "markdown")
    .map((c: Record<string, unknown>) => {
      const cell = newCell(c.cell_type as CellType, joinSource(c.source));
      if (c.cell_type === "code" && Array.isArray(c.outputs)) {
        cell.execCount = (c.execution_count as number) ?? null;
        cell.outputs = (c.outputs as Record<string, unknown>[]).map((o): CellOutput => {
          if (o.output_type === "stream") return { output_type: "stream", name: (o.name as "stdout") || "stdout", text: joinSource(o.text) };
          if (o.output_type === "error") return { output_type: "error", ename: String(o.ename ?? "Error"), evalue: String(o.evalue ?? ""), traceback: joinSource((o.traceback as string[] | undefined)?.map((l) => l + "\n")) };
          const d = (o.data as Record<string, unknown>) || {};
          const mime = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, joinSource(v)]));
          return o.output_type === "execute_result" ? { output_type: "execute_result", data: mime } : { output_type: "display_data", data: mime };
        });
        if (cell.outputs.length) cell.status = "ok";
      }
      return cell;
    });
  const name = data?.metadata?.tensorswarm?.name || data?.metadata?.colab?.name?.replace(/\.ipynb$/, "") || fallbackName;
  return newNotebook(name, cells);
}

// ----------------------------------------------------------------------------
// Percent-format .py ("# %%" cells, "# %% [markdown]" text cells) — VS Code / Jupytext
// ----------------------------------------------------------------------------

export function fromPercentPy(code: string, name: string): Notebook {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const cells: Cell[] = [];
  let cur: { type: CellType; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    let text = cur.lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (cur.type === "markdown") text = text.split("\n").map((l) => l.replace(/^# ?/, "")).join("\n");
    if (text.trim()) cells.push(newCell(cur.type, text));
  };
  const hasMarkers = lines.some((l) => /^# %%/.test(l));
  if (!hasMarkers) return newNotebook(name, [newCell("code", code.trim())]);
  let inHeader = true;
  for (const line of lines) {
    const m = /^# %%(.*)$/.exec(line);
    if (m) {
      inHeader = false;
      flush();
      cur = { type: /\[markdown\]/i.test(m[1]) ? "markdown" : "code", lines: [] };
      continue;
    }
    if (inHeader) continue;   // "# title: ..." metadata block before the first cell
    cur?.lines.push(line);
  }
  flush();
  return newNotebook(name, cells);
}

export function toPercentPy(nb: Notebook): string {
  const parts = [`# TensorSwarm notebook: ${nb.name}`, ""];
  for (const c of nb.cells) {
    if (c.type === "markdown") {
      parts.push("# %% [markdown]", ...c.source.split("\n").map((l) => (l ? `# ${l}` : "#")), "");
    } else {
      parts.push("# %%", c.source, "");
    }
  }
  return parts.join("\n");
}

/** All code cells as one script (for "Run as batch job"). Shell (!) lines are commented out. */
export function toScript(nb: Notebook): string {
  return nb.cells
    .filter((c) => c.type === "code")
    .map((c) => c.source.split("\n").map((l) => (l.trimStart().startsWith("!") ? `# (shell, notebook only) ${l}` : l)).join("\n"))
    .join("\n\n");
}

export function download(filename: string, text: string, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
