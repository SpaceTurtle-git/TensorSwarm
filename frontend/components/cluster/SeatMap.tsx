"use client";

import React, { useCallback, useState } from "react";
import { fmtMB, fmtNum, tempLevel } from "../../lib/format";
import { SEAT_GPU, SEATS_PER_GPU, type MachineSeats, type SeatMap as SeatMapData } from "../../lib/seats";
import { IconAlert, IconCheck, IconCpu, IconPanel } from "../icons";
import { Card, SectionTitle, StatusPill } from "../ui";

export type SeatState = "free" | "selected" | "taken" | "offline";

interface Tip { x: number; y: number; lines: string[] }

function seatLabel(i: number) {
  return `Seat ${String(i + 1).padStart(2, "0")}`;
}

const STATE_TEXT: Record<SeatState, string> = { free: "Available", selected: "Selected by you", taken: "Taken", offline: "Offline" };

function SeatGlyph({ state }: { state: SeatState }) {
  if (state === "selected") return <IconCheck size={14} strokeWidth={2.6} />;
  if (state === "taken") return <span className="h-[3px] w-3 rounded-full bg-current" aria-hidden="true" />;
  if (state === "offline") return <span className="h-[2px] w-3.5 -rotate-45 rounded-full bg-current" aria-hidden="true" />;
  return null;
}

export function Legend() {
  const items: { state: SeatState; label: string }[] = [
    { state: "free", label: "Free" },
    { state: "selected", label: "Selected" },
    { state: "taken", label: "Taken" },
    { state: "offline", label: "Offline" },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted" aria-label="Seat legend">
      {items.map((it) => (
        <li key={it.state} className="flex items-center gap-2">
          <span className="seat pointer-events-none !h-[20px] !w-[22px] !animate-none" data-state={it.state} style={{ transform: "none" }} aria-hidden="true">
            <SeatGlyph state={it.state} />
          </span>
          {it.label}
        </li>
      ))}
      <li className="text-muted/90">1 seat = {SEAT_GPU} GPU · 4 seats = 1 GPU</li>
    </ul>
  );
}

function Telemetry({ m }: { m: MachineSeats }) {
  const g = m.node.gpus[0];
  if (!m.online) return <span className="text-[12.5px] text-muted">Last heartbeat lost</span>;
  if (!g) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-[12px] text-muted"><span>CPU load</span><span className="font-medium text-fg tabular">{fmtNum(m.node.host.cpu_utilization_pct)}%</span></div>
        <Bar value={m.node.host.cpu_utilization_pct} />
      </div>
    );
  }
  const t = tempLevel(g.temperature_c);
  return (
    <div className="grid grid-cols-[minmax(84px,1fr)_auto_auto] items-center gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between gap-2 text-[12px] text-muted"><span>GPU load</span><span className="font-medium text-fg tabular">{fmtNum(g.gpu_utilization_pct)}%</span></div>
        <Bar value={g.gpu_utilization_pct} />
      </div>
      <div className="whitespace-nowrap text-[12.5px] text-muted tabular">
        <span className="text-fg">{fmtMB(g.used_vram_mb)}</span> / {fmtMB(g.total_vram_mb)}
      </div>
      <div className={`flex items-center gap-1 whitespace-nowrap text-[12.5px] tabular ${t === "good" ? "text-muted" : t === "critical" ? "font-semibold text-danger-fg" : "font-semibold text-warn-fg"}`}>
        {t !== "good" && <IconAlert size={13} title={`Temperature ${t}`} />}
        {fmtNum(g.temperature_c, 0, " °C")}
      </div>
    </div>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-fg/10">
      <div className="h-full rounded-full bg-viz transition-[width] duration-[400ms] ease-out-expo" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function MachineRow({ m, selected, selectedSeats, onSelectMachine, onToggleSeat, onDetails, setTip }: {
  m: MachineSeats;
  selected: boolean;
  selectedSeats: number[];
  onSelectMachine: (ip: string) => void;
  onToggleSeat: (ip: string, seat: number) => void;
  onDetails: (ip: string) => void;
  setTip: (t: Tip | null) => void;
}) {
  const gpuName = m.node.gpus[0]?.name?.replace(/^NVIDIA (GeForce )?/, "") ?? null;
  const groups: { gpu: number; seats: { i: number; state: SeatState }[] }[] = [];
  for (let g = 0; g < Math.ceil(m.totalSeats / SEATS_PER_GPU); g++) {
    const seats = [];
    for (let s = 0; s < SEATS_PER_GPU; s++) {
      const i = g * SEATS_PER_GPU + s;
      if (i >= m.totalSeats) break;
      let state: SeatState = "free";
      if (!m.online || !m.inRay) state = "offline";
      else if (i < m.takenSeats) state = "taken";
      else if (selected && selectedSeats.includes(i)) state = "selected";
      seats.push({ i, state });
    }
    groups.push({ gpu: g, seats });
  }

  const showTip = (e: React.SyntheticEvent<HTMLElement>, i: number, state: SeatState) => {
    const r = e.currentTarget.getBoundingClientRect();
    const gpu = Math.floor(i / SEATS_PER_GPU);
    const lines = [
      `GPU ${gpu} · ${seatLabel(i % SEATS_PER_GPU)}`,
      `Status: ${STATE_TEXT[state]}${state === "offline" && m.online && !m.inRay ? " (worker not joined to Ray)" : ""}`,
      `Allocation: ${SEAT_GPU} GPU`,
      `Machine: ${m.hostname}`,
    ];
    setTip({ x: r.left + r.width / 2, y: r.top, lines });
  };

  const status = !m.online ? "OFFLINE" : m.node.status;
  return (
    <div
      className={`grid grid-cols-1 items-center gap-3 rounded-xl border px-3 py-3.5 md:grid-cols-[minmax(200px,240px)_auto_minmax(240px,1fr)] md:gap-6 md:px-4 transition-[background-color,border-color] duration-[180ms] ${selected ? "border-accent/45 bg-elevated/70" : "border-transparent hover:bg-elevated/35"} ${!m.online ? "opacity-70" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={() => onSelectMachine(m.ip)} aria-pressed={selected}
          className="min-w-0 flex-1 rounded-lg text-left">
          <span className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-fg">{m.hostname}</span>
            <StatusPill status={status} />
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted">
            {m.hasGpu ? `${gpuName ?? "GPU"}${m.gpuCount > 1 ? ` ×${m.gpuCount}` : ""}` : "CPU only"} · <span className="font-mono">{m.ip}</span>
          </span>
        </button>
        <button type="button" onClick={() => onDetails(m.ip)} aria-label={`Show details for ${m.hostname}`} title="Machine details"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg xl:hidden">
          <IconPanel size={16} />
        </button>
      </div>

      <div className="flex min-w-[164px] flex-wrap items-center gap-4">
        {m.hasGpu ? (
          groups.map((grp) => (
            <div key={grp.gpu} className="flex items-center gap-2" role="group" aria-label={`${m.hostname} GPU ${grp.gpu}`}>
              {m.gpuCount > 1 && <span className="w-9 text-[11px] font-medium text-muted">GPU {grp.gpu}</span>}
              <div className="flex gap-1.5">
                {grp.seats.map(({ i, state }) => {
                  const actionable = state === "free" || state === "selected";
                  return (
                    <button
                      key={i}
                      type="button"
                      className="seat"
                      data-state={state}
                      aria-pressed={state === "selected"}
                      aria-disabled={!actionable}
                      aria-label={`${m.hostname}, GPU ${grp.gpu}, ${seatLabel(i % SEATS_PER_GPU)}: ${STATE_TEXT[state]}, ${SEAT_GPU} GPU`}
                      onClick={() => actionable && onToggleSeat(m.ip, i)}
                      onMouseEnter={(e) => showTip(e, i, state)}
                      onMouseLeave={() => setTip(null)}
                      onFocus={(e) => showTip(e, i, state)}
                      onBlur={() => setTip(null)}
                    >
                      <SeatGlyph state={state} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <button type="button" onClick={() => onSelectMachine(m.ip)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors duration-[180ms] ${selected ? "border-accent/50 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg"}`}>
            <IconCpu size={15} />
            {m.online && m.cpus ? `CPU only · ${fmtNum(m.cpus)} cores` : "CPU only"}
          </button>
        )}
      </div>

      <div className="min-w-0">
        <Telemetry m={m} />
      </div>
    </div>
  );
}

export default function SeatMap({ data, selectedIp, selectedSeats, onSelectMachine, onToggleSeat, onDetails, loading }: {
  data: SeatMapData;
  selectedIp: string | null;
  selectedSeats: number[];
  onSelectMachine: (ip: string) => void;
  onToggleSeat: (ip: string, seat: number) => void;
  onDetails: (ip: string) => void;
  loading: boolean;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const clearTip = useCallback(() => setTip(null), []);
  const free = data.machines.reduce((s, m) => s + m.freeSeats, 0);
  const total = data.machines.reduce((s, m) => s + (m.online && m.inRay ? m.totalSeats : 0), 0);

  return (
    <Card className="p-5 md:p-6" aria-labelledby="seatmap-title">
      <div className="flex flex-col gap-4">
        <SectionTitle id="seatmap-title" aside={data.rayConnected ? `${free} of ${total} seats free on online PCs` : undefined}>
          GPU seat map
        </SectionTitle>
        <Legend />
      </div>

      <div className="thin-scroll -mx-2 mt-4 overflow-x-auto px-2 pb-1" onScroll={clearTip}>
        <div className="flex flex-col gap-1 md:min-w-[720px]">
          {loading && !data.machines.length ? (
            <p className="py-12 text-center text-[13px] text-muted">Discovering PCs on the Tailscale mesh…</p>
          ) : data.machines.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
              <p className="font-semibold text-fg">No PCs have reported yet</p>
              <p className="mx-auto mt-2 max-w-lg text-[13px] text-muted">
                Start <code className="font-mono text-fg">master\start_master.cmd</code> on the Master PC, then{" "}
                <code className="font-mono text-fg">worker\start_worker.cmd &lt;MASTER_IP&gt;</code> on every other PC.
              </p>
            </div>
          ) : (
            data.machines.map((m) => (
              <MachineRow key={m.ip} m={m} selected={m.ip === selectedIp} selectedSeats={selectedSeats}
                onSelectMachine={onSelectMachine} onToggleSeat={onToggleSeat} onDetails={onDetails} setTip={setTip} />
            ))
          )}
        </div>
      </div>

      {!data.rayConnected && data.machines.length > 0 && (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-warn-fg"><IconAlert size={14} />The Master is not connected to Ray yet, so no seats can be reserved. It retries automatically.</p>
      )}
      {data.unplacedGpu > 0 && (
        <p className="mt-3 text-[12.5px] text-muted">
          Ray also holds {fmtNum(data.unplacedGpu, 2)} GPU for work it has not reported a PC for (for example <code className="font-mono">ts.map</code> tasks or a runtime still being placed). The swarm-wide count above includes it.
        </p>
      )}

      {tip && (
        <div role="tooltip" className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full animate-fade-in rounded-lg border border-line-strong bg-elevated px-3 py-2 text-[12px] leading-relaxed text-fg pop-shadow"
          style={{ left: tip.x, top: tip.y - 8 }}>
          <div className="font-semibold">{tip.lines[0]}</div>
          {tip.lines.slice(1).map((l) => <div key={l} className="text-muted">{l}</div>)}
        </div>
      )}
    </Card>
  );
}
