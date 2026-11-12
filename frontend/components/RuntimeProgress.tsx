"use client";

import React, { useEffect, useState } from "react";
import { describeSpec, type ConnectPhase, type RuntimeSpec } from "../lib/runtime";
import { IconAlert, IconCheck, IconSpinner } from "./icons";
import { Button } from "./ui";

const STEPS: { phase: ConnectPhase; label: string; gpu: string; cpu: string }[] = [
  { phase: "requesting", label: "Requesting resources", gpu: "The Master checks that the seats and cores are free", cpu: "The Master checks that the cores are free" },
  { phase: "allocating", label: "Allocating seats", gpu: "Ray is reserving the GPU seats on this PC", cpu: "Ray is reserving the CPU cores on this PC" },
  { phase: "starting", label: "Starting runtime", gpu: "The Python runtime is booting on the worker", cpu: "The Python runtime is booting on the worker" },
  { phase: "ready", label: "Runtime ready", gpu: "Variables persist until you restart or release", cpu: "Variables persist until you restart or release" },
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

/** The four connect steps, shown while a runtime starts (and when it failed). */
export default function RuntimeProgress({ phase, spec, error, startedAt, failedAfterAccept, onCancel, onRetry, onPickOther }: {
  phase: ConnectPhase;
  spec: RuntimeSpec | null;
  error: string | null;
  startedAt: number | null;
  /** The Master accepted the request before it failed: the failure shows on step 2, else step 1. */
  failedAfterAccept: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onPickOther: () => void;
}) {
  const busy = phase === "requesting" || phase === "allocating" || phase === "starting";
  const elapsed = useElapsed(startedAt, busy);
  const cpu = !spec || spec.gpus <= 0;
  const failedStep = failedAfterAccept ? 1 : 0;
  const cur = ORDER.indexOf(phase);

  return (
    <section aria-label="Runtime progress" aria-live="polite" className="mb-3 animate-slide-in rounded-2xl border border-accent/30 glass-elevated p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-fg">
          {phase === "error" ? "Could not start the runtime" : `Connecting to ${spec?.hostname ?? "the swarm"}`}
          {spec && <span className="ml-2 font-normal text-muted">{describeSpec(spec)}</span>}
        </h2>
        {busy && <Button variant="ghost" onClick={onCancel} title="Stop and free the seats">Cancel</Button>}
      </div>
      <ol className="grid gap-3 sm:grid-cols-4">
        {STEPS.map((s, idx) => {
          const failedHere = phase === "error" && idx === failedStep;
          const done = phase === "ready" || (phase === "error" ? idx < failedStep : idx < cur);
          const active = busy && idx === cur;
          return (
            <li key={s.phase} className="flex items-start gap-2.5">
              <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${done ? "border-ok bg-ok text-canvas" : active ? "border-accent text-accent" : failedHere ? "border-danger text-danger-fg" : "border-line-strong text-muted"}`}>
                {done ? <IconCheck size={12} strokeWidth={3} /> : active ? <IconSpinner size={12} /> : failedHere ? <IconAlert size={11} /> : idx + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13px] font-medium ${done || active ? "text-fg" : "text-muted"}`}>{s.label}{active && elapsed > 2 ? ` · ${elapsed} s` : ""}</span>
                <span className="block text-[12px] text-muted">{cpu ? s.cpu : s.gpu}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {phase === "error" && (
        <div role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-[13px]">
          <div className="text-fg/85">{error}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {spec && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
            <Button variant="ghost" onClick={onPickOther}>Pick other hardware</Button>
          </div>
        </div>
      )}
    </section>
  );
}
