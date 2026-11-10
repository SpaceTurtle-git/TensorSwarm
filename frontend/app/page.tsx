"use client";

import React, { useMemo } from "react";
import NodeCard from "../components/NodeCard";
import { Card, StatTile } from "../components/ui";
import { useCluster } from "../lib/cluster";
import { fmtNum } from "../lib/format";

export default function ClusterPage() {
  const { nodes, summary, ray, loading, lastUpdated } = useCluster();

  // Ray's per-IP GPU offer (the Master PC has two Ray nodes on one IP: head with 0 GPUs + its worker).
  const rayByIp = useMemo(() => {
    const m: Record<string, { total: number; nodes: number }> = {};
    for (const n of ray?.nodes ?? []) {
      if (!n.alive) continue;
      const e = (m[n.ip] ??= { total: 0, nodes: 0 });
      e.total += n.gpus;
      e.nodes += 1;
    }
    return m;
  }, [ray]);

  const rayGpuTotal = ray?.cluster_resources?.GPU ?? 0;
  const rayGpuFree = ray?.available_resources?.GPU ?? 0;

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-50">Cluster</h1>
          <p className="text-xs text-slate-400">Live PyNVML telemetry from every node, every 5 s · charts keep the last 10 minutes</p>
        </div>
        {lastUpdated && <span className="text-[11px] text-slate-500">updated {new Date(lastUpdated).toLocaleTimeString()}</span>}
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Nodes online" value={summary.active_nodes} sub={`of ${summary.total_nodes} registered${summary.offline_nodes ? ` · ${summary.offline_nodes} offline` : ""}`} />
          <StatTile label="GPUs" value={summary.total_gpus} sub={`${summary.available_gpus} idle (< 40% load)`} accent="text-emerald-300" />
          <StatTile label="Pooled VRAM" value={`${(summary.total_vram_gb - summary.used_vram_gb).toFixed(1)} GB`} sub={`free of ${summary.total_vram_gb} GB`} accent="text-cyan-300" />
          <StatTile label="Avg GPU load" value={`${fmtNum(summary.avg_gpu_utilization_pct)}%`}
            sub={`${fmtNum(summary.total_power_watts ?? 0)} W total${summary.max_temperature_c ? ` · hottest ${summary.max_temperature_c} °C` : ""}`} />
          <StatTile label="CPU cores" value={ray ? `${fmtNum(ray.available_resources?.CPU ?? 0)} free` : "—"}
            sub={ray ? `of ${fmtNum(ray.cluster_resources?.CPU ?? 0)} pooled from every PC` : undefined} accent="text-violet-300" />
          <StatTile label="Work running" value={`${summary.running_jobs ?? 0} job${summary.running_jobs === 1 ? "" : "s"}`} sub={`${summary.active_kernels ?? 0} notebook runtime${summary.active_kernels === 1 ? "" : "s"}`} />
        </div>
      )}

      {/* Ray scheduler view: logical GPUs the scheduler can still hand out */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Ray scheduler</h2>
            <p className="text-[11px] text-slate-400">
              {ray?.connected
                ? "Logical GPU shares: a notebook runtime or job holds its share until it finishes or is stopped."
                : "The Master API is not connected to Ray yet (jobs and notebooks unavailable)."}
            </p>
          </div>
          {ray?.connected && (
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-slate-300">
                <span className="font-mono text-lg text-slate-50">{fmtNum(rayGpuFree, 2)}</span> / {fmtNum(rayGpuTotal, 2)} GPU free
              </span>
              <span className="text-slate-400">{fmtNum(ray.available_resources?.CPU ?? 0)} / {fmtNum(ray.cluster_resources?.CPU ?? 0)} CPU free</span>
              <span className="text-slate-400">{ray.nodes.filter((n) => n.alive).length} Ray nodes</span>
            </div>
          )}
        </div>
        {ray?.connected && rayGpuTotal > 0 && (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800" role="meter" aria-label="GPU shares in use"
            aria-valuenow={Math.round(((rayGpuTotal - rayGpuFree) / rayGpuTotal) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-2 rounded-full" style={{ width: `${((rayGpuTotal - rayGpuFree) / rayGpuTotal) * 100}%`, background: "var(--viz-series)" }} />
          </div>
        )}
      </Card>

      <section className="space-y-4">
        {loading ? (
          <div className="py-16 text-center font-mono text-sm text-slate-500">Discovering nodes on the Tailscale mesh…</div>
        ) : nodes.length === 0 ? (
          <Card className="border-dashed p-12 text-center">
            <p className="font-semibold text-slate-300">No nodes have reported yet</p>
            <p className="mx-auto mt-2 max-w-lg text-xs text-slate-500">
              Start <code className="text-emerald-300">master\start_master.cmd</code> on the Master PC (it also starts that PC&apos;s worker), then{" "}
              <code className="text-emerald-300">worker\start_worker.cmd &lt;MASTER_IP&gt;</code> on every other PC. Linux:{" "}
              <code className="text-emerald-300">sudo ./start_worker.sh &lt;MASTER_IP&gt;</code>.
            </p>
          </Card>
        ) : (
          nodes.map((n) => <NodeCard key={n.node_id} node={n} rayGpus={rayByIp[n.tailscale_ip]} />)
        )}
      </section>
    </main>
  );
}
