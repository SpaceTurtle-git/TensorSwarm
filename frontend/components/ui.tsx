"use client";

import React, { useEffect, useRef, useState } from "react";
import { LEVEL_LABEL, type Level } from "../lib/format";
import { IconAlert, IconCheck, IconClock, IconX } from "./icons";

/** Panel surface. `tone="elevated"` for content that sits above a panel. */
export function Card({ className = "", tone = "surface", children, ...rest }: {
  className?: string; tone?: "surface" | "elevated"; children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const bg = tone === "elevated" ? "glass-elevated" : "glass";
  return <div className={`rounded-2xl border border-line glass-border ${bg} ${className}`} {...rest}>{children}</div>;
}

export function SectionTitle({ children, aside, id }: { children: React.ReactNode; aside?: React.ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h2 id={id} className="text-[20px] font-semibold tracking-[-0.01em] text-fg">{children}</h2>
      {aside && <div className="text-[13px] text-muted">{aside}</div>}
    </div>
  );
}

/** Tweens a number to its new value (400 ms, ease-out) so live metrics do not jump. */
export function AnimatedNumber({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef<number>();
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const b = value;
    if (a === b || typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      from.current = b;
      setShown(b);
      return;
    }
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 400);
      const e = 1 - Math.pow(1 - t, 3);
      const v = a + (b - a) * e;
      setShown(v);
      from.current = v;
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value]);
  return <>{format(shown)}</>;
}

/** Legacy compact stat tile (kept for pages that still use it). */
export function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="mt-1 text-[24px] font-bold tracking-tight text-fg">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-muted">{sub}</div>}
    </Card>
  );
}

const LEVEL_FILL: Record<Level, string> = {
  good: "bg-viz",
  warning: "bg-warn",
  serious: "bg-warn",
  critical: "bg-danger",
};

/** Horizontal meter. The level is also written out as text, never colour alone. */
export function Meter({ value, max = 100, label, detail, level }: { value: number; max?: number; label: string; detail?: string; level?: Level }) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="font-medium text-fg/85">{label}</span>
        <span className="flex items-center gap-2 font-mono text-muted tabular">
          {detail}
          {level && level !== "good" && <LevelBadge level={level} />}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/10" role="meter" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full rounded-full transition-[width] duration-[400ms] ease-out-expo ${LEVEL_FILL[level ?? "good"]}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

const LEVEL_STYLE: Record<Level, string> = {
  good: "border-ok/35 bg-ok/10 text-ok-fg",
  warning: "border-warn/40 bg-warn/10 text-warn-fg",
  serious: "border-warn/50 bg-warn/15 text-warn-fg",
  critical: "border-danger/50 bg-danger/15 text-danger-fg",
};

export function LevelBadge({ level, text }: { level: Level; text?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${LEVEL_STYLE[level]}`}>
      {level === "good" ? <IconCheck size={11} /> : <IconAlert size={11} />}
      {text ?? LEVEL_LABEL[level]}
    </span>
  );
}

type Tone = "ok" | "live" | "wait" | "danger" | "off";
const TONE: Record<Tone, { pill: string; dot: string }> = {
  ok: { pill: "border-ok/35 bg-ok/10 text-ok-fg", dot: "bg-ok" },
  live: { pill: "border-viz/35 bg-viz/10 text-fg", dot: "bg-viz animate-pulse" },
  wait: { pill: "border-line-strong bg-fg/5 text-fg/85", dot: "bg-muted animate-pulse" },
  danger: { pill: "border-danger/40 bg-danger/10 text-danger-fg", dot: "bg-danger" },
  off: { pill: "border-line bg-fg/5 text-muted", dot: "bg-seat-offline" },
};

const STATUS: Record<string, { tone: Tone; label?: string }> = {
  AVAILABLE: { tone: "ok", label: "Available" },
  COMPUTING: { tone: "live", label: "Computing" },
  OFFLINE: { tone: "off", label: "Offline" },
  READY: { tone: "ok", label: "Connected" },
  STARTING: { tone: "wait", label: "Connecting" },
  ERROR: { tone: "danger", label: "Failed" },
  DEAD: { tone: "off", label: "Disconnected" },
  COMPLETED: { tone: "ok", label: "Completed" },
  FAILED: { tone: "danger", label: "Failed" },
  RUNNING: { tone: "live", label: "Running" },
  PENDING: { tone: "wait", label: "Queued" },
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { tone: "off" as Tone };
  const t = TONE[s.tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${t.pill}`}>
      {s.tone === "danger" ? <IconX size={11} /> : s.tone === "wait" ? <IconClock size={11} /> : <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {label ?? s.label ?? status}
    </span>
  );
}

export function KV({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/70 py-1.5 text-[12.5px] last:border-0">
      <span className="text-muted">{k}</span>
      <span className={`min-w-0 text-right text-fg ${mono ? "font-mono text-[12px] tabular" : ""}`}>{v}</span>
    </div>
  );
}

export function Button({
  children, onClick, variant = "secondary", disabled, title, type = "button", className = "", ...rest
}: {
  children: React.ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean; title?: string; type?: "button" | "submit"; className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type">) {
  const styles = {
    primary: "bg-accent text-accent-fg font-semibold hover:bg-accent-hover shadow-[0_1px_0_rgb(255_255_255/0.25)_inset] disabled:bg-line disabled:text-muted disabled:opacity-100 disabled:shadow-none",
    secondary: "border border-line bg-elevated/80 text-fg hover:border-line-strong hover:bg-elevated disabled:bg-surface disabled:text-muted disabled:opacity-100",
    danger: "border border-danger/45 bg-danger/10 text-danger-fg hover:bg-danger/15",
    ghost: "text-fg/85 hover:bg-fg/[0.06] hover:text-fg disabled:text-muted disabled:opacity-70",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} {...rest}
      className={`inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-[background-color,border-color,color,filter] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 ${styles} ${className}`}>
      {children}
    </button>
  );
}

/** Small segmented control (radio group semantics). */
export function Segmented<T extends string | number>({ options, value, onChange, label, size = "md" }: {
  options: { value: T; label: React.ReactNode; disabled?: boolean; title?: string }[];
  value: T; onChange: (v: T) => void; label: string; size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-xl border border-line bg-canvas/50 p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} disabled={o.disabled} title={o.title}
            onClick={() => onChange(o.value)}
            className={`rounded-[10px] font-medium transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[13px]"} ${on ? "bg-elevated text-fg shadow-[0_1px_2px_rgb(var(--shadow)/0.25)] ring-1 ring-line-strong" : "text-muted hover:text-fg"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
