"use client";

import React from "react";
import { fmtNum } from "../../lib/format";
import type { ClusterSummary } from "../../lib/types";
import { AnimatedNumber } from "../ui";

/** Label, then value at the same height on every tile; the optional bar sits on the bottom edge. */
function Tile({ label, value, sub, bar }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; bar?: number | null;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface/80 p-4 panel-shadow">
      <div className="truncate text-[12.5px] font-medium text-muted" title={label}>{label}</div>
      <div className="mt-3 text-[26px] font-bold leading-none tracking-[-0.02em] text-fg tabular">{value}</div>
      {sub && <div className="mt-2 truncate text-[12.5px] text-muted">{sub}</div>}
      {bar !== undefined && bar !== null && (
        <div className="mt-auto pt-3" aria-hidden="true">
          <div className="h-1.5 overflow-hidden rounded-full bg-fg/10">
            <div className="h-full rounded-full bg-viz transition-[width] duration-[400ms] ease-out-expo" style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function OverviewCards({ summary, seats, rayConnected }: {
  summary: ClusterSummary | null;
  seats: { free: number; total: number };
  rayConnected: boolean;
}) {
  const int = (v: number) => fmtNum(Math.round(v));
  return (
    <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
      <Tile
        label="Available GPU seats"
        value={rayConnected ? <><AnimatedNumber value={seats.free} format={int} /><span className="text-[15px] font-semibold text-muted"> / {seats.total}</span></> : "—"}
        sub={rayConnected ? `${fmtNum(seats.free / 4, 2)} GPU free in Ray` : "Ray not connected yet"}
        bar={rayConnected && seats.total ? (seats.free / seats.total) * 100 : null}
      />
      <Tile
        label="Online machines"
        value={summary ? <><AnimatedNumber value={summary.active_nodes} format={int} /><span className="text-[15px] font-semibold text-muted"> / {summary.total_nodes}</span></> : "—"}
        sub={summary ? (summary.offline_nodes ? `${summary.offline_nodes} offline` : "All registered PCs online") : undefined}
      />
      <Tile
        label="Active jobs"
        value={summary ? <AnimatedNumber value={summary.running_jobs ?? 0} format={int} /> : "—"}
        sub={summary ? `${summary.active_kernels ?? 0} notebook runtime${summary.active_kernels === 1 ? "" : "s"}` : undefined}
      />
      <Tile
        label="Cluster GPU utilisation"
        value={summary ? <AnimatedNumber value={summary.avg_gpu_utilization_pct} format={(v) => `${fmtNum(v)}%`} /> : "—"}
        sub={summary ? `${fmtNum(summary.total_power_watts ?? 0)} W${summary.max_temperature_c ? ` · hottest ${fmtNum(summary.max_temperature_c)} °C` : ""}` : undefined}
        bar={summary ? summary.avg_gpu_utilization_pct : null}
      />
    </div>
  );
}
