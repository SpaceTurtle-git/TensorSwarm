"use client";

import dynamic from "next/dynamic";
import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Cell } from "../../lib/notebook";
import { fmtDuration, fmtMB } from "../../lib/format";
import CellOutputs from "./CellOutputs";

const CodeEditor = dynamic(() => import("../CodeEditor"), {
  ssr: false,
  loading: () => <div className="h-10 animate-pulse rounded bg-surface" />,
});

export interface CellActions {
  onChange: (source: string) => void;
  onFocus: () => void;
  onRun: () => void;
  onRunAdvance: () => void;
  onRunInsert: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onClearOutput: () => void;
  onToggleType: () => void;
  onInsert: (where: "above" | "below", type: "code" | "markdown") => void;
}

function RunButton({ cell, onRun }: { cell: Cell; onRun: () => void }) {
  const busy = cell.status === "running";
  const queued = cell.status === "queued";
  return (
    <div className="flex w-12 shrink-0 flex-col items-center pt-2">
      <button
        onClick={onRun}
        title={busy ? "Running…" : queued ? "Queued" : "Run cell (Shift+Enter)"}
        aria-label="Run cell"
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          busy ? "bg-viz/20 text-fg" : queued ? "bg-fg/5 text-fg/85" : "bg-elevated text-fg/85 hover:bg-accent-hover hover:text-accent-fg"
        }`}
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-warn border-t-transparent" />
        ) : queued ? (
          <span className="text-[11px]">⏳</span>
        ) : (
          <svg viewBox="0 0 16 16" className="ml-0.5 h-3.5 w-3.5 fill-current" aria-hidden><path d="M4 2.5v11l9-5.5z" /></svg>
        )}
      </button>
      <span className="mt-1 font-mono text-[10px] text-muted">[{cell.execCount ?? (busy ? "*" : " ")}]</span>
    </div>
  );
}

function StatusLine({ cell }: { cell: Cell }) {
  if (!cell.status || cell.status === "idle" || cell.status === "queued") return null;
  const icon = { running: "●", ok: "✓", error: "✕", interrupted: "■", cancelled: "–" }[cell.status] ?? "";
  const color = { running: "text-fg", ok: "text-ok-fg", error: "text-danger-fg", interrupted: "text-warn-fg", cancelled: "text-muted" }[cell.status] ?? "text-muted";
  const label = { running: "running", ok: "done", error: "error", interrupted: "interrupted", cancelled: "cancelled" }[cell.status];
  return (
    <div className="flex flex-wrap items-center gap-x-3 px-3 pb-1.5 text-[10.5px] text-muted">
      <span className={color}>{icon} {label}</span>
      {cell.durationSec !== null && cell.durationSec !== undefined && <span>{fmtDuration(cell.durationSec)}</span>}
      {cell.vramPeakMb ? <span title="Peak VRAM allocated by PyTorch during this cell">peak VRAM {fmtMB(cell.vramPeakMb)}</span> : null}
      {cell.ranOn && <span>on {cell.ranOn}</span>}
    </div>
  );
}

export default function NotebookCell({ cell, active, autoFocus = false, actions }: { cell: Cell; active: boolean; autoFocus?: boolean; actions: CellActions }) {
  const [editingMd, setEditingMd] = useState(cell.type === "markdown" && !cell.source.trim());
  const running = cell.status === "running" || cell.status === "queued";

  const toolbar = (
    <div className={`absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-md border border-line-strong bg-surface px-1 py-0.5 shadow-lg transition-opacity ${active ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}>
      <IconBtn label="Move up" onClick={() => actions.onMove(-1)}>↑</IconBtn>
      <IconBtn label="Move down" onClick={() => actions.onMove(1)}>↓</IconBtn>
      <IconBtn label={cell.type === "code" ? "Convert to text cell (Ctrl+M M)" : "Convert to code cell (Ctrl+M Y)"} onClick={actions.onToggleType}>
        {cell.type === "code" ? "T" : "{}"}
      </IconBtn>
      {cell.type === "code" && cell.outputs.length > 0 && <IconBtn label="Clear output" onClick={actions.onClearOutput}>⌫</IconBtn>}
      <IconBtn label="Delete cell (Ctrl+M D)" onClick={actions.onDelete}>🗑</IconBtn>
    </div>
  );

  return (
    <div className="group relative" onMouseDown={actions.onFocus}>
      <div className={`relative flex rounded-lg border transition-colors ${active ? "border-line-strong bg-surface/80" : "border-transparent hover:border-line"}`}>
        {toolbar}
        {cell.type === "code" ? (
          <>
            <RunButton cell={cell} onRun={actions.onRun} />
            <div className="min-w-0 flex-1 py-1 pr-2">
              <div className="rounded-lg border border-line/80 bg-elevated">
                <CodeEditor
                  value={cell.source}
                  onChange={actions.onChange}
                  onFocus={actions.onFocus}
                  onRun={actions.onRun}
                  onRunAdvance={actions.onRunAdvance}
                  onRunInsert={actions.onRunInsert}
                  autoFocus={autoFocus}
                  placeholder="Start coding (Shift+Enter to run)"
                />
              </div>
              {(cell.outputs.length > 0 || (cell.status && cell.status !== "idle")) && (
                <div className={`mt-1 rounded-md border ${cell.status === "error" ? "border-danger/40" : "border-line"} bg-canvas/60`}>
                  <CellOutputs outputs={cell.outputs} running={running} execCount={cell.execCount} />
                  <StatusLine cell={cell} />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="min-w-0 flex-1 py-1 pl-12 pr-2">
            {editingMd ? (
              <div className="rounded-lg border border-line/80 bg-elevated">
                <CodeEditor
                  value={cell.source}
                  onChange={actions.onChange}
                  onFocus={actions.onFocus}
                  language="markdown"
                  autoFocus
                  onRun={() => setEditingMd(false)}
                  onRunAdvance={() => { setEditingMd(false); actions.onRunAdvance(); }}
                  onRunInsert={() => { setEditingMd(false); actions.onRunInsert(); }}
                  onEscape={() => setEditingMd(false)}
                  placeholder="Text cell: Markdown (Shift+Enter to render)"
                />
              </div>
            ) : (
              <div
                className="md-cell cursor-text rounded-md px-2 py-1.5 text-sm text-fg/85"
                onDoubleClick={() => setEditingMd(true)}
                title="Double-click to edit"
              >
                {cell.source.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{cell.source}</ReactMarkdown>
                ) : (
                  <span className="italic text-muted">Empty text cell, double-click to edit</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Insert-between bar (Colab style) */}
      <div className="flex h-5 items-center justify-center gap-2 opacity-0 transition-opacity hover:opacity-100">
        <div className="h-px flex-1 bg-elevated" />
        <button onClick={() => actions.onInsert("below", "code")} className="rounded border border-line-strong bg-surface px-2 text-[10.5px] text-fg/85 hover:border-line-strong">+ Code</button>
        <button onClick={() => actions.onInsert("below", "markdown")} className="rounded border border-line-strong bg-surface px-2 text-[10.5px] text-fg/85 hover:border-line-strong">+ Text</button>
        <div className="h-px flex-1 bg-elevated" />
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} title={label} aria-label={label}
      className="flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs text-fg/85 hover:bg-line">
      {children}
    </button>
  );
}
