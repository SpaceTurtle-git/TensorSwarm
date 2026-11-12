// GPU seat model. One seat = 0.25 GPU (the smallest share the dashboard offers); 4 seats = 1 GPU.
// Everything here derives from real API data:
//   - seats per PC: GPUs that PC offers to Ray (/api/v1/ray/status), x4
//   - taken seats:  GPU shares held by active notebook runtimes (/api/v1/kernels) and queued or
//                   running jobs (/api/v1/jobs) placed on that PC
//   - free seats in the whole swarm: Ray's own available GPU count (the scheduler's truth)
// Shares Ray holds that no runtime or job explains (e.g. ts.map tasks, or a runtime still being
// placed) are reported as `unplaced`, never silently assigned to a PC.

import type { JobResult, KernelRecord, NodeRecord, RayStatus } from "./types";

export const SEAT_GPU = 0.25;
export const SEATS_PER_GPU = 4;

export type WorkloadStatus = "starting" | "queued" | "running" | "completed" | "failed" | "stopped";

export interface Workload {
  id: string;
  kind: "notebook" | "job";
  name: string;
  status: WorkloadStatus;
  ip: string | null;
  machine: string | null;     // hostname when known
  gpus: number;
  cpus: number | null;
  startedAt: number | null;   // epoch ms
  durationSec: number | null; // finished jobs
  mine: boolean;              // a notebook in this browser owns it
  error?: string | null;
}

export interface MachineSeats {
  ip: string;
  node: NodeRecord;
  hostname: string;
  online: boolean;
  /** This PC's worker has joined Ray (it can actually run code). */
  inRay: boolean;
  hasGpu: boolean;
  gpuCount: number;
  totalSeats: number;
  takenSeats: number;
  freeSeats: number;
  /** CPU cores this PC offers to Ray; null while Ray status is unknown. */
  cpus: number | null;
  /** CPU "seats" (1 seat = 1 core) held by active runtimes and jobs on this PC. */
  takenCores: number;
  freeCores: number;
  workloads: Workload[];
}

export interface SeatMap {
  machines: MachineSeats[];
  rayConnected: boolean;
  /** Swarm-wide, from Ray: */
  totalSeats: number;
  freeSeats: number;
  /** GPU shares Ray holds that no listed runtime or job accounts for. */
  unplacedGpu: number;
}

const ACTIVE: WorkloadStatus[] = ["starting", "queued", "running"];
export const isActive = (w: Workload) => ACTIVE.includes(w.status);

function ms(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function toWorkloads(kernels: KernelRecord[], jobs: JobResult[], nodes: NodeRecord[], mineIds: Set<string>): Workload[] {
  const host = new Map(nodes.map((n) => [n.tailscale_ip, n.hostname] as const));
  const out: Workload[] = [];
  for (const k of kernels) {
    const ip = k.target_node_ip || k.info?.node_ip || null;
    const status: WorkloadStatus =
      k.status === "READY" ? "running" : k.status === "STARTING" ? "starting" : k.status === "ERROR" ? "failed" : "stopped";
    out.push({
      id: k.kernel_id, kind: "notebook", name: k.name || k.kernel_id, status, ip,
      machine: k.info?.hostname || (ip ? host.get(ip) ?? null : null),
      gpus: k.num_gpus, cpus: k.num_cpus ?? null, startedAt: ms(k.created_at), durationSec: null,
      mine: mineIds.has(k.kernel_id), error: k.error,
    });
  }
  for (const j of jobs) {
    const ip = j.executed_on_ip || j.target_node_ip || null;
    const status: WorkloadStatus =
      j.status === "RUNNING" ? "running" : j.status === "PENDING" ? "queued" : j.status === "COMPLETED" ? "completed" : "failed";
    out.push({
      id: j.job_id, kind: "job", name: j.job_name || j.job_id, status, ip,
      machine: j.executed_on_node || (ip ? host.get(ip) ?? null : null),
      gpus: j.num_gpus ?? 0, cpus: j.num_cpus ?? null,
      startedAt: ms(j.started_at) ?? ms(j.submitted_at), durationSec: j.execution_time_sec ?? null,
      mine: false, error: j.error,
    });
  }
  const rank = (w: Workload) => (isActive(w) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function buildSeatMap(nodes: NodeRecord[], ray: RayStatus | null, workloads: Workload[]): SeatMap {
  const rayConnected = !!ray?.connected;
  const gpusByIp = new Map<string, number>();
  const cpusByIp = new Map<string, number>();
  for (const r of ray?.nodes ?? []) {
    if (!r.alive) continue;
    gpusByIp.set(r.ip, (gpusByIp.get(r.ip) ?? 0) + r.gpus);
    cpusByIp.set(r.ip, (cpusByIp.get(r.ip) ?? 0) + r.cpus);
  }

  const active = workloads.filter(isActive);
  const heldByIp = new Map<string, number>();
  const coresByIp = new Map<string, number>();
  let placed = 0;
  for (const w of active) {
    if (w.ip) coresByIp.set(w.ip, (coresByIp.get(w.ip) ?? 0) + (w.cpus ?? 1));   // Ray's default is 1 core
    if (!w.ip || w.gpus <= 0) continue;
    heldByIp.set(w.ip, (heldByIp.get(w.ip) ?? 0) + w.gpus);
    placed += w.gpus;
  }

  // One entry per PC (the Master PC can report through two agents on one IP).
  const seen = new Set<string>();
  const machines: MachineSeats[] = [];
  for (const n of nodes) {
    if (seen.has(n.tailscale_ip)) continue;
    seen.add(n.tailscale_ip);
    const online = n.status !== "OFFLINE";
    const inRay = rayConnected && gpusByIp.has(n.tailscale_ip);
    const rayGpus = gpusByIp.get(n.tailscale_ip) ?? 0;
    const gpuCount = Math.max(n.gpu_count, Math.round(rayGpus));
    const offered = online && inRay ? rayGpus : 0;
    const totalSeats = Math.round((online && inRay ? offered : gpuCount) * SEATS_PER_GPU);
    const held = heldByIp.get(n.tailscale_ip) ?? 0;
    const takenSeats = online && inRay ? Math.min(totalSeats, Math.round(held / SEAT_GPU)) : 0;
    const freeSeats = online && inRay ? totalSeats - takenSeats : 0;
    const cpus = rayConnected ? cpusByIp.get(n.tailscale_ip) ?? 0 : n.system?.cpu_cores_logical ?? null;
    const takenCores = online && inRay ? Math.min(cpus ?? 0, coresByIp.get(n.tailscale_ip) ?? 0) : 0;
    machines.push({
      ip: n.tailscale_ip, node: n, hostname: n.hostname, online, inRay,
      hasGpu: gpuCount > 0, gpuCount, totalSeats, takenSeats, freeSeats,
      cpus, takenCores, freeCores: online && inRay ? Math.max(0, (cpus ?? 0) - takenCores) : 0,
      workloads: active.filter((w) => w.ip === n.tailscale_ip),
    });
  }
  // Online PCs with GPUs first, then CPU-only, then offline; alphabetical within each group.
  const group = (m: MachineSeats) => (!m.online ? 2 : m.hasGpu ? 0 : 1);
  machines.sort((a, b) => group(a) - group(b) || a.hostname.localeCompare(b.hostname));

  const totalGpu = ray?.cluster_resources?.GPU ?? 0;
  const freeGpu = ray?.available_resources?.GPU ?? 0;
  return {
    machines,
    rayConnected,
    totalSeats: Math.round(totalGpu * SEATS_PER_GPU),
    freeSeats: Math.floor((freeGpu + 1e-9) * SEATS_PER_GPU),
    unplacedGpu: rayConnected ? Math.max(0, +(totalGpu - freeGpu - placed).toFixed(2)) : 0,
  };
}

/** Ray rule: a share above one GPU must be a whole number of GPUs. */
export function seatSelectionProblem(seats: number, machine: MachineSeats | null, cores = 0): string | null {
  if (!machine) return null;
  if (cores > machine.freeCores) return `Only ${machine.freeCores} core${machine.freeCores === 1 ? " is" : "s are"} free on ${machine.hostname}.`;
  if (seats === 0) return null;
  if (seats > machine.freeSeats) return `Only ${machine.freeSeats} seat${machine.freeSeats === 1 ? " is" : "s are"} free on ${machine.hostname}.`;
  if (seats > SEATS_PER_GPU && seats % SEATS_PER_GPU !== 0)
    return "Above one GPU, pick whole GPUs (4, 8 … seats): Ray cannot split a share across GPUs.";
  return null;
}

export const fmtShare = (gpus: number) => `${+gpus.toFixed(2)} GPU`;
