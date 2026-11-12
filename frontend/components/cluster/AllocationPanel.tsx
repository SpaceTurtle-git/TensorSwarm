"use client";

import React, { useEffect, useState } from "react";
import { fmtMB, fmtNum } from "../../lib/format";
import { describeSpec, type RuntimeState, type RuntimeSpec } from "../../lib/runtime";
import type { SeatSelection } from "../../lib/seatPicker";
import { fmtShare } from "../../lib/seats";
import { IconAlert, IconArrowRight, IconLayers } from "../icons";
import { Button, StatusPill } from "../ui";

/**
 * The pick (one PC, GPU seats and/or CPU cores) and the one action that uses it. The same panel
 * runs on the Cluster page ("Open notebook": the Notebook page starts the runtime) and in the
 * Notebook's Connect dialog ("Connect"). Holding a runtime already? Replacing it asks first.
 */
export default function AllocationPanel({ sel, runtime, action, onGo, onOpenCurrent, compact }: {
  sel: SeatSelection;
  runtime: RuntimeState;
  action: "open" | "connect";
  onGo: (spec: RuntimeSpec) => void;
  /** Cluster page: jump to the notebook that uses the current runtime. */
  onOpenCurrent?: () => void;
  compact?: boolean;
}) {
  const { machine, cores, gpus, problem, spec } = sel;
  const seats = sel.seats.length;
  const g = machine?.node.gpus[0];
  const holding = !!runtime.kernelId;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [spec?.ip, spec?.gpus, spec?.cpus, holding]);

  let cta = "Select GPU seats or CPU cores";
  if (spec) {
    const what = spec.gpus > 0 ? `${fmtShare(spec.gpus)} · ${cores} core${cores === 1 ? "" : "s"}` : `CPU only · ${cores} core${cores === 1 ? "" : "s"}`;
    cta = `${action === "open" ? "Open notebook" : "Connect"} · ${what}`;
  }
  const go = () => {
    if (!spec) return;
    if (holding && !confirming) setConfirming(true);
    else onGo(spec);
  };

  let hint: string | null = null;
  if (machine && !machine.online) hint = "This PC is offline.";
  else if (machine && !machine.inRay) hint = "This PC's worker has not joined Ray, so it cannot run code yet.";
  else if (problem) hint = problem;
  else if (machine && seats > 0 && cores === 0) hint = "Pick at least one CPU core for the runtime.";

  return (
    <section aria-labelledby="alloc-title" className={compact ? "" : "rounded-2xl border border-accent/30 glass-elevated p-5 md:p-6"}>
      {!compact && (
        <div className="space-y-1">
          <h2 id="alloc-title" className="flex items-center gap-2.5 text-[20px] font-semibold tracking-[-0.01em] text-fg">
            <IconLayers size={22} className="shrink-0 text-icon" />Resource allocation
          </h2>
          <p className="text-[13px] text-muted">
            Select GPU seats for a GPU notebook, or only CPU cores for a CPU notebook. Then open the notebook: the runtime starts there.
          </p>
        </div>
      )}

      {holding && runtime.spec && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-canvas/40 px-3.5 py-2.5 text-[13px]">
          <StatusPill status={runtime.kernel?.status ?? "STARTING"} />
          <span className="min-w-0 flex-1 text-fg">
            Your runtime: <b className="font-semibold">{runtime.spec.hostname}</b> · {describeSpec(runtime.spec)}
          </span>
          {onOpenCurrent && <Button variant="secondary" onClick={onOpenCurrent}>Open notebook <IconArrowRight size={14} /></Button>}
          <Button variant="ghost" onClick={() => runtime.release()} title="Stop the runtime and free its seats">Release</Button>
        </div>
      )}

      <div className={`grid gap-4 ${compact ? "mt-3" : "mt-5"} md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]`}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
          <div>
            <dt className="text-[12px] font-medium text-muted">Machine</dt>
            <dd className="mt-0.5 truncate font-semibold text-fg">{machine?.hostname ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium text-muted">Selection</dt>
            <dd className="mt-0.5 font-semibold text-fg tabular" aria-live="polite">
              {!machine ? "—" : seats > 0 ? `${seats} GPU seat${seats === 1 ? "" : "s"} = ${fmtShare(gpus)}` : cores > 0 ? "CPU only" : "Nothing yet"}
              {machine && cores > 0 ? ` · ${cores} core${cores === 1 ? "" : "s"}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium text-muted">GPU</dt>
            <dd className="mt-0.5 truncate text-fg">{g ? g.name.replace(/^NVIDIA /, "") : machine ? "None (CPU only)" : "—"}</dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium text-muted">{g ? "VRAM" : "CPU cores"}</dt>
            <dd className="mt-0.5 text-fg tabular">
              {g ? <>{fmtMB(g.free_vram_mb)} free of {fmtMB(g.total_vram_mb)}</> : machine ? `${fmtNum(machine.freeCores)} free of ${fmtNum(machine.cpus ?? 0)}` : "—"}
            </dd>
          </div>
          {g && seats > 0 && (
            <p className="col-span-2 text-[12px] text-muted">Seats reserve GPU scheduling time; VRAM is not split. Everyone seated on this GPU shares its {fmtMB(g.total_vram_mb)}.</p>
          )}
        </dl>

        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-muted">
            {seats > 0
              ? "GPU work rarely needs more than 1–2 cores. Click a CPU seat to change the count."
              : "CPU-only training wants 4 or more cores. Click a CPU seat: every seat up to it is selected."}
          </p>
          {hint && <p className="flex items-start gap-2 text-[12.5px] text-warn-fg"><IconAlert size={14} className="mt-0.5 shrink-0" />{hint}</p>}

          {confirming && runtime.spec ? (
            <div role="alertdialog" aria-label="Replace your runtime" className="rounded-xl border border-warn/50 bg-warn/10 p-3 text-[13px] text-fg">
              <p>This releases your runtime on <b>{runtime.spec.hostname}</b> ({describeSpec(runtime.spec)}). Its variables are lost.</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button variant="primary" onClick={go}>Release and continue</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>Keep current runtime</Button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={go} disabled={!spec}
              className="mt-auto inline-flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[14.5px] font-semibold text-accent-fg shadow-[0_1px_0_rgb(255_255_255/0.3)_inset,0_8px_24px_-12px_rgb(var(--accent)/0.8)] transition-[background-color,filter,transform] duration-150 hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:bg-line disabled:text-muted disabled:shadow-none">
              {cta}
              {spec && action === "open" && <IconArrowRight size={16} />}
            </button>
          )}
          {(seats > 0 || cores > 0) && (
            <button type="button" onClick={sel.clear} className="self-center rounded-md px-2 py-0.5 text-[12.5px] text-muted underline decoration-line-strong underline-offset-4 hover:text-fg">
              Clear selection
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
