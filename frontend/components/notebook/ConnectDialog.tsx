"use client";

import React, { useState } from "react";
import { computeTargets, CORE_CHOICES, defaultCores, useCluster } from "../../lib/cluster";
import { fmtMB, fmtNum } from "../../lib/format";
import { Button } from "../ui";

const SHARES = [
  { value: 1, label: "Whole GPU", hint: "Like Colab: the GPU is reserved for this notebook" },
  { value: 0.5, label: "Half", hint: "Leaves room for one job or a second notebook" },
  { value: 0.25, label: "Quarter", hint: "Up to four notebooks/jobs share the GPU" },
  { value: 0, label: "CPU only", hint: "No GPU: the code runs on the CPU cores below, on any PC (also PCs without a GPU)" },
];

export default function ConnectDialog({ initialTarget, initialShare, initialCores, onConnect, onClose }: {
  initialTarget: string;
  initialShare: number;
  initialCores?: number;
  onConnect: (target: string, share: number, cores: number) => void;
  onClose: () => void;
}) {
  const { nodes, ray } = useCluster();
  const targets = computeTargets(nodes, ray);
  const [target, setTarget] = useState(initialTarget);
  const [share, setShare] = useState(initialShare);
  const [cores, setCores] = useState(initialCores ?? defaultCores(initialShare));
  const chosen = targets.find((t) => t.ip === target);
  const cpuOnlyPc = !!chosen && !chosen.hasGpu;
  const effectiveShare = cpuOnlyPc ? 0 : share;
  const freeGpu = ray?.available_resources?.GPU;
  const freeCpu = ray?.available_resources?.CPU;
  // Most cores any single eligible PC can give (a runtime lives on ONE PC).
  const eligible = chosen ? [chosen] : targets.filter((t) => effectiveShare === 0 || t.hasGpu);
  const maxCores = Math.max(0, ...eligible.map((t) => t.cpus ?? 0));
  const tooMany = maxCores > 0 && cores > maxCores;

  const pickShare = (v: number) => {
    setShare(v);
    // Switching between GPU and CPU work: move the cores to that mode's default.
    if ((v === 0) !== (effectiveShare === 0)) setCores(defaultCores(v));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-canvas/70 p-4 pt-16" onMouseDown={onClose}>
      <div className="thin-scroll max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line-strong bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Connect runtime">
        <h2 className="text-base font-semibold text-fg">Connect a runtime</h2>
        <p className="mt-1 text-xs text-muted">
          Starts a Python process on the chosen PC. Variables persist between cells until you restart or disconnect.
          {(freeGpu !== undefined || freeCpu !== undefined) && (
            <> Free right now: <b className="text-fg">{fmtNum(freeGpu ?? 0, 2)}</b> GPU, <b className="text-fg">{fmtNum(freeCpu ?? 0)}</b> CPU cores.</>
          )}
        </p>

        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted">PC</div>
          <label className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${target === "" ? "border-accent/60 bg-accent/5" : "border-line hover:border-line-strong"}`}>
            <input type="radio" name="target" checked={target === ""} onChange={() => setTarget("")} className="accent-accent" />
            <span className="text-fg">{effectiveShare > 0 ? "Any free GPU" : "Any PC with free cores"}</span>
            <span className="ml-auto text-[11px] text-muted">Ray picks</span>
          </label>
          {targets.map((t) => {
            const g = t.node.gpus[0];
            return (
              <label key={t.ip} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${target === t.ip ? "border-accent/60 bg-accent/5" : "border-line hover:border-line-strong"}`}>
                <input type="radio" name="target" checked={target === t.ip} onChange={() => setTarget(t.ip)} className="accent-accent" />
                <span className="min-w-0">
                  <span className="block truncate text-fg">{t.node.hostname} · {t.hasGpu ? g?.name : "CPU only"}</span>
                  <span className="block text-[11px] text-muted">
                    {t.ip}
                    {t.cpus ? ` · ${t.cpus} cores, ${fmtNum(t.node.host?.cpu_utilization_pct ?? 0)}% CPU load` : ""}
                    {g ? ` · ${fmtMB(g.free_vram_mb)} VRAM free · ${fmtNum(g.gpu_utilization_pct)}% GPU load` : ""}
                    {t.node.active_kernels ? ` · ${t.node.active_kernels} runtime(s)` : ""}
                  </span>
                </span>
              </label>
            );
          })}
          {targets.length === 0 && <p className="text-xs text-warn-fg">No PC is online yet. Start a worker, then reopen this dialog.</p>}
        </div>

        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">GPU share</div>
          <div className="grid grid-cols-4 gap-1.5">
            {SHARES.map((s) => {
              const disabled = cpuOnlyPc && s.value > 0;
              return (
                <button key={s.value} onClick={() => pickShare(s.value)} title={disabled ? "This PC has no GPU" : s.hint} disabled={disabled}
                  className={`rounded-lg border px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${effectiveShare === s.value ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-fg/85 hover:border-line-strong"}`}>
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            {cpuOnlyPc ? "This PC has no GPU, so the runtime is CPU only" : SHARES.find((s) => s.value === effectiveShare)?.hint}.
            {effectiveShare > 0 && " Shares are a scheduling reservation; VRAM itself is not split."}
          </p>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">CPU cores</div>
          <div className="grid grid-cols-4 gap-1.5">
            {CORE_CHOICES.map((c) => (
              <button key={c} onClick={() => setCores(c)} disabled={maxCores > 0 && c > maxCores}
                title={maxCores > 0 && c > maxCores ? `No eligible PC offers ${c} cores` : `${c} core(s)`}
                className={`rounded-lg border px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${cores === c ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-fg/85 hover:border-line-strong"}`}>
                {c}
              </button>
            ))}
          </div>
          <p className={`mt-1.5 text-[11px] ${tooMany ? "text-warn-fg" : "text-muted"}`}>
            {tooMany
              ? `At most ${maxCores} cores on ${chosen ? "this PC" : "one PC"}: pick fewer.`
              : `PyTorch and NumPy use this many threads. ${effectiveShare > 0 ? "GPU work rarely needs more than 1–2." : "More cores = faster CPU training, but fewer left for others."} Use ts.map(...) to spread work over every PC's cores.`}
          </p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={tooMany} onClick={() => onConnect(target, effectiveShare, cores)}>Connect</Button>
        </div>
      </div>
    </div>
  );
}
