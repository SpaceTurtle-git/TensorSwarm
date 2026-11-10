"use client";

import React, { useMemo, useState } from "react";
import type { GPUStats, HistorySample, SystemInfo } from "../lib/types";
import { fmtMB, fmtNum, loadLevel, pct, tempLevel } from "../lib/format";
import TimeChart, { type Point } from "./TimeChart";
import { KV, LevelBadge, Meter } from "./ui";

const WINDOW_MS = 10 * 60 * 1000;

function series(history: HistorySample[], index: number, pick: (g: HistorySample["gpus"][number]) => number | null | undefined): Point[] {
  return history.map((s) => {
    const g = s.gpus.find((x) => x.index === index);
    const v = g ? pick(g) : null;
    return { t: s.t, v: v === undefined || v === null ? null : v };
  });
}

function MiniStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-slate-100">{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default function GpuPanel({ gpu, history, system, showCharts = true }: {
  gpu: GPUStats; history: HistorySample[]; system?: SystemInfo | null; showCharts?: boolean;
}) {
  const [tab, setTab] = useState<"charts" | "specs" | "processes">("charts");
  const vramPct = pct(gpu.used_vram_mb, gpu.total_vram_mb);
  const tLevel = tempLevel(gpu.temperature_c);
  const throttles = (gpu.throttle_reasons || []).filter((r) => r !== "idle");

  const util = useMemo(() => series(history, gpu.index, (g) => g.util), [history, gpu.index]);
  const vram = useMemo(() => series(history, gpu.index, (g) => g.vram_used_mb), [history, gpu.index]);
  const temp = useMemo(() => series(history, gpu.index, (g) => g.temp), [history, gpu.index]);
  const power = useMemo(() => series(history, gpu.index, (g) => g.power), [history, gpu.index]);
  const tempMax = Math.max(100, ...temp.map((p) => p.v ?? 0));
  const powerMax = Math.max(gpu.power_limit_watts ?? 0, ...power.map((p) => p.v ?? 0), 10) * 1.1;

  return (
    <div className="space-y-3">
      {/* Identity line: exactly which GPU this is */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-100">
            GPU {gpu.index}: {gpu.name}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
            {gpu.architecture && <span>{gpu.architecture}</span>}
            {gpu.compute_capability && <span>Compute {gpu.compute_capability}</span>}
            <span>{fmtMB(gpu.total_vram_mb)} VRAM</span>
            {gpu.cuda_cores ? <span>{gpu.cuda_cores.toLocaleString()} CUDA cores</span> : null}
            {system?.driver_version && <span>Driver {system.driver_version}</span>}
            {system?.cuda_driver_version && <span>CUDA {system.cuda_driver_version}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {gpu.performance_state && (
            <span className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-300" title="Performance state: P0 = maximum performance, P8+ = idle">
              {gpu.performance_state}
            </span>
          )}
          {throttles.map((r) => (
            <LevelBadge key={r} level={r.includes("thermal") || r.includes("hw") ? "serious" : "warning"} text={`Throttled: ${r}`} />
          ))}
        </div>
      </div>

      {/* Live meters */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Meter label="GPU core load" value={gpu.gpu_utilization_pct} detail={`${fmtNum(gpu.gpu_utilization_pct)}%`} />
        <Meter label="VRAM used" value={vramPct} detail={`${fmtMB(gpu.used_vram_mb)} / ${fmtMB(gpu.total_vram_mb)} (${fmtNum(vramPct)}%)`} level={loadLevel(vramPct)} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <MiniStat label="Temperature" value={<span className="flex items-center gap-1.5">{fmtNum(gpu.temperature_c, 0, " °C")}{tLevel !== "good" && <LevelBadge level={tLevel} />}</span>} />
        <MiniStat label="Power" value={fmtNum(gpu.power_watts, 1, " W")} sub={gpu.power_limit_watts ? `limit ${fmtNum(gpu.power_limit_watts, 0, " W")}` : undefined} />
        <MiniStat label="SM clock" value={fmtNum(gpu.clock_sm_mhz, 0, " MHz")} sub={gpu.clock_sm_max_mhz ? `max ${fmtNum(gpu.clock_sm_max_mhz)} MHz` : undefined} />
        <MiniStat label="Memory clock" value={fmtNum(gpu.clock_memory_mhz, 0, " MHz")} sub={gpu.clock_memory_max_mhz ? `max ${fmtNum(gpu.clock_memory_max_mhz)} MHz` : undefined} />
        <MiniStat label="Mem. controller" value={`${fmtNum(gpu.memory_utilization_pct)}%`} sub="memory bus busy" />
        <MiniStat label="Fan" value={gpu.fan_speed_pct === null || gpu.fan_speed_pct === undefined ? "n/a" : `${gpu.fan_speed_pct}%`} sub={gpu.fan_speed_pct === null || gpu.fan_speed_pct === undefined ? "laptop / not reported" : undefined} />
      </div>

      {showCharts && (
        <>
          <div className="flex gap-1 border-b border-slate-800 text-xs" role="tablist">
            {(["charts", "specs", "processes"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-1.5 capitalize ${tab === t ? "border-emerald-400 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
                {t === "processes" ? `Processes (${gpu.processes?.length ?? 0})` : t === "charts" ? "Last 10 min" : "Specs"}
              </button>
            ))}
          </div>

          {tab === "charts" && (
            <div className="grid gap-3 md:grid-cols-2">
              <TimeChart title="GPU core load" points={util} windowMs={WINDOW_MS} yMax={100} format={(v) => `${Math.round(v)}%`} />
              <TimeChart title="VRAM used" points={vram} windowMs={WINDOW_MS} yMax={gpu.total_vram_mb} format={(v) => fmtMB(v)}
                reference={{ value: gpu.total_vram_mb, label: "capacity" }} />
              <TimeChart title="Temperature" points={temp} windowMs={WINDOW_MS} yMin={20} yMax={tempMax} format={(v) => `${Math.round(v)} °C`}
                reference={{ value: 87, label: "hot (87 °C)" }} />
              <TimeChart title="Power draw" points={power} windowMs={WINDOW_MS} yMax={powerMax} format={(v) => `${v.toFixed(0)} W`}
                reference={gpu.power_limit_watts ? { value: gpu.power_limit_watts, label: `limit ${gpu.power_limit_watts} W` } : undefined} />
            </div>
          )}

          {tab === "specs" && (
            <div className="grid gap-x-6 md:grid-cols-2">
              <div>
                <KV k="Name" v={gpu.name} mono={false} />
                <KV k="UUID" v={<span className="break-all text-[10px]">{gpu.uuid}</span>} />
                <KV k="Architecture" v={gpu.architecture ?? "—"} />
                <KV k="Compute capability" v={gpu.compute_capability ?? "—"} />
                <KV k="CUDA cores" v={gpu.cuda_cores ? gpu.cuda_cores.toLocaleString() : "—"} />
                <KV k="VRAM" v={`${fmtMB(gpu.total_vram_mb)}${gpu.memory_bus_width_bits ? ` · ${gpu.memory_bus_width_bits}-bit bus` : ""}`} />
                <KV k="Driver / CUDA" v={`${system?.driver_version ?? "—"} / ${system?.cuda_driver_version ?? "—"}`} />
              </div>
              <div>
                <KV k="PCIe link" v={gpu.pcie_gen ? `Gen ${gpu.pcie_gen} x${gpu.pcie_width ?? "?"}  (max Gen ${gpu.pcie_gen_max ?? "?"} x${gpu.pcie_width_max ?? "?"})` : "—"} />
                <KV k="Graphics clock" v={`${fmtNum(gpu.clock_graphics_mhz)} / ${fmtNum(gpu.clock_graphics_max_mhz)} MHz`} />
                <KV k="SM clock" v={`${fmtNum(gpu.clock_sm_mhz)} / ${fmtNum(gpu.clock_sm_max_mhz)} MHz`} />
                <KV k="Memory clock" v={`${fmtNum(gpu.clock_memory_mhz)} / ${fmtNum(gpu.clock_memory_max_mhz)} MHz`} />
                <KV k="Power limit" v={fmtNum(gpu.power_limit_watts, 0, " W")} />
                <KV k="Encoder / decoder" v={`${fmtNum(gpu.encoder_utilization_pct)}% / ${fmtNum(gpu.decoder_utilization_pct)}%`} />
                <KV k="Throttle reasons" v={(gpu.throttle_reasons?.length ? gpu.throttle_reasons.join(", ") : "none")} mono={false} />
              </div>
            </div>
          )}

          {tab === "processes" && (
            <div className="overflow-x-auto">
              {gpu.processes && gpu.processes.length ? (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="py-1.5 pr-3 font-medium">Process</th>
                      <th className="py-1.5 pr-3 font-medium">PID</th>
                      <th className="py-1.5 pr-3 font-medium">Type</th>
                      <th className="py-1.5 text-right font-medium">VRAM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gpu.processes.map((p) => (
                      <tr key={p.pid} className="border-b border-slate-800/50">
                        <td className="py-1.5 pr-3 text-slate-200">{p.name}</td>
                        <td className="py-1.5 pr-3 font-mono text-slate-400">{p.pid}</td>
                        <td className="py-1.5 pr-3 text-slate-400">{p.type}</td>
                        <td className="py-1.5 text-right font-mono text-slate-300">{p.used_vram_mb === null || p.used_vram_mb === undefined ? "n/a" : fmtMB(p.used_vram_mb)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-3 text-xs text-slate-500">No processes are using this GPU.</p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                On Windows the driver cannot report VRAM per process (shown as n/a); the total above is exact.
                Ray jobs and notebook runtimes appear as <code>python.exe</code>.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
