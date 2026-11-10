"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, postJson } from "./api";
import type { KernelRecord } from "./types";

/**
 * One notebook's runtime: a persistent Python process (Ray actor) on a worker GPU.
 * The kernel id is stored on the notebook, so a page reload re-attaches to it.
 */
export function useRuntime(base: string, kernelId: string | null, setKernelId: (id: string | null) => void) {
  const [kernel, setKernel] = useState<KernelRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(kernelId);
  idRef.current = kernelId;

  // Track the runtime: fast while it starts, slower once ready (detects a dead worker).
  useEffect(() => {
    if (!kernelId) {
      setKernel(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const k = await api<KernelRecord>(base, `/api/v1/kernels/${kernelId}`);
        if (!alive || idRef.current !== kernelId) return;
        setKernel(k);
        if (k.status === "ERROR") setError(k.error ?? "The runtime failed to start.");
        timer = setTimeout(check, k.status === "STARTING" ? 1000 : k.status === "READY" ? 8000 : 30000);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          // The Master restarted: that runtime no longer exists.
          setKernel(null);
          setKernelId(null);
          return;
        }
        timer = setTimeout(check, 5000);
      }
    }
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base, kernelId, setKernelId]);

  const connect = useCallback(
    async (target: string | null, numGpus: number, name?: string, numCpus?: number) => {
      setError(null);
      const k = await postJson<KernelRecord>(base, "/api/v1/kernels", {
        target_node_ip: target || null,
        num_gpus: numGpus,
        num_cpus: numCpus ?? null,
        name: name ?? null,
      });
      setKernel(k);
      setKernelId(k.kernel_id);
      return k;
    },
    [base, setKernelId]
  );

  const disconnect = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    try {
      await api<KernelRecord>(base, `/api/v1/kernels/${id}`, { method: "DELETE" });
    } catch {
      /* already gone */
    }
    setKernel(null);
    setKernelId(null);
  }, [base, setKernelId]);

  const interrupt = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    try {
      await postJson(base, `/api/v1/kernels/${id}/interrupt`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);

  const markDead = useCallback(() => {
    setKernel((k) => (k ? { ...k, status: "DEAD", error: k.error ?? "The runtime died." } : k));
  }, []);

  return { kernel, error, setError, connect, disconnect, interrupt, markDead, ready: kernel?.status === "READY" };
}
