"use client";

import Link from "next/link";
import React, { useState } from "react";
import type { NodeRecord } from "../lib/types";
import { useNodeHistory } from "../lib/cluster";
import { fmtMB, fmtNum, loadLevel, pct, timeAgo } from "../lib/format";
import GpuPanel from "./GpuPanel";
import { Card, KV, Meter, StatusPill } from "./ui";

export default function NodeCard({ node, rayGpus }: { node: NodeRecord; rayGpus?: { total: number; nodes: number } }) {
  const [expanded, setExpanded] = useState(true);
  const history = useNodeHistory(node.node_id, 10, node.status !== "OFFLINE");
  const ramPct = pct(node.host.ram_used_mb, node.host.ram_total_mb);
  const sys = node.system;

  return (
    <Card className={`p-5 ${node.status === "OFFLINE" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-50">{node.hostname}</h3>
            <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-400">{node.tailscale_ip}</span>
            <StatusPill status={node.status} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
            <span>{node.gpu_count ? node.gpus.map((g) => g.name).join(", ") : "CPU only (no NVIDIA GPU)"}</span>
            <span>heartbeat {timeAgo(node.last_heartbeat)}</span>
            {rayGpus && <span title="GPUs this PC offers to the Ray scheduler">Ray: {fmtNum(rayGpus.total, 2)} GPU on {rayGpus.nodes} Ray node{rayGpus.nodes === 1 ? "" : "s"}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="rounded-md border border-slate-800 px-2 py-1 text-slate-300">{node.active_jobs} job{node.active_jobs === 1 ? "" : "s"}</span>
          <span className="rounded-md border border-slate-800 px-2 py-1 text-slate-300">{node.active_kernels ?? 0} runtime{node.active_kernels === 1 ? "" : "s"}</span>
          {node.gpu_count > 0 && node.status !== "OFFLINE" && (
            <Link href={`/notebook?target=${encodeURIComponent(node.tailscale_ip)}`}
              className="rounded-md bg-emerald-500 px-2.5 py-1 font-medium text-slate-950 hover:bg-emerald-400">
              Open notebook here
            </Link>
          )}
          <button onClick={() => setExpanded((e) => !e)} className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800" aria-expanded={expanded}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(240px,300px)_1fr]">
        {/* Host column */}
        <div className="space-y-3">
          <Meter label="Host CPU" value={node.host.cpu_utilization_pct} detail={`${fmtNum(node.host.cpu_utilization_pct)}%${node.host.cpu_freq_mhz ? ` · ${(node.host.cpu_freq_mhz / 1000).toFixed(2)} GHz` : ""}`} />
          <Meter label="Host RAM" value={ramPct} detail={`${fmtMB(node.host.ram_used_mb)} / ${fmtMB(node.host.ram_total_mb)}`} level={loadLevel(ramPct)} />
          {expanded && (
            <div className="pt-1">
              <KV k="CPU" v={sys?.cpu_model ?? "—"} mono={false} />
              <KV k="Cores" v={sys?.cpu_cores_physical ? `${sys.cpu_cores_physical} physical / ${sys.cpu_cores_logical} logical` : "—"} />
              <KV k="OS" v={<span className="text-[11px]">{sys?.os ?? "—"}</span>} mono={false} />
              <KV k="Python / agent" v={`${sys?.python_version ?? "—"} / ${sys?.agent_version ?? "old"}`} />
              {node.host.swap_used_pct !== null && node.host.swap_used_pct !== undefined && (
                <KV k="Swap used" v={`${fmtNum(node.host.swap_used_pct)}%`} />
              )}
            </div>
          )}
        </div>

        {/* GPU column */}
        <div className="space-y-6">
          {node.gpus.length === 0 ? (
            <p className="text-sm text-slate-500">This node reports no NVIDIA GPU. It can still run CPU jobs (GPU share 0).</p>
          ) : (
            node.gpus.map((g) => (
              <GpuPanel key={g.uuid} gpu={g} history={history} system={sys} showCharts={expanded} />
            ))
          )}
        </div>
      </div>
    </Card>
  );
}
