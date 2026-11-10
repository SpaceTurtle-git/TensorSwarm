"use client";

import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useCluster, useNodeHistory, useSamples } from "../../lib/cluster";
import { fmtMB, fmtNum, loadLevel, pct, tempLevel } from "../../lib/format";
import { copyText, datasetSnippet, fmtBytes, listDatasets } from "../../lib/datasets";
import type { Dataset, KernelRecord, KernelVariable, NodeRecord, Sample } from "../../lib/types";
import TimeChart from "../TimeChart";
import { Button, KV, LevelBadge, Meter, StatusPill } from "../ui";

type Tab = "runtime" | "variables" | "data" | "samples" | "shortcuts";

export default function SidePanel({
  kernel, kernelError, varsVersion, onInsertSample, onOpenSample, onInsertCode,
}: {
  kernel: KernelRecord | null;
  kernelError: string | null;
  varsVersion: number;
  onInsertSample: (s: Sample) => void;
  onInsertCode: (code: string) => void;
  onOpenSample: (s: Sample) => void;
}) {
  const [tab, setTab] = useState<Tab>("runtime");
  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="flex border-b border-slate-800 text-xs" role="tablist">
        {(["runtime", "variables", "data", "samples", "shortcuts"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`-mb-px flex-1 border-b-2 px-2 py-2 capitalize ${tab === t ? "border-emerald-400 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "runtime" && <RuntimeTab kernel={kernel} kernelError={kernelError} />}
        {tab === "variables" && <VariablesTab kernel={kernel} version={varsVersion} />}
        {tab === "data" && <DataTab kernel={kernel} onInsert={onInsertCode} />}
        {tab === "samples" && <SamplesTab onInsert={onInsertSample} onOpen={onOpenSample} />}
        {tab === "shortcuts" && <ShortcutsTab />}
      </div>
    </aside>
  );
}

function pickNode(nodes: NodeRecord[], kernel: KernelRecord | null): NodeRecord | undefined {
  const ip = kernel?.target_node_ip || kernel?.info?.node_ip;
  if (!ip) return undefined;
  const same = nodes.filter((n) => n.tailscale_ip === ip);
  return same.find((n) => n.gpu_count > 0) ?? same[0];
}

function RuntimeTab({ kernel, kernelError }: { kernel: KernelRecord | null; kernelError: string | null }) {
  const { nodes, base } = useCluster();
  const node = pickNode(nodes, kernel);
  const gpu = node?.gpus.find((g) => g.name === kernel?.info?.gpu_name) ?? node?.gpus[0];
  const history = useNodeHistory(node?.node_id ?? null, 5, !!node);
  const [torchMem, setTorchMem] = useState<Record<string, number>>({});

  useEffect(() => {
    if (kernel?.status !== "READY") return;
    let alive = true;
    const load = () =>
      api<Record<string, number>>(base, `/api/v1/kernels/${kernel.kernel_id}/gpu`)
        .then((m) => alive && setTorchMem(m))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [base, kernel?.kernel_id, kernel?.status]);

  const utilPoints = useMemo(() => history.map((s) => ({ t: s.t, v: s.gpus.find((g) => g.index === (gpu?.index ?? 0))?.util ?? null })), [history, gpu?.index]);

  if (!kernel) {
    return (
      <div className="space-y-4 text-xs text-slate-400">
        <div className="space-y-2">
          <p className="text-sm text-slate-200">Not connected</p>
          <p>Click <b>Connect</b> (top right) to start a Python runtime on a worker's GPU, or <b>CPU only</b> on any PC (also PCs without a GPU). Or just run a cell: it connects automatically.</p>
          <p>The runtime keeps your variables between cells, like Colab. It reserves its GPU share and CPU cores until you disconnect, and stops by itself after an hour without activity.</p>
          {kernelError && <p className="rounded border border-rose-900 bg-rose-950/40 p-2 text-rose-300">{kernelError}</p>}
        </div>
        <ActiveRuntimes currentId={null} />
      </div>
    );
  }

  const info = kernel.info;
  return (
    <div className="space-y-4">
      <ActiveRuntimes currentId={kernel.kernel_id} />
      <div className="flex items-center justify-between">
        <StatusPill status={kernel.status} />
        <span className="font-mono text-[10px] text-slate-500">{kernel.kernel_id}</span>
      </div>
      {kernel.status === "STARTING" && (
        <p className="text-xs text-slate-400">Starting Python on {kernel.target_node_ip || (kernel.num_gpus > 0 ? "a free GPU" : "a PC with free CPU cores")}… the first start on a node imports PyTorch and can take ~10-30 s.</p>
      )}
      {(kernel.status === "ERROR" || kernel.status === "DEAD") && kernel.error && (
        <p className="rounded border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-300">{kernel.error}</p>
      )}
      {info && (
        <div>
          <KV k="Worker" v={`${info.hostname} (${kernel.target_node_ip ?? info.node_ip ?? "?"})`} />
          <KV k="GPU" v={info.gpu_name ?? "none (CPU)"} mono={false} />
          <KV k="GPU share" v={kernel.num_gpus === 0 ? "CPU only" : `${kernel.num_gpus} GPU`} />
          <KV k="CPU" v={`${kernel.num_cpus ?? 1} core(s) reserved · torch uses ${info.cpu_threads ?? "?"} of ${info.cpu_count ?? "?"} threads`} mono={false} />
          <KV k="PyTorch / CUDA" v={`${info.torch_version ?? "—"} / ${info.cuda_version ?? "—"}`} />
          <KV k="Python" v={info.python_version ?? "—"} />
          <KV k="Process" v={`pid ${info.pid}`} />
        </div>
      )}
      {gpu && (
        <div className="space-y-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Live GPU ({node?.hostname})</h4>
          <Meter label="Core load" value={gpu.gpu_utilization_pct} detail={`${fmtNum(gpu.gpu_utilization_pct)}%`} />
          <Meter label="VRAM (whole GPU)" value={pct(gpu.used_vram_mb, gpu.total_vram_mb)} level={loadLevel(pct(gpu.used_vram_mb, gpu.total_vram_mb))}
            detail={`${fmtMB(gpu.used_vram_mb)} / ${fmtMB(gpu.total_vram_mb)}`} />
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>Temperature</span>
            <span className="flex items-center gap-2 font-mono">{fmtNum(gpu.temperature_c, 0, " °C")}{tempLevel(gpu.temperature_c) !== "good" && <LevelBadge level={tempLevel(gpu.temperature_c)} />}</span>
          </div>
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>Power</span>
            <span className="font-mono">{fmtNum(gpu.power_watts, 1, " W")}{gpu.power_limit_watts ? ` / ${gpu.power_limit_watts} W` : ""}</span>
          </div>
          <TimeChart title="Core load, last 5 min" points={utilPoints} windowMs={5 * 60 * 1000} yMax={100} format={(v) => `${Math.round(v)}%`} height={90} />
        </div>
      )}
      {torchMem.allocated_mb !== undefined && (
        <div>
          <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">This runtime (PyTorch)</h4>
          <KV k="Tensors allocated" v={fmtMB(torchMem.allocated_mb)} />
          <KV k="Reserved by caching allocator" v={fmtMB(torchMem.reserved_mb)} />
          <KV k="Free on device" v={`${fmtMB(torchMem.device_free_mb)} of ${fmtMB(torchMem.device_total_mb)}`} />
          <p className="mt-1 text-[10.5px] text-slate-500">Run <code>torch.cuda.empty_cache()</code> to hand reserved memory back, or restart the runtime.</p>
        </div>
      )}
    </div>
  );
}

/** Colab's "Manage sessions": other live runtimes on the cluster, each holding a GPU share. */
function ActiveRuntimes({ currentId }: { currentId: string | null }) {
  const { base } = useCluster();
  const [list, setList] = useState<KernelRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = React.useCallback(() => {
    api<KernelRecord[]>(base, "/api/v1/kernels")
      .then((all) => setList(all.filter((k) => (k.status === "READY" || k.status === "STARTING") && k.kernel_id !== currentId)))
      .catch(() => undefined);
  }, [base, currentId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  if (!list.length) return null;
  return (
    <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-2.5">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-amber-200/90">Other active runtimes ({list.length})</h4>
      <p className="mt-0.5 text-[10.5px] text-slate-400">Each holds its GPU share and CPU cores until stopped. Stop one to free them.</p>
      <div className="mt-2 space-y-1.5">
        {list.map((k) => (
          <div key={k.kernel_id} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="min-w-0 truncate text-slate-300" title={k.kernel_id}>
              {k.name || k.kernel_id} · {k.info?.hostname ?? k.target_node_ip ?? "…"} · {k.num_gpus > 0 ? `${k.num_gpus} GPU` : "CPU"} · {k.num_cpus ?? 1} core(s)
            </span>
            <button
              disabled={busy === k.kernel_id}
              onClick={async () => {
                setBusy(k.kernel_id);
                try { await api(base, `/api/v1/kernels/${k.kernel_id}`, { method: "DELETE" }); } catch { /* already gone */ }
                setBusy(null);
                load();
              }}
              className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-slate-200 hover:border-rose-500 hover:text-rose-200 disabled:opacity-40"
            >
              {busy === k.kernel_id ? "Stopping…" : "Stop"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function VariablesTab({ kernel, version }: { kernel: KernelRecord | null; version: number }) {
  const { base } = useCluster();
  const [vars, setVars] = useState<KernelVariable[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const ready = kernel?.status === "READY";

  const load = React.useCallback(() => {
    if (!ready || !kernel) return;
    api<KernelVariable[]>(base, `/api/v1/kernels/${kernel.kernel_id}/variables`)
      .then((v) => { setVars(v); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [base, kernel, ready]);

  useEffect(() => { load(); }, [load, version]);

  if (!ready) return <p className="text-xs text-slate-400">Connect a runtime to inspect its variables.</p>;
  const shown = vars.filter((v) => v.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter"
          className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500" />
        <Button onClick={load}>Refresh</Button>
      </div>
      {err && <p className="text-xs text-rose-300">{err}</p>}
      {shown.length === 0 ? (
        <p className="text-xs text-slate-500">No variables yet. Run a cell that assigns something.</p>
      ) : (
        <table className="w-full table-fixed text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="w-1/4 py-1 font-medium">Name</th>
              <th className="w-1/4 py-1 font-medium">Type</th>
              <th className="py-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.name} className="border-t border-slate-800/70 align-top">
                <td className="truncate py-1 pr-1 font-mono text-emerald-300" title={v.name}>{v.name}</td>
                <td className="truncate py-1 pr-1 text-slate-400" title={v.type}>{v.type}</td>
                <td className="break-words py-1 font-mono text-slate-300">{v.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DataTab({ kernel, onInsert }: { kernel: KernelRecord | null; onInsert: (code: string) => void }) {
  const { base, nodes } = useCluster();
  const [list, setList] = useState<Dataset[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => listDatasets(base).then((d) => alive && (setList(d), setErr(null))).catch((e) => alive && setErr(String(e?.message ?? e)));
    load();
    const id = setInterval(load, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [base]);
  const ip = kernel?.status === "READY" ? kernel.target_node_ip : null;
  const host = nodes.find((n) => n.tailscale_ip === ip)?.hostname;
  if (err) return <p className="text-xs text-rose-300">Could not load datasets: {err}</p>;
  if (!list) return <p className="text-xs text-slate-500">Loading datasets…</p>;
  const latest = list.filter((d) => d.latest);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-400">
        <code className="text-emerald-300">ts.dataset(&quot;name&quot;)</code> returns the dataset folder on the worker.
        {ip ? <> Marked <span className="text-emerald-300">ready</span> = already on {host || ip}, no copy needed.</> : " Connect a runtime to see which datasets its PC already has."}
      </p>
      {!latest.length && <p className="text-xs text-slate-500">No datasets yet. Upload one in the <a href="/datasets" className="underline">Datasets</a> tab.</p>}
      {latest.map((d) => {
        const local = ip ? d.nodes.some((n) => n.ip === ip) : false;
        const code = datasetSnippet(d);
        return (
          <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium text-slate-100">{d.name}</span>
              <span className="shrink-0 text-[10px] text-slate-500">{fmtBytes(d.total_bytes)}{ip ? (local ? " · ✓ ready" : " · will copy") : ""}</span>
            </div>
            <code className="mt-1 block truncate font-mono text-[10px] text-emerald-300" title={code}>{code}</code>
            <div className="mt-2 flex gap-1.5">
              <Button onClick={() => onInsert(code)}>Insert cell</Button>
              <Button variant="ghost" onClick={async () => { if (await copyText(code)) { setCopied(d.id); setTimeout(() => setCopied(null), 1200); } }}>
                {copied === d.id ? "✓ Copied" : "Copy"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SamplesTab({ onInsert, onOpen }: { onInsert: (s: Sample) => void; onOpen: (s: Sample) => void }) {
  const { samples, error } = useSamples();
  if (error) return <p className="text-xs text-rose-300">Could not load samples: {error}</p>;
  if (!samples.length) return <p className="text-xs text-slate-500">Loading samples…</p>;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-400">Test scripts for worker nodes. Open one as its own notebook, or insert its cells here.</p>
      {samples.map((s) => (
        <div key={s.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-slate-100">{s.title}</span>
            <span className="shrink-0 text-[10px] text-slate-500">{s.runtime}</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{s.description}</p>
          <div className="mt-2 flex gap-1.5">
            <Button onClick={() => onOpen(s)}>Open</Button>
            <Button variant="ghost" onClick={() => onInsert(s)}>Insert cells</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ShortcutsTab() {
  const rows: [string, string][] = [
    ["Shift+Enter", "Run cell, go to next (adds one at the end)"],
    ["Ctrl+Enter", "Run cell, stay"],
    ["Alt+Enter", "Run cell, insert a new cell below"],
    ["Ctrl+M  B / A", "Insert code cell below / above"],
    ["Ctrl+M  D", "Delete cell"],
    ["Ctrl+M  M / Y", "Make text cell / code cell"],
    ["Ctrl+M  I", "Interrupt execution"],
    ["Ctrl+M  .", "Restart runtime"],
    ["Ctrl+S", "Download as .ipynb"],
    ["!command", "Run a shell command on the worker (e.g. !nvidia-smi)"],
    ["display(x)", "Show images (PIL, matplotlib) and rich objects"],
  ];
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-slate-800/60">
            <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-emerald-300">{k}</td>
            <td className="py-1.5 text-slate-300">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
