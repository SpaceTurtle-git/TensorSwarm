"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, MASTER_URL_STORAGE_KEY, normalizeBase, storageGet, storageSet } from "./api";
import type { ClusterSummary, HistorySample, JobResult, KernelRecord, NodeRecord, RayStatus, Sample } from "./types";

const CONFIGURED_MASTER_URL = normalizeBase(process.env.NEXT_PUBLIC_MASTER_URL);
const POLL_MS = 3000;

interface ClusterState {
  base: string;                       // "" = same-origin Next.js proxy
  masterUrl: string;
  setMasterUrl: (url: string) => void;
  nodes: NodeRecord[];
  summary: ClusterSummary | null;
  ray: RayStatus | null;
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

const ClusterContext = createContext<ClusterState | null>(null);

export function ClusterProvider({ children }: { children: React.ReactNode }) {
  const [masterUrl, setMasterUrlState] = useState<string>(CONFIGURED_MASTER_URL);
  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [summary, setSummary] = useState<ClusterSummary | null>(null);
  const [ray, setRay] = useState<RayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const tick = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const saved = storageGet(MASTER_URL_STORAGE_KEY);
    setMasterUrlState(CONFIGURED_MASTER_URL || normalizeBase(saved));
    setReady(true);
  }, []);

  const setMasterUrl = useCallback((url: string) => {
    setMasterUrlState(url);
    storageSet(MASTER_URL_STORAGE_KEY, normalizeBase(url) || null);
  }, []);

  const base = normalizeBase(masterUrl);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    async function load() {
      try {
        const [n, s] = await Promise.all([
          api<NodeRecord[]>(base, "/api/v1/nodes"),
          api<ClusterSummary>(base, "/api/v1/cluster/summary"),
        ]);
        // Ray status is slower (asks the Ray head); refresh it every other tick.
        const r = tick.current++ % 2 === 0 ? await api<RayStatus>(base, "/api/v1/ray/status").catch(() => null) : undefined;
        if (!alive) return;
        n.sort((a, b) => a.hostname.localeCompare(b.hostname) || a.node_id.localeCompare(b.node_id));
        setNodes(n);
        setSummary(s);
        if (r !== undefined) setRay(r);
        setError(null);
        setLastUpdated(Date.now());
      } catch (err) {
        if (!alive) return;
        setError(
          `Could not reach the Master API at ${base || "this server"}` +
            (err instanceof Error ? ` (${err.message})` : "") +
            ". Check that the Master is running."
        );
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base, ready, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <ClusterContext.Provider
      value={{ base, masterUrl, setMasterUrl, nodes, summary, ray, error, loading, lastUpdated, refresh }}
    >
      {children}
    </ClusterContext.Provider>
  );
}

export function useCluster(): ClusterState {
  const ctx = useContext(ClusterContext);
  if (!ctx) throw new Error("useCluster must be used inside <ClusterProvider>");
  return ctx;
}

/** Polls one node's telemetry history (5 s resolution). */
export function useNodeHistory(nodeId: string | null, minutes = 10, enabled = true): HistorySample[] {
  const { base } = useCluster();
  const [samples, setSamples] = useState<HistorySample[]>([]);
  useEffect(() => {
    if (!nodeId || !enabled) return;
    let alive = true;
    async function load() {
      try {
        const res = await api<{ samples: HistorySample[] }>(
          base,
          `/api/v1/nodes/${encodeURIComponent(nodeId as string)}/history?minutes=${minutes}`
        );
        if (alive) setSamples(res.samples);
      } catch {
        /* keep the last good data */
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base, nodeId, minutes, enabled]);
  return samples;
}

/**
 * Notebook runtimes and recent jobs, for the seat map and the active-workloads list.
 * Polled only by the pages that use it (every 3 s, same cadence as the cluster poll).
 */
export function useWorkloads(enabled = true): {
  kernels: KernelRecord[];
  jobs: JobResult[];
  error: string | null;
  refresh: () => void;
} {
  const { base } = useCluster();
  const [kernels, setKernels] = useState<KernelRecord[]>([]);
  const [jobs, setJobs] = useState<JobResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    async function load() {
      try {
        const [k, j] = await Promise.all([
          api<KernelRecord[]>(base, "/api/v1/kernels"),
          api<JobResult[]>(base, "/api/v1/jobs?limit=20"),
        ]);
        if (!alive) return;
        setKernels(k);
        setJobs(j);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base, enabled, key]);
  const refresh = useCallback(() => setKey((k) => k + 1), []);
  return { kernels, jobs, error, refresh };
}

/** Sample scripts served by the Master (master/samples/*.py). */
export function useSamples(): { samples: Sample[]; error: string | null } {
  const { base } = useCluster();
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<Sample[]>(base, "/api/v1/samples")
      .then((s) => alive && (setSamples(s), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [base]);
  return { samples, error };
}

export interface ComputeTarget {
  ip: string;
  label: string;
  node: NodeRecord;
  hasGpu: boolean;
  /** CPU cores this PC offers to Ray (null until Ray status has loaded). */
  cpus: number | null;
}

/** Every online PC that can run code, GPU PCs first, then CPU-only PCs. */
export function computeTargets(nodes: NodeRecord[], ray?: RayStatus | null): ComputeTarget[] {
  const cpusByIp = new Map<string, number>();
  for (const r of ray?.nodes ?? []) if (r.alive) cpusByIp.set(r.ip, (cpusByIp.get(r.ip) ?? 0) + r.cpus);
  const rayKnown = (ray?.nodes?.length ?? 0) > 0;
  const seen = new Set<string>();
  return nodes
    .filter((n) => n.status !== "OFFLINE")
    .filter((n) => (seen.has(n.tailscale_ip) ? false : (seen.add(n.tailscale_ip), true)))
    .map((n) => {
      const hasGpu = n.gpu_count > 0;
      const cpus = rayKnown ? cpusByIp.get(n.tailscale_ip) ?? 0 : n.system?.cpu_cores_logical ?? null;
      const what = hasGpu ? n.gpus[0]?.name ?? "GPU" : "CPU only";
      return { ip: n.tailscale_ip, node: n, hasGpu, cpus, label: `${n.hostname} · ${what}${cpus ? ` · ${cpus} cores` : ""}` };
    })
    // A PC whose agent reports but that offers Ray nothing (worker not joined) cannot run code.
    .filter((t) => !rayKnown || t.hasGpu || (t.cpus ?? 0) > 0)
    .sort((a, b) => Number(b.hasGpu) - Number(a.hasGpu));
}

export const CORE_CHOICES = [1, 2, 4, 8];

/** Sensible default: GPU work needs few CPU threads; CPU-only work wants several. */
export function defaultCores(gpuShare: number): number {
  return gpuShare > 0 ? 1 : 4;
}

/** GPU-capable nodes that are online, for target pickers. */
export function gpuTargets(nodes: NodeRecord[]) {
  const seen = new Set<string>();
  return nodes
    .filter((n) => n.status !== "OFFLINE" && n.gpu_count > 0)
    .filter((n) => (seen.has(n.tailscale_ip) ? false : (seen.add(n.tailscale_ip), true)))
    .map((n) => ({ ip: n.tailscale_ip, label: `${n.hostname} · ${n.gpus[0]?.name ?? "GPU"}`, node: n }));
}
