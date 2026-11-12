"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError, postJson } from "./api";
import { useCluster } from "./cluster";
import type { KernelRecord, RayStatus } from "./types";

/**
 * This browser's notebook runtime: one persistent Python process (a Ray actor) on one PC.
 *
 * There is at most ONE runtime per browser, owned here (not by a page), so every tab of the
 * app sees the same one: the Cluster page marks its seats as yours, the sidebar shows it, and
 * the Notebook page attaches to it whichever way you navigate there. Its id is written to
 * localStorage the moment the Master accepts it, so a reload never orphans a runtime that
 * holds GPU seats.
 *
 * The Cluster page never allocates: it records the pick (`request`) and opens the Notebook
 * page, which calls `start`. Progress, with every transition taken from a backend response:
 *
 *   requesting  POST /api/v1/kernels is in flight (409 = seats or cores not free)
 *   allocating  the runtime is STARTING and Ray has not reserved its share yet
 *   starting    Ray's free GPU (or CPU) count dropped by the share: the Python process boots
 *   ready       GET /api/v1/kernels/{id} reports READY
 *   error       the Master refused, or the runtime reported ERROR/DEAD
 */

/** What a runtime asks for: one PC, a GPU share (0 = CPU only) and CPU cores. */
export interface RuntimeSpec {
  ip: string;
  hostname: string;
  gpus: number;
  cpus: number;
}

export type ConnectPhase = "idle" | "requesting" | "allocating" | "starting" | "ready" | "error";

interface Saved {
  kernelId: string | null;
  spec: RuntimeSpec | null;       // the current runtime's hardware, or the last one (to prefill pickers)
  pending: RuntimeSpec | null;    // picked on the Cluster page, started by the Notebook page
}

const KEY = "tensorswarm-runtime-v1";
const EMPTY: Saved = { kernelId: null, spec: null, pending: null };

function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && typeof v === "object" ? { ...EMPTY, ...v } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function write(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the runtime still works until the tab closes */
  }
}

async function rayFree(base: string): Promise<{ gpu: number; cpu: number } | null> {
  try {
    const r = await api<RayStatus>(base, "/api/v1/ray/status");
    return r.connected ? { gpu: r.available_resources?.GPU ?? 0, cpu: r.available_resources?.CPU ?? 0 } : null;
  } catch {
    return null;
  }
}

async function remove(base: string, id: string) {
  try {
    await api(base, `/api/v1/kernels/${id}`, { method: "DELETE" });
  } catch {
    /* already gone */
  }
}

export interface RuntimeState {
  /** False until localStorage has been read (pages wait for it before deciding anything). */
  loaded: boolean;
  kernelId: string | null;
  kernel: KernelRecord | null;
  spec: RuntimeSpec | null;
  pending: RuntimeSpec | null;
  phase: ConnectPhase;
  busy: boolean;
  ready: boolean;
  error: string | null;
  /**
   * What the last error was: the Master refused the request (step 1), the runtime failed while
   * starting (step 2), or a runtime that was running stopped (worker died, Master restarted).
   */
  errorKind: "refused" | "failed" | "stopped" | null;
  startedAt: number | null;
  setError: (e: string | null) => void;
  /** Releases any current runtime, then starts one on `spec`. */
  start: (spec: RuntimeSpec, name?: string) => Promise<void>;
  /** Stops the runtime (also one still starting) and frees its seats. */
  release: () => Promise<void>;
  /** Cluster page: remember a pick for the Notebook page to start. */
  request: (spec: RuntimeSpec) => void;
  /** Take over a runtime id this browser already owned (notebooks saved before v1). */
  adopt: (kernelId: string) => void;
  interrupt: () => Promise<void>;
  markDead: () => void;
}

const Ctx = createContext<RuntimeState | null>(null);

export function RuntimeProvider({ children }: { children: React.ReactNode }) {
  const { base } = useCluster();
  const [saved, setSaved] = useState<Saved>(EMPTY);
  const savedRef = useRef(saved);
  const [loaded, setLoaded] = useState(false);
  const [kernel, setKernel] = useState<KernelRecord | null>(null);
  const [stage, setStage] = useState<"requesting" | "allocating" | "starting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<RuntimeState["errorKind"]>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const run = useRef(0);                    // bumps when an attempt is abandoned (release, new start)
  const baseline = useRef<{ gpu: number; cpu: number } | null>(null);

  const commit = useCallback((patch: Partial<Saved>) => {
    const next = { ...savedRef.current, ...patch };
    savedRef.current = next;
    setSaved(next);
    write(next);                            // synchronous: a reload right after this still knows the id
  }, []);

  useEffect(() => {
    const s = read();
    savedRef.current = s;
    setSaved(s);
    setLoaded(true);
    // Another tab started or released the runtime: follow it.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      const v = read();
      savedRef.current = v;
      setSaved(v);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const drop = useCallback((id: string, message: string | null) => {
    if (savedRef.current.kernelId !== id) return;
    commit({ kernelId: null });
    setKernel(null);
    if (message) {
      setError(message);
      setErrorKind(stageRef.current ? "failed" : "stopped");
    }
    setStage(null);
  }, [commit]);

  // Track the runtime: fast while it starts, slower once ready (detects a dead worker).
  useEffect(() => {
    const id = saved.kernelId;
    if (!id) {
      setKernel(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const k = await api<KernelRecord>(base, `/api/v1/kernels/${id}`);
        if (!alive) return;
        setKernel(k);
        if (!savedRef.current.spec) {
          // Adopted id: learn its hardware from the record.
          const ip = k.target_node_ip || k.info?.node_ip || "";
          commit({ spec: { ip, hostname: k.info?.hostname || ip, gpus: k.num_gpus, cpus: k.num_cpus ?? 1 } });
        }
        if (k.status === "ERROR" || k.status === "DEAD") {
          remove(base, id!);
          drop(id!, k.error || (k.status === "DEAD" ? "The runtime stopped." : "The runtime failed to start."));
          return;
        }
        if (k.status === "READY") {
          setStage(null);
        } else if (baseline.current && savedRef.current.spec) {
          const spec = savedRef.current.spec;
          const now = await rayFree(base);
          if (!alive) return;
          const need = spec.gpus > 0 ? spec.gpus : spec.cpus;
          const before = spec.gpus > 0 ? baseline.current.gpu : baseline.current.cpu;
          const after = now ? (spec.gpus > 0 ? now.gpu : now.cpu) : null;
          if (after !== null && before - after >= need - 1e-6) {
            baseline.current = null;
            setStage("starting");
          }
        }
        timer = setTimeout(check, k.status === "STARTING" ? 900 : 8000);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          drop(id!, "The runtime is gone (the Master may have restarted). Connect again to continue.");
          return;
        }
        timer = setTimeout(check, 5000);   // network blip: keep the runtime, retry
      }
    }
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base, saved.kernelId, commit, drop]);

  const start = useCallback(async (spec: RuntimeSpec, name?: string) => {
    if (inFlight.current) return;           // a double click never sends a second request
    inFlight.current = true;
    const attempt = ++run.current;
    setError(null);
    setStartedAt(Date.now());
    setStage("requesting");
    const prev = savedRef.current.kernelId;
    commit({ kernelId: null, spec, pending: null });
    setKernel(null);
    try {
      if (prev) await remove(base, prev);   // one runtime at a time: free its seats first
      baseline.current = await rayFree(base);
      const k = await postJson<KernelRecord>(base, "/api/v1/kernels", {
        target_node_ip: spec.ip || null,
        num_gpus: spec.gpus,
        num_cpus: spec.cpus,
        name: name ?? `Notebook on ${spec.hostname}`,
      });
      if (run.current !== attempt) {
        remove(base, k.kernel_id);          // released while the request was in flight
        return;
      }
      commit({ kernelId: k.kernel_id });
      setKernel(k);
      setStage(k.status === "READY" ? null : baseline.current ? "allocating" : "starting");
    } catch (e) {
      if (run.current === attempt) {
        setStage(null);
        setErrorKind("refused");
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (run.current === attempt) inFlight.current = false;
    }
  }, [base, commit]);

  const release = useCallback(async () => {
    run.current++;
    inFlight.current = false;
    setStage(null);
    setError(null);
    const id = savedRef.current.kernelId;
    commit({ kernelId: null });
    setKernel(null);
    if (id) await remove(base, id);
  }, [base, commit]);

  const request = useCallback((spec: RuntimeSpec) => commit({ pending: spec }), [commit]);

  const adopt = useCallback((kernelId: string) => {
    if (!savedRef.current.kernelId) commit({ kernelId, spec: null });
  }, [commit]);

  const interrupt = useCallback(async () => {
    const id = savedRef.current.kernelId;
    if (!id) return;
    try {
      await postJson(base, `/api/v1/kernels/${id}/interrupt`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);

  const markDead = useCallback(() => {
    const id = savedRef.current.kernelId;
    if (!id) return;
    remove(base, id);
    drop(id, "The runtime stopped. Connect again to continue.");
  }, [base, drop]);

  const phase: ConnectPhase =
    stage ?? (kernel?.status === "READY" ? "ready" : saved.kernelId ? "starting" : error && errorKind ? "error" : "idle");

  const value: RuntimeState = {
    loaded, kernelId: saved.kernelId, kernel, spec: saved.spec, pending: saved.pending,
    phase, busy: phase === "requesting" || phase === "allocating" || phase === "starting",
    ready: kernel?.status === "READY", error, errorKind, startedAt,
    setError, start, release, request, adopt, interrupt, markDead,
  };
  return React.createElement(Ctx.Provider, { value }, children);
}

export function useRuntime(): RuntimeState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRuntime must be used inside <RuntimeProvider>");
  return v;
}

/** "RTX 3050 Laptop · 0.5 GPU · 2 cores" style label for a spec. */
export function describeSpec(spec: RuntimeSpec, gpuName?: string | null): string {
  const cores = `${spec.cpus} core${spec.cpus === 1 ? "" : "s"}`;
  if (spec.gpus <= 0) return `CPU only · ${cores}`;
  const g = gpuName ? `${gpuName.replace(/^NVIDIA (GeForce )?/, "")} · ` : "";
  return `${g}${+spec.gpus.toFixed(2)} GPU · ${cores}`;
}
