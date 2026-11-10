"use client";

import React from "react";
import { LEVEL_LABEL, type Level } from "../lib/format";

export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <div className={`rounded-xl border border-slate-800 bg-slate-900/70 ${className}`}>{children}</div>;
}

export function StatTile({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${accent ?? "text-slate-50"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

/** Horizontal meter. Fill uses the series color; level text is shown separately (never color alone). */
export function Meter({ value, max = 100, label, detail, level }: { value: number; max?: number; label: string; detail?: string; level?: Level }) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="flex items-center gap-2 font-mono text-slate-400">
          {detail}
          {level && level !== "good" && <LevelBadge level={level} />}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800" role="meter" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${p}%`, background: level && level !== "good" ? `var(--status-${level})` : "var(--viz-series)" }} />
      </div>
    </div>
  );
}

const LEVEL_ICON: Record<Level, string> = { good: "✓", warning: "▲", serious: "▲", critical: "■" };

export function LevelBadge({ level, text }: { level: Level; text?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-950"
      style={{ background: `var(--status-${level})` }}
    >
      <span aria-hidden>{LEVEL_ICON[level]}</span>
      {text ?? LEVEL_LABEL[level]}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; dot: string; label?: string }> = {
    AVAILABLE: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" },
    COMPUTING: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-300", dot: "bg-amber-400 animate-pulse" },
    OFFLINE: { cls: "border-slate-700 bg-slate-800 text-slate-400", dot: "bg-slate-500" },
    READY: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", label: "Connected" },
    STARTING: { cls: "border-sky-500/30 bg-sky-500/10 text-sky-300", dot: "bg-sky-400 animate-pulse", label: "Connecting" },
    ERROR: { cls: "border-rose-500/30 bg-rose-500/10 text-rose-300", dot: "bg-rose-400", label: "Failed" },
    DEAD: { cls: "border-slate-700 bg-slate-800 text-slate-400", dot: "bg-slate-500", label: "Disconnected" },
    COMPLETED: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" },
    FAILED: { cls: "border-rose-500/30 bg-rose-500/10 text-rose-300", dot: "bg-rose-400" },
    RUNNING: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-300", dot: "bg-amber-400 animate-pulse" },
    PENDING: { cls: "border-sky-500/30 bg-sky-500/10 text-sky-300", dot: "bg-sky-400 animate-pulse" },
  };
  const s = map[status] ?? map.OFFLINE;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label ?? status}
    </span>
  );
}

export function KV({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-800/60 py-1 text-xs last:border-0">
      <span className="text-slate-400">{k}</span>
      <span className={`text-right text-slate-200 ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

export function Button({
  children, onClick, variant = "secondary", disabled, title, type = "button", className = "",
}: {
  children: React.ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean; title?: string; type?: "button" | "submit"; className?: string;
}) {
  const styles = {
    primary: "bg-emerald-500 text-slate-950 hover:bg-emerald-400",
    secondary: "bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700",
    danger: "bg-rose-600/90 text-white hover:bg-rose-500",
    ghost: "text-slate-300 hover:bg-slate-800",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${styles} ${className}`}>
      {children}
    </button>
  );
}
