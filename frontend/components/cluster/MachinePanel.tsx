"use client";

import React, { useMemo, useState } from "react";
import { useNodeHistory } from "../../lib/cluster";
import { fmtMB, fmtNum, loadLevel, pct, tempLevel, timeAgo } from "../../lib/format";
import { fmtShare, type MachineSeats } from "../../lib/seats";
import type { HistorySample } from "../../lib/types";
import TimeChart, { type Point } from "../TimeChart";
import { IconClose, IconLaptop } from "../icons";
import { KV, LevelBadge, Meter, Segmented, StatusPill } from "../ui";

const WINDOW_MS = 10 * 60 * 1000;
type Metric = "load" | "vram" | "temp" | "power";

function series(history: HistorySample[], index: number, pick: (g: HistorySample["gpus"][number]) => number | null | undefined): Point[] {
  return history.map((s) => {
    const g = s.gpus.find((x) => x.index === index);
    const v = g ? pick(g) : null;
    return { t: s.t, v: v === undefined || v === null ? null : v };
  });
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-canvas/35 px-3 py-2">
      <div className="text-[11.5px] font-medium text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[14px] font-medium text-fg tabular">{value}</div>
      {sub && <div className="truncate text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

export default function MachinePanel({ machine, onClose }: { machine: MachineSeats | null; onClose?: () => void }) {
  const node = machine?.node ?? null;
  const [gpuIndex, setGpuIndex] = useState(0);
  const [metric, setMetric] = useState<Metric>("load");
  const history = useNodeHistory(node?.node_id ?? null, 10, !!node && node.status !== "OFFLINE");
  const gpu = node?.gpus.find((g) => g.index === gpuIndex) ?? node?.gpus[0] ?? null;
  const sys = node?.system;

  const points = useMemo(() => {
    if (!gpu) return [];
    if (metric === "vram") return series(history, gpu.index, (g) => g.vram_used_mb);
    if (metric === "temp") return series(history, gpu.index, (g) => g.temp);
    if (metric === "power") return series(history, gpu.index, (g) => g.power);
    return series(history, gpu.index, (g) => g.util);
  }, [history, gpu, metric]);

  if (!machine || !node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-[15px] font-semibold text-fg">No machine selected</p>
        <p className="text-[13px] text-muted">Select a PC on the seat map to see its GPU, specs and live charts.</p>
      </div>
    );
  }

  const vramPct = gpu ? pct(gpu.used_vram_mb, gpu.total_vram_mb) : 0;
  const ramPct = pct(node.host.ram_used_mb, node.host.ram_total_mb);
  const throttles = (gpu?.throttle_reasons ?? []).filter((r) => r !== "idle");
  const powerMax = Math.max(gpu?.power_limit_watts ?? 0, ...points.map((p) => p.v ?? 0), 10) * 1.1;
  const tempMax = Math.max(100, ...points.map((p) => p.v ?? 0));
  const chart = {
    load: { title: "GPU load", yMax: 100, fmt: (v: number) => `${Math.round(v)}%` },
    vram: { title: "VRAM used", yMax: gpu?.total_vram_mb ?? 1, fmt: (v: number) => fmtMB(v), reference: gpu ? { value: gpu.total_vram_mb, label: "capacity" } : undefined },
    temp: { title: "Temperature", yMax: tempMax, yMin: 20, fmt: (v: number) => `${Math.round(v)} °C`, reference: { value: 87, label: "hot (87 °C)" } },
    power: { title: "Power draw", yMax: powerMax, fmt: (v: number) => `${v.toFixed(0)} W`, reference: gpu?.power_limit_watts ? { value: gpu.power_limit_watts, label: `limit ${gpu.power_limit_watts} W` } : undefined },
  }[metric];

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex min-w-0 items-center gap-2.5 text-[20px] font-semibold tracking-[-0.01em] text-fg">
            <IconLaptop size={26} className={`shrink-0 ${machine.online ? "text-icon" : "text-muted/80"}`} />
            <span className="truncate">{machine.hostname}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            <span className="font-mono">{node.tailscale_ip}</span>
            <StatusPill status={node.status} />
          </div>
          <div className="text-[12px] text-muted">Heartbeat {timeAgo(node.last_heartbeat)}</div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close machine details"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-fg/[0.06] hover:text-fg">
            <IconClose size={18} />
          </button>
        )}
      </div>


      {gpu ? (
        <Section title="GPU">
          {node.gpus.length > 1 && (
            <Segmented<number> size="sm" label="GPU" value={gpuIndex} onChange={setGpuIndex}
              options={node.gpus.map((g) => ({ value: g.index, label: `GPU ${g.index}` }))} />
          )}
          <div>
            <div className="text-[15px] font-semibold text-fg">{gpu.name}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-muted">
              {gpu.architecture && <span>{gpu.architecture}</span>}
              {gpu.compute_capability && <span>· Compute {gpu.compute_capability}</span>}
              <span>· {fmtMB(gpu.total_vram_mb)}</span>
              {gpu.performance_state && <span title="Performance state: P0 = maximum, P8+ = idle">· {gpu.performance_state}</span>}
            </div>
          </div>
          {throttles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {throttles.map((r) => <LevelBadge key={r} level={r.includes("thermal") || r.includes("hw") ? "serious" : "warning"} text={`Throttled: ${r}`} />)}
            </div>
          )}
          <Meter label="GPU utilisation" value={gpu.gpu_utilization_pct} detail={`${fmtNum(gpu.gpu_utilization_pct)}%`} />
          <Meter label="VRAM used" value={vramPct} detail={`${fmtMB(gpu.used_vram_mb)} / ${fmtMB(gpu.total_vram_mb)}`} level={loadLevel(vramPct)} />
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Temperature" value={<span className="inline-flex items-center gap-1.5">{fmtNum(gpu.temperature_c, 0, " °C")}{tempLevel(gpu.temperature_c) !== "good" && <LevelBadge level={tempLevel(gpu.temperature_c)} />}</span>} />
            <Stat label="Power" value={fmtNum(gpu.power_watts, 1, " W")} sub={gpu.power_limit_watts ? `limit ${fmtNum(gpu.power_limit_watts, 0, " W")}` : undefined} />
            <Stat label="SM clock" value={fmtNum(gpu.clock_sm_mhz, 0, " MHz")} sub={gpu.clock_sm_max_mhz ? `max ${fmtNum(gpu.clock_sm_max_mhz)}` : undefined} />
            <Stat label="Memory clock" value={fmtNum(gpu.clock_memory_mhz, 0, " MHz")} sub={`bus ${fmtNum(gpu.memory_utilization_pct)}% busy`} />
          </div>
        </Section>
      ) : (
        <Section title="Compute">
          <p className="text-[13px] text-muted">No NVIDIA GPU. This PC runs CPU-only notebooks and jobs{machine.cpus ? ` on up to ${fmtNum(machine.cpus)} cores` : ""}.</p>
        </Section>
      )}

      {gpu && (
        <Section title="Last 10 minutes">
          <Segmented<Metric> size="sm" label="Chart metric" value={metric} onChange={setMetric}
            options={[{ value: "load", label: "Load" }, { value: "vram", label: "VRAM" }, { value: "temp", label: "Temp" }, { value: "power", label: "Power" }]} />
          <TimeChart title={chart.title} points={points} windowMs={WINDOW_MS} yMax={chart.yMax} yMin={"yMin" in chart ? chart.yMin : 0}
            format={chart.fmt} reference={"reference" in chart ? chart.reference : undefined} height={120} />
        </Section>
      )}

      <Section title="Specifications">
        <div>
          {gpu && <KV k="GPU memory" v={`${fmtMB(gpu.total_vram_mb)}${gpu.memory_bus_width_bits ? ` · ${gpu.memory_bus_width_bits}-bit` : ""}`} />}
          {gpu && <KV k="Compute capability" v={gpu.compute_capability ?? "—"} />}
          {gpu && <KV k="CUDA cores" v={gpu.cuda_cores ? gpu.cuda_cores.toLocaleString() : "—"} />}
          <KV k="Driver version" v={sys?.driver_version ?? "—"} />
          <KV k="CUDA version" v={sys?.cuda_driver_version ?? "—"} />
          {gpu && <KV k="PCIe link" v={gpu.pcie_gen ? `Gen ${gpu.pcie_gen} x${gpu.pcie_width ?? "?"} (max Gen ${gpu.pcie_gen_max ?? "?"} x${gpu.pcie_width_max ?? "?"})` : "—"} />}
          {gpu && <KV k="Encoder / decoder" v={`${fmtNum(gpu.encoder_utilization_pct)}% / ${fmtNum(gpu.decoder_utilization_pct)}%`} />}
          {gpu && <KV k="Throttle reasons" v={gpu.throttle_reasons?.length ? gpu.throttle_reasons.join(", ") : "none"} mono={false} />}
        </div>
      </Section>

      <Section title="Host">
        <Meter label="CPU" value={node.host.cpu_utilization_pct} detail={`${fmtNum(node.host.cpu_utilization_pct)}%${node.host.cpu_freq_mhz ? ` · ${(node.host.cpu_freq_mhz / 1000).toFixed(2)} GHz` : ""}`} />
        <Meter label="RAM" value={ramPct} detail={`${fmtMB(node.host.ram_used_mb)} / ${fmtMB(node.host.ram_total_mb)}`} level={loadLevel(ramPct)} />
        <div>
          <KV k="CPU model" v={sys?.cpu_model ?? "—"} mono={false} />
          <KV k="Cores" v={sys?.cpu_cores_physical ? `${sys.cpu_cores_physical} physical / ${sys.cpu_cores_logical} logical` : "—"} />
          <KV k="Offered to Ray" v={machine.inRay ? `${fmtNum(machine.cpus ?? 0)} cores · ${fmtNum(machine.totalSeats / 4, 2)} GPU` : "not joined"} />
          <KV k="OS" v={sys?.os ?? "—"} mono={false} />
          <KV k="Python / agent" v={`${sys?.python_version ?? "—"} / ${sys?.agent_version ?? "old"}`} />
          {node.host.swap_used_pct !== null && node.host.swap_used_pct !== undefined && <KV k="Swap used" v={`${fmtNum(node.host.swap_used_pct)}%`} />}
        </div>
      </Section>

      {machine.workloads.length > 0 && (
        <Section title="Running here">
          <ul className="space-y-1.5">
            {machine.workloads.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px]">
                <span className="truncate text-fg">{w.name}</span>
                <span className="shrink-0 text-muted tabular">{w.gpus > 0 ? fmtShare(w.gpus) : "CPU"}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {gpu && (
        <Section title={`GPU processes (${gpu.processes?.length ?? 0})`}>
          {gpu.processes?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th className="py-1.5 pr-2 font-medium">Process</th>
                    <th className="py-1.5 pr-2 font-medium">PID</th>
                    <th className="py-1.5 text-right font-medium">VRAM</th>
                  </tr>
                </thead>
                <tbody>
                  {gpu.processes.map((p) => (
                    <tr key={p.pid} className="border-b border-line/60 last:border-0">
                      <td className="max-w-[140px] truncate py-1.5 pr-2 text-fg" title={`${p.name} (${p.type})`}>{p.name}</td>
                      <td className="py-1.5 pr-2 font-mono text-muted">{p.pid}</td>
                      <td className="py-1.5 text-right font-mono text-fg/85">{p.used_vram_mb === null || p.used_vram_mb === undefined ? "n/a" : fmtMB(p.used_vram_mb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11.5px] text-muted">Windows (WDDM) does not report per-process VRAM; &quot;n/a&quot; is expected there.</p>
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">No processes are using this GPU.</p>
          )}
        </Section>
      )}
    </div>
  );
}
