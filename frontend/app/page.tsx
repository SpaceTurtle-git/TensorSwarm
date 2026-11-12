"use client";

import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useState } from "react";
import AllocationPanel from "../components/cluster/AllocationPanel";
import MachinePanel from "../components/cluster/MachinePanel";
import OverviewCards from "../components/cluster/OverviewCards";
import SeatMap from "../components/cluster/SeatMap";
import Workloads from "../components/cluster/Workloads";
import { IconRefresh } from "../components/icons";
import PageHeader from "../components/PageHeader";
import { Button } from "../components/ui";
import { useCluster } from "../lib/cluster";
import { clockTime } from "../lib/format";
import { useRuntime, type RuntimeSpec } from "../lib/runtime";
import { useSeatMap, useSeatSelection } from "../lib/seatPicker";

export default function ClusterPage() {
  const router = useRouter();
  const { summary, loading, lastUpdated, refresh } = useCluster();
  const runtime = useRuntime();
  const { seatMap, workloads, refreshWork } = useSeatMap();
  const sel = useSeatSelection(seatMap.machines);
  const [drawer, setDrawer] = useState(false);

  const openDetails = useCallback((ip: string) => {
    sel.selectMachine(ip);
    setDrawer(true);
  }, [sel]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // Nothing is allocated here: the Notebook page starts the runtime, so it is always attached.
  const openNotebook = useCallback((spec: RuntimeSpec) => {
    runtime.request(spec);
    router.push("/notebook");
  }, [runtime, router]);

  const refreshAll = useCallback(() => {
    refresh();
    refreshWork();
  }, [refresh, refreshWork]);

  return (
    <div className="flex min-w-0 flex-1">
      <main className="min-w-0 flex-1 space-y-6 px-4 py-6 md:px-8 md:py-8">
        <PageHeader
          title="Cluster overview"
          subtitle="Every PC in the swarm, its free GPU seats and CPU cores, and what is running. Pick seats or cores to open a notebook on that PC."
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

        <SeatMap data={seatMap} selectedIp={sel.selectedIp} selectedSeats={sel.seats} selectedCores={sel.cores} loading={loading}
          onSelectMachine={sel.selectMachine} onToggleSeat={sel.toggleSeat} onPickCores={sel.pickCores} onDetails={openDetails} />

        <AllocationPanel sel={sel} runtime={runtime} action="open" onGo={openNotebook} onOpenCurrent={() => router.push("/notebook")} />

        <Workloads items={workloads} />
      </main>

      {/* Right machine panel: sticky on wide screens… */}
      <aside aria-label="Machine details" className="thin-scroll sticky top-0 hidden h-screen w-[340px] shrink-0 overflow-y-auto border-l border-line glass-border glass xl:block">
        <MachinePanel machine={sel.machine} />
      </aside>

      {/* …a drawer below 1280 px. */}
      {drawer && (
        <div className="fixed inset-0 z-50 xl:hidden">
          <button type="button" aria-label="Close machine details" className="absolute inset-0 h-full w-full animate-fade-in bg-canvas/70 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Machine details"
            className="thin-scroll absolute inset-y-0 right-0 w-[min(360px,92vw)] animate-drawer-in overflow-y-auto border-l border-line glass-border glass-elevated pop-shadow">
            <MachinePanel machine={sel.machine} onClose={() => setDrawer(false)} />
          </aside>
        </div>
      )}
    </div>
  );
}
