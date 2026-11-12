"use client";

import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import AllocationPanel from "../components/cluster/AllocationPanel";
import MachinePanel from "../components/cluster/MachinePanel";
import OverviewCards from "../components/cluster/OverviewCards";
import SeatMap from "../components/cluster/SeatMap";
import Workloads from "../components/cluster/Workloads";
import { IconRefresh } from "../components/icons";
import PageHeader from "../components/PageHeader";
import { Button } from "../components/ui";
import { defaultCores, useCluster, useWorkloads } from "../lib/cluster";
import { useConnectFlow } from "../lib/connect";
import { clockTime } from "../lib/format";
import { loadNotebooks } from "../lib/notebook";
import { buildSeatMap, SEAT_GPU, toWorkloads } from "../lib/seats";

export default function ClusterPage() {
  const router = useRouter();
  const { base, nodes, summary, ray, loading, lastUpdated, refresh } = useCluster();
  const work = useWorkloads();
  const flow = useConnectFlow(base);

  const [mine, setMine] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Runtimes owned by notebooks in this browser are marked "You".
    const ids = loadNotebooks().notebooks.map((n) => n.kernelId).filter(Boolean) as string[];
    setMine(new Set(ids));
  }, [work.kernels]);

  const workloads = useMemo(() => toWorkloads(work.kernels, work.jobs, nodes, mine), [work.kernels, work.jobs, nodes, mine]);
  const seatMap = useMemo(() => buildSeatMap(nodes, ray, workloads), [nodes, ray, workloads]);

  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [seats, setSeats] = useState<number[]>([]);
  const [cores, setCores] = useState(1);
  const [drawer, setDrawer] = useState(false);
  const [coresTouched, setCoresTouched] = useState(false);

  // Default selection: the first online PC with free seats, else the first PC.
  useEffect(() => {
    if (selectedIp && seatMap.machines.some((m) => m.ip === selectedIp)) return;
    const first = seatMap.machines.find((m) => m.online && m.freeSeats > 0) ?? seatMap.machines[0];
    if (first) setSelectedIp(first.ip);
  }, [seatMap.machines, selectedIp]);

  const machine = seatMap.machines.find((m) => m.ip === selectedIp) ?? null;

  // A seat that became taken (someone else's runtime) drops out of the selection.
  useEffect(() => {
    if (!machine) return;
    setSeats((s) => {
      const ok = s.filter((i) => i >= machine.takenSeats && i < machine.totalSeats);
      return ok.length === s.length ? s : ok;
    });
  }, [machine]);

  // Cores follow the GPU/CPU default until the user picks a value.
  useEffect(() => {
    if (!coresTouched) setCores(defaultCores(seats.length * SEAT_GPU));
  }, [seats.length, coresTouched]);

  const { busy, phase, reset } = flow;
  const selectMachine = useCallback((ip: string) => {
    if (busy) return;
    if (ip !== selectedIp) {
      setSelectedIp(ip);
      setSeats([]);
      if (phase === "error" || phase === "ready") reset();
    }
  }, [busy, phase, reset, selectedIp]);

  const toggleSeat = useCallback((ip: string, seat: number) => {
    if (busy) return;
    if (phase === "error" || phase === "ready") reset();
    if (ip !== selectedIp) {
      setSelectedIp(ip);
      setSeats([seat]);
    } else {
      setSeats((s) => (s.includes(seat) ? s.filter((x) => x !== seat) : [...s, seat].sort((a, b) => a - b)));
    }
  }, [busy, phase, reset, selectedIp]);

  const openDetails = useCallback((ip: string) => {
    selectMachine(ip);
    setDrawer(true);
  }, [selectMachine]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const connect = useCallback(() => {
    if (!machine) return;
    flow.start({ ip: machine.ip, hostname: machine.hostname, gpus: seats.length * SEAT_GPU, cpus: cores });
  }, [machine, seats.length, cores, flow]);

  const openNotebook = useCallback(() => {
    const k = flow.kernel;
    const r = flow.request;
    if (!k || !r) return;
    const q = new URLSearchParams({ kernel: k.kernel_id, target: r.ip, share: String(r.gpus), cores: String(r.cpus), name: `Notebook on ${r.hostname}` });
    router.push(`/notebook?${q.toString()}`);
  }, [flow.kernel, flow.request, router]);

  const refreshAll = useCallback(() => {
    refresh();
    work.refresh();
  }, [refresh, work]);

  return (
    <div className="flex min-w-0 flex-1">
      <main className="min-w-0 flex-1 space-y-6 px-4 py-6 md:px-8 md:py-8">
        <PageHeader
          title="Cluster overview"
          subtitle="Every PC in the swarm, its free GPU seats and what is running. Pick seats to start a notebook on that GPU."
          actions={
            <>
              {lastUpdated && <span className="hidden text-[12px] text-muted md:inline tabular">Updated {clockTime(lastUpdated)}</span>}
              <Button variant="secondary" onClick={refreshAll} title="Refresh now" aria-label="Refresh cluster data">
                <IconRefresh size={15} /> <span className="hidden sm:inline">Refresh</span>
              </Button>
            </>
          }
        />

        <OverviewCards summary={summary} seats={{ free: seatMap.freeSeats, total: seatMap.totalSeats }} rayConnected={seatMap.rayConnected} />

        <SeatMap data={seatMap} selectedIp={selectedIp} selectedSeats={seats} loading={loading}
          onSelectMachine={selectMachine} onToggleSeat={toggleSeat} onDetails={openDetails} />

        <AllocationPanel
          machine={machine}
          seats={seats.length}
          cores={cores}
          setCores={(n) => { setCoresTouched(true); setCores(n); }}
          onClearSeats={() => { setSeats([]); flow.reset(); }}
          flow={flow}
          onConnect={connect}
          onOpen={openNotebook}
          onCancel={flow.cancel}
        />

        <Workloads items={workloads} />
      </main>

      {/* Right machine panel: sticky on wide screens… */}
      <aside aria-label="Machine details" className="thin-scroll sticky top-0 hidden h-screen w-[340px] shrink-0 overflow-y-auto border-l border-line bg-surface/50 xl:block">
        <MachinePanel machine={machine} />
      </aside>

      {/* …a drawer below 1280 px. */}
      {drawer && (
        <div className="fixed inset-0 z-50 xl:hidden">
          <button type="button" aria-label="Close machine details" className="absolute inset-0 h-full w-full animate-fade-in bg-canvas/70 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Machine details"
            className="thin-scroll absolute inset-y-0 right-0 w-[min(360px,92vw)] animate-drawer-in overflow-y-auto border-l border-line bg-surface pop-shadow">
            <MachinePanel machine={machine} onClose={() => setDrawer(false)} />
          </aside>
        </div>
      )}
    </div>
  );
}
