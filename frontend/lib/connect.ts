"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, postJson } from "./api";
import type { KernelRecord, RayStatus } from "./types";

/**
 * Starting a notebook runtime from the Cluster page, with honest progress:
 *
 *   requesting  POST /api/v1/kernels is in flight (the Master checks free shares and cores
 *               here and answers 409 with the reason when they are not available)
 *   allocating  the runtime is STARTING and Ray has not reserved its share yet
 *   starting    Ray's free GPU (or CPU) count dropped by the requested share: the seats are
 *               reserved and the Python process is booting on the worker
 *   ready       GET /api/v1/kernels/{id} reports READY
 *   error       the Master refused, or the runtime reported ERROR (its message is shown)
 *
 * Nothing is simulated: every transition comes from a backend response.
 */
export type ConnectPhase = "idle" | "requesting" | "allocating" | "starting" | "ready" | "error";

export interface ConnectRequest {
  ip: string;
  hostname: string;
  gpus: number;
  cpus: number;
}

export interface ConnectState {
  phase: ConnectPhase;
  request: ConnectRequest | null;
  kernel: KernelRecord | null;
  error: string | null;
  startedAt: number | null;
}

const IDLE: ConnectState = { phase: "idle", request: null, kernel: null, error: null, startedAt: null };

async function rayFree(base: string): Promise<{ gpu: number; cpu: number } | null> {
  try {
    const r = await api<RayStatus>(base, "/api/v1/ray/status");
    if (!r.connected) return null;
    return { gpu: r.available_resources?.GPU ?? 0, cpu: r.available_resources?.CPU ?? 0 };
  } catch {
    return null;
  }
}

export function useConnectFlow(base: string) {
  const [state, setState] = useState<ConnectState>(IDLE);
  const inFlight = useRef(false);
  const run = useRef(0);   // invalidates polling loops of an abandoned attempt

  useEffect(() => () => {
    run.current++;          // unmount: stop polling (the runtime itself keeps starting)
  }, []);

  const start = useCallback(async (req: ConnectRequest) => {
    if (inFlight.current) return;            // duplicate clicks never send a second request
    inFlight.current = true;
    const id = ++run.current;
    const alive = () => run.current === id;
    setState({ phase: "requesting", request: req, kernel: null, error: null, startedAt: Date.now() });

    const baseline = await rayFree(base);
    let kernel: KernelRecord;
    try {
      kernel = await postJson<KernelRecord>(base, "/api/v1/kernels", {
        target_node_ip: req.ip,
        num_gpus: req.gpus,
        num_cpus: req.cpus,
        name: `Notebook on ${req.hostname}`,
      });
    } catch (e) {
      if (alive()) {
        inFlight.current = false;
        setState((s) => ({ ...s, phase: "error", error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (!alive()) return;
    setState((s) => ({ ...s, phase: "allocating", kernel }));

    let reserved = false;
    while (alive()) {
      await new Promise((r) => setTimeout(r, 900));
      if (!alive()) break;
      try {
        const k = await api<KernelRecord>(base, `/api/v1/kernels/${kernel.kernel_id}`);
        if (!alive()) break;
        if (k.status === "READY") {
          setState((s) => ({ ...s, phase: "ready", kernel: k }));
          break;
        }
        if (k.status === "ERROR" || k.status === "DEAD") {
          setState((s) => ({ ...s, phase: "error", kernel: k, error: k.error || "The runtime failed to start." }));
          break;
        }
        if (!reserved && baseline) {
          const now = await rayFree(base);
          const need = req.gpus > 0 ? req.gpus : req.cpus;
          const before = req.gpus > 0 ? baseline.gpu : baseline.cpu;
          const after = now ? (req.gpus > 0 ? now.gpu : now.cpu) : null;
          if (after !== null && before - after >= need - 1e-6) reserved = true;
        }
        setState((s) => ({ ...s, kernel: k, phase: reserved ? "starting" : "allocating" }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          if (alive()) setState((s) => ({ ...s, phase: "error", error: "The runtime disappeared (the Master may have restarted)." }));
          break;
        }
        // transient network error: keep polling
      }
    }
    if (alive()) inFlight.current = false;   // a newer attempt owns the flag otherwise
  }, [base]);

  /** Stops a runtime that is starting or ready but not opened yet, freeing its seats. */
  const cancel = useCallback(async () => {
    const k = state.kernel;
    run.current++;
    inFlight.current = false;
    setState(IDLE);
    if (k) {
      try {
        await api(base, `/api/v1/kernels/${k.kernel_id}`, { method: "DELETE" });
      } catch {
        /* already gone */
      }
    }
  }, [base, state.kernel]);

  const reset = useCallback(() => {
    run.current++;
    inFlight.current = false;
    setState(IDLE);
  }, []);

  return { ...state, busy: state.phase === "requesting" || state.phase === "allocating" || state.phase === "starting", start, cancel, reset };
}
