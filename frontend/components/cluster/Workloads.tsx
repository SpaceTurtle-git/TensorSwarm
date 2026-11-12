"use client";

import Link from "next/link";
import React from "react";
import { fmtDuration } from "../../lib/format";
import { fmtShare, isActive, type Workload, type WorkloadStatus } from "../../lib/seats";
import { IconCheck, IconClock, IconJobs, IconNotebook, IconSpinner, IconX } from "../icons";
import { SectionTitle } from "../ui";

const STATUS: Record<WorkloadStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  running: { label: "Running", cls: "text-fg", icon: <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-status-ping rounded-full bg-viz" /><span className="relative h-2 w-2 rounded-full bg-viz" /></span> },
  starting: { label: "Starting", cls: "text-fg/85", icon: <IconSpinner size={12} /> },
  queued: { label: "Queued", cls: "text-muted", icon: <IconClock size={13} /> },
  completed: { label: "Completed", cls: "text-ok-fg", icon: <IconCheck size={13} strokeWidth={2.4} /> },
  failed: { label: "Failed", cls: "text-danger-fg", icon: <IconX size={13} strokeWidth={2.4} /> },
  stopped: { label: "Stopped", cls: "text-muted", icon: <IconX size={13} /> },
};

function runtimeText(w: Workload, now: number): string {
  if (w.durationSec !== null && !isActive(w)) return fmtDuration(w.durationSec);
  if (w.startedAt && isActive(w)) return fmtDuration((now - w.startedAt) / 1000);
  return "—";
}

function owner(w: Workload): string {
  if (w.mine) return "You · this browser";
  return w.kind === "job" ? "Batch job" : "Notebook runtime";
}

export default function Workloads({ items }: { items: Workload[] }) {
  const now = Date.now();
  const active = items.filter(isActive);
  const recent = items.filter((w) => !isActive(w) && w.kind === "job").slice(0, Math.max(0, 6 - active.length));
  const shown = [...active, ...recent];

  return (
    <section aria-labelledby="workloads-title" className="space-y-3">
      <SectionTitle id="workloads-title" aside={`${active.length} active`}>Active workloads</SectionTitle>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
          Nothing is running. Pick seats above to start a notebook, or run a sample from{" "}
          <Link href="/jobs" className="font-medium text-fg underline decoration-accent underline-offset-2">Jobs &amp; Samples</Link>.
        </p>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
          {shown.map((w) => {
            const s = STATUS[w.status];
            const href = w.kind === "job" ? `/jobs?job=${encodeURIComponent(w.id)}` : undefined;
            const body = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${s.cls}`}>{s.icon}{s.label}</span>
                  <span className="text-[12px] text-muted tabular">{runtimeText(w, now)}</span>
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-2">
                  {w.kind === "job" ? <IconJobs size={15} className="shrink-0 text-muted" /> : <IconNotebook size={15} className="shrink-0 text-muted" />}
                  <span className="truncate text-[14px] font-semibold text-fg">{w.name}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-muted">
                  <span>{owner(w)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{w.machine ?? (w.status === "queued" || w.status === "starting" ? "placing…" : "—")}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular">{w.gpus > 0 ? fmtShare(w.gpus) : `CPU · ${w.cpus ?? 1} core${w.cpus === 1 ? "" : "s"}`}</span>
                </div>
                {w.status === "failed" && w.error && <p className="mt-1.5 line-clamp-2 text-[12px] text-danger-fg">{w.error}</p>}
              </>
            );
            const cls = `block rounded-xl border border-line bg-surface/60 px-3.5 py-3 transition-[background-color,border-color] duration-[180ms] ${w.mine ? "ring-1 ring-accent/40" : ""}`;
            return (
              <li key={w.id}>
                {href ? <Link href={href} className={`${cls} hover:border-line-strong hover:bg-surface`}>{body}</Link> : <div className={cls}>{body}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
