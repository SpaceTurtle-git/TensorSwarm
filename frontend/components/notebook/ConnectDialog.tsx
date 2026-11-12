"use client";

import React, { useEffect } from "react";
import { useCluster } from "../../lib/cluster";
import { useRuntime, type RuntimeSpec } from "../../lib/runtime";
import { useSeatMap, useSeatSelection } from "../../lib/seatPicker";
import AllocationPanel from "../cluster/AllocationPanel";
import SeatMap from "../cluster/SeatMap";
import { IconClose } from "../icons";

/**
 * Hardware picker for the Notebook page: the Cluster page's seat map and allocation panel, so
 * a GPU notebook (GPU seats + cores) and a CPU notebook (cores only) are picked the same way.
 */
export default function ConnectDialog({ onConnect, onClose }: {
  onConnect: (spec: RuntimeSpec) => void;
  onClose: () => void;
}) {
  const { loading } = useCluster();
  const runtime = useRuntime();
  const { seatMap } = useSeatMap();
  const sel = useSeatSelection(seatMap.machines, runtime.spec?.ip);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-canvas/70 p-3 pt-10 backdrop-blur-sm md:p-6 md:pt-14" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="connect-title" onMouseDown={(e) => e.stopPropagation()}
        className="thin-scroll max-h-[88vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-line-strong glass-elevated p-5 pop-shadow md:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="connect-title" className="text-[18px] font-semibold text-fg">Connect a runtime</h2>
            <p className="mt-1 text-[13px] text-muted">
              Select GPU seats for a GPU runtime, or only CPU cores for a CPU runtime. Variables persist between cells until you restart or release it.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-fg/[0.06] hover:text-fg">
            <IconClose size={18} />
          </button>
        </div>
        <SeatMap flat data={seatMap} selectedIp={sel.selectedIp} selectedSeats={sel.seats} selectedCores={sel.cores} loading={loading}
          onSelectMachine={sel.selectMachine} onToggleSeat={sel.toggleSeat} onPickCores={sel.pickCores} />
        <div className="mt-4 border-t border-line pt-4">
          <AllocationPanel compact sel={sel} runtime={runtime} action="connect" onGo={onConnect} />
        </div>
      </div>
    </div>
  );
}
