"use client";

import React, { useEffect, useState } from "react";
import { CORE_CHOICES } from "../../lib/cluster";
import type { ConnectPhase } from "../../lib/connect";
import { fmtMB, fmtNum } from "../../lib/format";
import { fmtShare, SEAT_GPU, seatSelectionProblem, type MachineSeats } from "../../lib/seats";
import { IconAlert, IconArrowRight, IconCheck, IconSpinner } from "../icons";
import { Button, Segmented } from "../ui";

const STEPS: { phase: ConnectPhase; label: string; detail: string }[] = [
  { phase: "requesting", label: "Requesting resources", detail: "The Master checks that the share and cores are free" },
  { phase: "allocating", label: "Allocating GPU seats", detail: "Ray is reserving the seats on this PC" },
  { phase: "starting", label: "Starting notebook", detail: "The Python runtime is booting on the worker" },
  { phase: "ready", label: "Notebook ready", detail: "Variables persist until you restart or disconnect" },
];
const ORDER: ConnectPhase[] = ["requesting", "allocating", "starting", "ready"];

function useElapsed(from: number | null, running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return from ? Math.max(0, Math.round((now - from) / 1000)) : 0;
}

export default function AllocationPanel({ machine, seats, cores, setCores, onClearSeats, flow, onConnect, onOpen, onCancel }: {
  machine: MachineSeats | null;
  seats: number;
  cores: number;
  setCores: (n: number) => void;
  onClearSeats: () => void;
  flow: {
    phase: ConnectPhase; error: string | null; startedAt: number | null; busy: boolean;
    request: { hostname: string; gpus: number; cpus: number } | null;
    kernel: { kernel_id: string } | null;
  };
  onConnect: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const gpus = seats * SEAT_GPU;
  const g = machine?.node.gpus[0];
  const problem = seatSelectionProblem(seats, machine);
  const maxCores = machine?.cpus ?? 0;
  const coreOptions = CORE_CHOICES.map((c) => ({
    value: c, label: String(c),
    disabled: maxCores > 0 && c > maxCores,
    title: maxCores > 0 && c > maxCores ? `${machine?.hostname} offers ${maxCores} cores` : `${c} core${c === 1 ? "" : "s"}`,
  }));
  const tooManyCores = maxCores > 0 && cores > maxCores;
  // A GPU PC can also take a CPU-only runtime (0 seats); it must have joined Ray either way.
  const canConnect = !!machine && machine.online && machine.inRay && !problem && !tooManyCores && !flow.busy;
  // On error: failed before the Master answered = step 1, after it accepted = step 2.
  const failedStep = flow.kernel ? 1 : 0;
  const showProgress = flow.phase !== "idle";
  const elapsed = useElapsed(flow.startedAt, flow.busy);

  // On a GPU PC the main action needs seats; CPU-only stays available as the secondary action.
  const needsSeats = !!machine?.hasGpu && seats === 0;
  let cta = "Pick seats or a PC";
  if (machine) cta = needsSeats ? "Select GPU seats above" : seats > 0 ? `Connect notebook · ${fmtShare(gpus)}` : "Connect CPU-only notebook";

  return (
    <section aria-labelledby="alloc-title" className="rounded-2xl border border-accent/30 bg-elevated/80 p-5 panel-shadow md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="alloc-title" className="text-[20px] font-semibold tracking-[-0.01em] text-fg">Resource allocation</h2>
          <p className="text-[13px] text-muted">
            {machine ? <>Starting a notebook runtime on <b className="font-semibold text-fg">{machine.hostname}</b>.</> : "Select free seats on the map, or a PC for a CPU-only runtime."}
          </p>
        </div>
        {seats > 0 && !flow.busy && (
          <Button variant="ghost" onClick={onClearSeats}>Clear selection</Button>
        )}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
          <div>
            <dt className="text-[12px] font-medium text-muted">Machine</dt>
            <dd className="mt-0.5 truncate font-semibold text-fg">{machine?.hostname ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium text-muted">Selection</dt>
            <dd className="mt-0.5 font-semibold text-fg tabular" aria-live="polite">
              {seats > 0 ? <>{seats} seat{seats === 1 ? "" : "s"} = <span className="text-fg">{fmtShare(gpus)}</span></> : machine ? "CPU only (0 seats)" : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium text-muted">GPU</dt>
            <dd className="mt-0.5 truncate text-fg">{g ? g.name.replace(/^NVIDIA /, "") : machine ? "None (CPU only)" : "—"}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium text-muted">VRAM</dt>
            <dd className="mt-0.5 text-fg tabular">{g ? <>{fmtMB(g.free_vram_mb)} free of {fmtMB(g.total_vram_mb)}</> : "—"}</dd>
          </div>
          {g && seats > 0 && (
            <p className="col-span-2 text-[12px] text-muted">Seats reserve GPU scheduling time; VRAM is not split. Everyone seated on this GPU shares its {fmtMB(g.total_vram_mb)}.</p>
          )}
        </dl>

        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-muted" id="cores-label">CPU cores</div>
            <Segmented<number> label="CPU cores" options={coreOptions} value={cores} onChange={setCores} />
            <p className="mt-1.5 text-[12px] text-muted">
              {seats > 0 ? "GPU work rarely needs more than 1–2 threads." : "CPU-only training wants 4 or more."}
              {machine?.cpus ? ` ${machine.hostname} offers ${fmtNum(machine.cpus)}.` : ""}
            </p>
          </div>
          {(problem || tooManyCores) && (
            <p className="flex items-start gap-2 text-[12.5px] text-warn-fg"><IconAlert size={14} className="mt-0.5 shrink-0" />{problem ?? `At most ${maxCores} cores on this PC.`}</p>
          )}
          {machine && !machine.online && <p className="text-[12.5px] text-warn-fg">This PC is offline.</p>}
          {machine && machine.online && machine.hasGpu && !machine.inRay && <p className="text-[12.5px] text-warn-fg">This PC&apos;s worker has not joined Ray, so it cannot run code yet.</p>}
          <button type="button" onClick={onConnect} disabled={!canConnect || needsSeats}
            className="mt-auto inline-flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[14.5px] font-semibold text-accent-fg shadow-[0_1px_0_rgb(255_255_255/0.3)_inset,0_8px_24px_-12px_rgb(var(--accent)/0.8)] transition-[background-color,filter,transform] duration-150 hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none">
            {flow.busy ? <IconSpinner size={16} /> : null}
            {flow.busy ? "Connecting…" : cta}
          </button>
          {needsSeats && canConnect && (
            <button type="button" onClick={onConnect}
              className="self-center rounded-md px-2 py-1 text-[13px] font-medium text-muted underline decoration-line-strong underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-accent">
              or start a CPU-only notebook on {machine?.hostname}
            </button>
          )}
        </div>
      </div>

      {showProgress && (
        <div className="mt-5 animate-slide-in rounded-xl border border-line bg-canvas/40 p-4" aria-live="polite">
          <ol className="grid gap-3 sm:grid-cols-4">
            {STEPS.map((s) => {
              const cur = ORDER.indexOf(flow.phase);
              const idx = ORDER.indexOf(s.phase);
              const failedHere = flow.phase === "error" && idx === failedStep;
              const done = flow.phase === "ready" || (flow.phase === "error" ? idx < failedStep : idx < cur);
              const active = flow.phase !== "error" && idx === cur && flow.phase !== "ready";
              return (
                <li key={s.phase} className="flex items-start gap-2.5">
                  <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${done ? "border-ok bg-ok text-canvas" : active ? "border-accent text-accent" : failedHere ? "border-danger text-danger-fg" : "border-line-strong text-muted"}`}>
                    {done ? <IconCheck size={12} strokeWidth={3} /> : active ? <IconSpinner size={12} /> : failedHere ? <IconAlert size={11} /> : idx + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[13px] font-medium ${done || active ? "text-fg" : "text-muted"}`}>{s.label}{active && elapsed > 2 ? ` · ${elapsed} s` : ""}</span>
                    <span className="block text-[12px] text-muted">{s.detail}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          {flow.busy && flow.kernel && (
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" onClick={onCancel} title="Stop this runtime and free its seats">Cancel</Button>
            </div>
          )}
          {flow.phase === "error" && (
            <div role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-[13px] text-danger-fg">
              <div className="font-semibold">Could not start the notebook</div>
              <div className="mt-0.5 text-fg/85">{flow.error}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={onConnect}>Try again</Button>
                <Button variant="ghost" onClick={onClearSeats}>Choose other seats</Button>
              </div>
            </div>
          )}
          {flow.phase === "ready" && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-fg">Runtime is up on <b>{flow.request?.hostname}</b> with {flow.request && flow.request.gpus > 0 ? fmtShare(flow.request.gpus) : "no GPU"} and {flow.request?.cpus} core{flow.request?.cpus === 1 ? "" : "s"}.</span>
              <button type="button" onClick={onOpen}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-semibold text-accent-fg transition-[background-color] duration-150 hover:bg-accent-hover">
                Open notebook <IconArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
