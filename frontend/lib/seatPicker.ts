"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useCluster, useWorkloads } from "./cluster";
import { useRuntime, type RuntimeSpec } from "./runtime";
import { buildSeatMap, SEAT_GPU, seatSelectionProblem, toWorkloads, type MachineSeats } from "./seats";

/** The live seat map (GPU seats and CPU cores per PC), with this browser's runtime marked "You". */
export function useSeatMap() {
  const { nodes, ray } = useCluster();
  const work = useWorkloads();
  const { kernelId } = useRuntime();
  const workloads = useMemo(
    () => toWorkloads(work.kernels, work.jobs, nodes, new Set(kernelId ? [kernelId] : [])),
    [work.kernels, work.jobs, nodes, kernelId]
  );
  const seatMap = useMemo(() => buildSeatMap(nodes, ray, workloads), [nodes, ray, workloads]);
  return { seatMap, workloads, refreshWork: work.refresh };
}

/**
 * Picking hardware, shared by the Cluster page and the Notebook's Connect dialog so both behave
 * the same: GPU seats and CPU cores on ONE PC. Cores alone = a CPU-only runtime; GPU seats get
 * 1 core by default (enough threads for GPU work) until the user picks cores themselves.
 */
export function useSeatSelection(machines: MachineSeats[], initialIp?: string | null) {
  const [selectedIp, setSelectedIp] = useState<string | null>(initialIp ?? null);
  const [seats, setSeats] = useState<number[]>([]);
  const [cores, setCores] = useState(0);
  const [coresTouched, setCoresTouched] = useState(false);

  // Default PC: the given one, else the first online PC with free seats, else any with free cores.
  useEffect(() => {
    if (selectedIp && machines.some((m) => m.ip === selectedIp)) return;
    const first = machines.find((m) => m.online && m.freeSeats > 0) ?? machines.find((m) => m.online && m.freeCores > 0) ?? machines[0];
    if (first) setSelectedIp(first.ip);
  }, [machines, selectedIp]);

  const machine = machines.find((m) => m.ip === selectedIp) ?? null;

  // Seats or cores someone else just took drop out of the selection.
  useEffect(() => {
    if (!machine) return;
    setSeats((s) => {
      const ok = s.filter((i) => i >= machine.takenSeats && i < machine.totalSeats);
      return ok.length === s.length ? s : ok;
    });
    setCores((c) => Math.min(c, machine.freeCores));
  }, [machine]);

  // GPU seats come with 1 core until the user chooses cores.
  useEffect(() => {
    if (!coresTouched) setCores(seats.length > 0 ? Math.min(1, machine?.freeCores ?? 0) : 0);
  }, [seats.length, coresTouched, machine?.freeCores]);

  const resetTo = useCallback((ip: string) => {
    setSelectedIp(ip);
    setSeats([]);
    setCores(0);
    setCoresTouched(false);
  }, []);

  const selectMachine = useCallback((ip: string) => {
    if (ip !== selectedIp) resetTo(ip);
  }, [selectedIp, resetTo]);

  const toggleSeat = useCallback((ip: string, seat: number) => {
    if (ip !== selectedIp) {
      resetTo(ip);
      setSeats([seat]);
    } else {
      setSeats((s) => (s.includes(seat) ? s.filter((x) => x !== seat) : [...s, seat].sort((a, b) => a - b)));
    }
  }, [selectedIp, resetTo]);

  /** Core seats fill from the first free one: clicking core n selects n cores (again = n - 1). */
  const pickCores = useCallback((ip: string, n: number) => {
    if (ip !== selectedIp) resetTo(ip);
    setCoresTouched(true);
    setCores((c) => (ip === selectedIp && c === n ? n - 1 : n));
  }, [selectedIp, resetTo]);

  const clear = useCallback(() => {
    setSeats([]);
    setCores(0);
    setCoresTouched(false);
  }, []);

  const gpus = seats.length * SEAT_GPU;
  const problem = seatSelectionProblem(seats.length, machine, cores);
  const spec: RuntimeSpec | null =
    machine && machine.online && machine.inRay && cores > 0 && !problem
      ? { ip: machine.ip, hostname: machine.hostname, gpus, cpus: cores }
      : null;

  return { selectedIp, machine, seats, cores, gpus, problem, spec, selectMachine, toggleSeat, pickCores, clear };
}

export type SeatSelection = ReturnType<typeof useSeatSelection>;
