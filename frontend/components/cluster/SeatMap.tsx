"use client";

import React, { useCallback, useState } from "react";
import { fmtMB, fmtNum, tempLevel } from "../../lib/format";
import { SEAT_GPU, SEATS_PER_GPU, type MachineSeats, type SeatMap as SeatMapData } from "../../lib/seats";
import { IconAlert, IconCheck, IconCluster, IconCpu, IconLaptop, IconPanel } from "../icons";
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
      <li className="text-muted/90">GPU seat = {SEAT_GPU} GPU (4 = 1 GPU)</li>
      <li className="flex items-center gap-2 text-muted/90">
        <span className="seat pointer-events-none !animate-none" data-kind="core" data-state="free" style={{ transform: "none" }} aria-hidden="true" />
        CPU seat = 1 core
      </li>
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
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 text-[12px] text-muted"><span>GPU load</span><span className="font-medium text-fg tabular">{fmtNum(g.gpu_utilization_pct)}%</span></div>
      <Bar value={g.gpu_utilization_pct} />
      <div className="flex items-baseline justify-between gap-3 text-[12.5px] tabular">
        <span className="whitespace-nowrap text-muted"><span className="text-fg">{fmtMB(g.used_vram_mb)}</span> / {fmtMB(g.total_vram_mb)}</span>
        <span className={`flex items-center gap-1 whitespace-nowrap ${t === "good" ? "text-muted" : t === "critical" ? "font-semibold text-danger-fg" : "font-semibold text-warn-fg"}`}>
          {t !== "good" && <IconAlert size={13} title={`Temperature ${t}`} />}
          {fmtNum(g.temperature_c, 0, " °C")}
        </span>
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

function MachineRow({ m, selected, selectedSeats, selectedCores, onSelectMachine, onToggleSeat, onPickCores, onDetails, setTip }: {
  m: MachineSeats;
  selected: boolean;
  selectedSeats: number[];
  selectedCores: number;
  onSelectMachine: (ip: string) => void;
  onToggleSeat: (ip: string, seat: number) => void;
  onPickCores: (ip: string, cores: number) => void;
  onDetails?: (ip: string) => void;
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

  const usable = m.online && m.inRay;
  const coreCount = usable ? m.cpus ?? 0 : 0;
  const coreState = (i: number): SeatState =>
    !usable ? "offline" : i < m.takenCores ? "taken" : selected && i < m.takenCores + selectedCores ? "selected" : "free";
  const showCoreTip = (e: React.SyntheticEvent<HTMLElement>, i: number, state: SeatState) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top, lines: [
      `CPU core ${i + 1}`,
      `Status: ${STATE_TEXT[state]}`,
      state === "free" ? `Click: use ${i - m.takenCores + 1} core${i - m.takenCores ? "s" : ""}` : `Allocation: 1 core`,
      `Machine: ${m.hostname}`,
    ] });
  };

  const status = !m.online ? "OFFLINE" : m.node.status;
  return (
    <div
      className={`grid grid-cols-1 items-center gap-4 rounded-xl border px-4 py-4 md:grid-cols-[minmax(150px,1.25fr)_244px_minmax(170px,0.9fr)] md:gap-6 md:px-5 transition-[background-color,border-color,box-shadow] duration-[180ms] ${selected ? "border-accent/60 bg-elevated shadow-[0_0_0_3px_rgb(var(--accent)/0.08)]" : "border-line bg-elevated/60 hover:border-line-strong hover:bg-elevated/90"} ${!m.online ? "opacity-70" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <IconLaptop size={24} className={`shrink-0 ${m.online ? "text-icon" : "text-muted/80"}`} />
        <button type="button" onClick={() => onSelectMachine(m.ip)} aria-pressed={selected}
          className="min-w-0 flex-1 rounded-lg text-left">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all text-[15px] font-semibold leading-tight text-fg">{m.hostname}</span>
            <StatusPill status={status} />
          </span>
          <span className="mt-1.5 block text-[12.5px] leading-snug text-muted">
            {m.hasGpu ? `${gpuName ?? "GPU"}${m.gpuCount > 1 ? ` ×${m.gpuCount}` : ""}` : "CPU only"} ·{" "}
            <span className="whitespace-nowrap font-mono">{m.ip}</span>
          </span>
        </button>
        {onDetails && <button type="button" onClick={() => onDetails(m.ip)} aria-label={`Show details for ${m.hostname}`} title="Machine details"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg xl:hidden">
          <IconPanel size={16} />
        </button>}
      </div>

      <div className="grid w-[244px] max-w-full grid-cols-[40px_1fr] items-center gap-x-2 gap-y-3">
        {m.hasGpu && groups.map((grp) => (
          <React.Fragment key={grp.gpu}>
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">{m.gpuCount > 1 ? `GPU ${grp.gpu}` : "GPU"}</span>
            <div className="flex gap-1.5" role="group" aria-label={`${m.hostname} GPU ${grp.gpu}`}>
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
          </React.Fragment>
        ))}
        {coreCount > 0 ? (
          <>
            <span className="self-start pt-[3px] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">CPU</span>
            <div className="grid w-max grid-cols-8 gap-1" role="group" aria-label={`${m.hostname} CPU cores`}>
              {Array.from({ length: coreCount }, (_, i) => {
                const state = coreState(i);
                const actionable = state === "free" || state === "selected";
                return (
                  <button
                    key={i}
                    type="button"
                    className="seat"
                    data-kind="core"
                    data-state={state}
                    aria-pressed={state === "selected"}
                    aria-disabled={!actionable}
                    aria-label={`${m.hostname}, CPU core ${i + 1}: ${STATE_TEXT[state]}`}
                    onClick={() => actionable && onPickCores(m.ip, i - m.takenCores + 1)}
                    onMouseEnter={(e) => showCoreTip(e, i, state)}
                    onMouseLeave={() => setTip(null)}
                    onFocus={(e) => showCoreTip(e, i, state)}
                    onBlur={() => setTip(null)}
                  />
                );
              })}
            </div>
          </>
        ) : (
          <button type="button" onClick={() => onSelectMachine(m.ip)}
            className="col-span-2 inline-flex items-center gap-2 justify-self-start rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted">
            <IconCpu size={15} />
            {!m.online ? "Offline" : !m.inRay ? "Worker not joined to Ray" : "No cores offered"}
          </button>
        )}
      </div>

      <div className="min-w-0">
        <Telemetry m={m} />
      </div>
    </div>
  );
}

export default function SeatMap({ data, selectedIp, selectedSeats, selectedCores, onSelectMachine, onToggleSeat, onPickCores, onDetails, loading, flat }: {
  data: SeatMapData;
  selectedIp: string | null;
  selectedSeats: number[];
  selectedCores: number;
  onSelectMachine: (ip: string) => void;
  onToggleSeat: (ip: string, seat: number) => void;
  onPickCores: (ip: string, cores: number) => void;
  onDetails?: (ip: string) => void;
  loading: boolean;
  /** Inside a dialog: no card chrome. */
  flat?: boolean;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const clearTip = useCallback(() => setTip(null), []);
  const free = data.machines.reduce((s, m) => s + m.freeSeats, 0);
  const total = data.machines.reduce((s, m) => s + (m.online && m.inRay ? m.totalSeats : 0), 0);

  return (
    <Wrap flat={flat}>
      <div className="flex flex-col gap-4">
        <SectionTitle id="seatmap-title" aside={data.rayConnected ? `${free} of ${total} seats free on online PCs` : undefined}>
          <span className="inline-flex items-center gap-2.5"><IconCluster size={22} className="shrink-0 text-icon" />Seat map</span>
        </SectionTitle>
        <Legend />
      </div>

      <div className="thin-scroll -mx-2 mt-4 overflow-x-auto px-2 pb-1" onScroll={clearTip}>
        <div className="flex flex-col gap-2.5 md:min-w-[720px]">
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
              <MachineRow key={m.ip} m={m} selected={m.ip === selectedIp} selectedSeats={selectedSeats} selectedCores={selectedCores}
                onSelectMachine={onSelectMachine} onToggleSeat={onToggleSeat} onPickCores={onPickCores} onDetails={onDetails} setTip={setTip} />
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
        <div role="tooltip" className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full animate-fade-in rounded-lg border border-line-strong glass-elevated px-3 py-2 text-[12px] leading-relaxed text-fg pop-shadow"
          style={{ left: tip.x, top: tip.y - 8 }}>
          <div className="font-semibold">{tip.lines[0]}</div>
          {tip.lines.slice(1).map((l) => <div key={l} className="text-muted">{l}</div>)}
        </div>
      )}
    </Wrap>
  );
}

function Wrap({ flat, children }: { flat?: boolean; children: React.ReactNode }) {
  return flat ? <section aria-labelledby="seatmap-title">{children}</section> : <Card className="p-5 md:p-6" aria-labelledby="seatmap-title">{children}</Card>;
}
