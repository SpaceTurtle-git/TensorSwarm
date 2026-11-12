"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";
import { api, postJson } from "../lib/api";
import { computeTargets, CORE_CHOICES, defaultCores, useCluster, useSamples, type ComputeTarget } from "../lib/cluster";
import { fmtDuration, fmtMB, timeAgo } from "../lib/format";
import type { JobResult, Sample } from "../lib/types";
import PageHeader from "./PageHeader";
import { Button, Card, StatusPill } from "./ui";

const CodeEditor = dynamic(() => import("./CodeEditor"), { ssr: false, loading: () => <div className="h-40 animate-pulse rounded bg-surface" /> });

const ALL = "__all__";
const CATEGORY_ORDER = ["Notebook", "Diagnostics", "Benchmarks", "Stress", "Training"];

interface Batch { id: string; title: string; jobIds: string[]; createdAt: number }

/** PCs a job with this GPU share can run on: GPU PCs for GPU work, every PC for CPU work. */
function eligibleTargets(targets: ComputeTarget[], share: number) {
  return share > 0 ? targets.filter((t) => t.hasGpu) : targets;
}

function TargetSelect({ value, onChange, share, allowAll = true }: { value: string; onChange: (v: string) => void; share: number; allowAll?: boolean }) {
  const { nodes, ray } = useCluster();
  const all = computeTargets(nodes, ray);
  const targets = eligibleTargets(all, share);
  const noun = share > 0 ? "GPU PC" : "PC";
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Target"
      className="max-w-[22rem] rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-fg">
      <option value="">{share > 0 ? "Any free GPU" : "Any PC with free cores"}</option>
      {allowAll && targets.length > 1 && <option value={ALL}>Every {noun} ({targets.length}) — compare</option>}
      {targets.map((t) => <option key={t.ip} value={t.ip}>{t.label} ({t.ip})</option>)}
      {share > 0 && all.length > targets.length && <option disabled>— CPU-only PCs: choose “CPU only” —</option>}
    </select>
  );
}

function ShareSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="GPU share"
      className="rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-fg">
      <option value={1}>1 GPU</option>
      <option value={0.5}>0.5 GPU</option>
      <option value={0.25}>0.25 GPU</option>
      <option value={0}>CPU only</option>
    </select>
  );
}

function CoresSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="CPU cores"
      title="CPU cores reserved for the job (PyTorch/NumPy threads)"
      className="rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-xs text-fg">
      {CORE_CHOICES.map((c) => <option key={c} value={c}>{c} core{c > 1 ? "s" : ""}</option>)}
    </select>
  );
}

export default function JobsApp() {
  const { base, nodes, ray } = useCluster();
  const params = useSearchParams();
  const { samples, error: samplesError } = useSamples();
  const [jobs, setJobs] = useState<JobResult[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<string | null>(params.get("job"));
  const [target, setTarget] = useState("");
  const [share, setShareState] = useState(1);
  const [cores, setCores] = useState(defaultCores(1));
  const setShare = (v: number) => {
    if ((v === 0) !== (share === 0)) setCores(defaultCores(v));   // GPU <-> CPU work: re-default the cores
    setShareState(v);
    const t = computeTargets(nodes, ray).find((x) => x.ip === target);
    if (v > 0 && t && !t.hasGpu) setTarget("");                    // a CPU-only PC can't take GPU work
  };
  const [script, setScript] = useState(
    'import socket, torch\ndevice = torch.cuda.get_device_name(0) if torch.cuda.is_available() and torch.cuda.device_count() else f"CPU, {torch.get_num_threads()} threads"\nprint(socket.gethostname(), device)\nresult = f"hello from {socket.gethostname()} ({device})"');
  const [message, setMessage] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");

  useEffect(() => {
    let alive = true;
    const load = () => api<JobResult[]>(base, "/api/v1/jobs?limit=100").then((j) => alive && setJobs(j)).catch(() => undefined);
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [base]);

  const jobById = useMemo(() => Object.fromEntries(jobs.map((j) => [j.job_id, j])), [jobs]);

  async function submit(code: string, title: string, tgt: string, gpus: number) {
    setMessage(null);
    const ips = tgt === ALL ? eligibleTargets(computeTargets(nodes, ray), gpus).map((t) => t.ip) : [tgt];
    try {
      const submitted = await Promise.all(ips.map((ip) =>
        postJson<JobResult>(base, "/api/v1/jobs/submit", { script_code: code, target_node_ip: ip || null, num_gpus: gpus, num_cpus: cores, job_name: title })
      ));
      setJobs((j) => [...submitted, ...j]);
      if (tgt === ALL) {
        setBatches((b) => [{ id: `b${Date.now()}`, title, jobIds: submitted.map((s) => s.job_id), createdAt: Date.now() }, ...b].slice(0, 5));
      } else {
        setOpen(submitted[0].job_id);
      }
    } catch (e) {
      setMessage(`Submission failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const categories = ["All", ...CATEGORY_ORDER.filter((c) => samples.some((s) => s.category === c))];
  const shown = samples.filter((s) => category === "All" || s.category === category);

  return (
    <main className="min-w-0 flex-1 space-y-6 px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        title="Jobs & samples"
        subtitle={<>A job runs a whole script once on a worker and returns its output. For interactive work use the{" "}
          <Link href="/notebook" className="font-medium text-fg underline decoration-accent underline-offset-2">notebook</Link>.</>}
      />

      {message && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger-fg">{message}</div>}

      {/* ---------------------------------------------------------------- comparison batches */}
      {batches.map((b) => (
        <Card key={b.id} className="p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-fg">Fleet comparison: {b.title}</h2>
            <button onClick={() => setBatches((x) => x.filter((y) => y.id !== b.id))} className="text-xs text-muted hover:text-fg">Dismiss</button>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="py-1.5 pr-3 font-medium">Node</th><th className="py-1.5 pr-3 font-medium">GPU</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th><th className="py-1.5 pr-3 font-medium">Time</th>
                  <th className="py-1.5 pr-3 font-medium">Peak VRAM</th><th className="py-1.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {b.jobIds.map((id) => {
                  const j = jobById[id];
                  return (
                    <tr key={id} className="cursor-pointer border-b border-line/50 hover:bg-elevated/30" onClick={() => setOpen(id)}>
                      <td className="py-1.5 pr-3 text-fg">{j?.executed_on_node ?? j?.target_node_ip ?? "…"}</td>
                      <td className="py-1.5 pr-3 text-fg/85">{j?.gpu_used ?? "—"}</td>
                      <td className="py-1.5 pr-3"><StatusPill status={j?.status ?? "PENDING"} /></td>
                      <td className="py-1.5 pr-3 font-mono text-fg/85">{fmtDuration(j?.execution_time_sec)}</td>
                      <td className="py-1.5 pr-3 font-mono text-fg/85">{j?.vram_peak_mb ? fmtMB(j.vram_peak_mb) : "—"}</td>
                      <td className="py-1.5 font-mono text-fg">{j?.status === "FAILED" ? <span className="text-danger-fg">{(j.error ?? "").split("\n").filter(Boolean).pop()}</span> : j?.result ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {/* ---------------------------------------------------------------- samples */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-fg">Sample scripts for testing worker nodes</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-muted">Run on</span>
            <TargetSelect value={target} onChange={setTarget} share={share} />
            <ShareSelect value={share} onChange={setShare} />
            <CoresSelect value={cores} onChange={setCores} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button key={c} onClick={() => setCategory(c)} aria-pressed={category === c}
              className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-medium transition-colors duration-150 ${category === c ? "border-accent bg-accent text-accent-fg" : "border-line bg-elevated/70 text-muted hover:border-line-strong hover:text-fg"}`}>
              {c}
            </button>
          ))}
        </div>
        {samplesError && <p className="text-xs text-danger-fg">Could not load samples: {samplesError}</p>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((s: Sample) => (
            <Card key={s.id} className="flex flex-col p-5 transition-[border-color] duration-150 hover:border-line-strong">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[15.5px] font-semibold leading-snug text-fg">{s.title}</h3>
                <span className="shrink-0 rounded-full border border-line bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted">{s.category}</span>
              </div>
              <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted">{s.description}</p>
              <div className="mt-3 text-[12px] text-muted tabular">{s.runtime}{s.gpu === "required" ? " · needs a GPU" : ""}</div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/70 pt-3">
                <Link href={`/notebook?sample=${encodeURIComponent(s.id)}`} className="inline-flex min-h-[34px] items-center rounded-lg border border-line bg-elevated px-3 py-1.5 text-[13px] font-medium text-fg transition-colors duration-150 hover:border-line-strong">
                  Open in notebook
                </Link>
                {s.mode === "notebook" ? (
                  <span className="text-[12px] text-muted">notebook only (uses ! shell lines)</span>
                ) : (
                  <Button variant="primary" onClick={() => submit(s.code, s.title, target, share)}
                    title={s.gpu === "required" && share === 0 ? "This sample needs a GPU: choose a GPU share" : undefined}>
                    {target === ALL ? (share > 0 ? "Run on every GPU" : "Run on every PC") : "Run as job"}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- custom script */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold text-fg">Batch script</h2>
            <p className="mt-0.5 text-[12.5px] text-muted">Runs top to bottom on one worker. Set a variable named <code>result</code> to return a value.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TargetSelect value={target} onChange={setTarget} share={share} />
            <ShareSelect value={share} onChange={setShare} />
            <CoresSelect value={cores} onChange={setCores} />
            <Button variant="primary" onClick={() => submit(script, "batch_script", target, share)}>Run (Ctrl+Enter)</Button>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-line bg-elevated">
          <CodeEditor value={script} onChange={setScript} minHeight="160px" onRun={() => submit(script, "batch_script", target, share)} />
        </div>
      </Card>

      {/* ---------------------------------------------------------------- history */}
      <Card className="p-5">
        <h2 className="text-[17px] font-semibold text-fg">Job history</h2>
        {jobs.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">No jobs yet (the Master keeps them in memory until it restarts).</p>
        ) : (
          <div className="mt-2 divide-y divide-line/70">
            {jobs.map((j) => (
              <div key={j.job_id}>
                <button onClick={() => setOpen(open === j.job_id ? null : j.job_id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-2 py-2.5 text-left text-[12.5px] transition-colors duration-150 hover:bg-elevated/60">
                  <StatusPill status={j.status} />
                  <span className="font-medium text-fg">{j.job_name}</span>
                  <span className="font-mono text-muted">{j.job_id}</span>
                  <span className="text-muted">{j.executed_on_node ?? j.target_node_ip ?? ((j.num_gpus ?? 1) > 0 ? "any GPU" : "any PC")}</span>
                  {j.gpu_used && <span className="text-muted">{j.gpu_used}</span>}
                  <span className="ml-auto text-muted">{fmtDuration(j.execution_time_sec)} · {timeAgo(j.submitted_at)}</span>
                </button>
                {open === j.job_id && (
                  <div className="mb-3 space-y-2 rounded-lg border border-line bg-canvas/70 p-3 font-mono text-[12px]">
                    <div className="flex flex-wrap gap-x-4 text-[11px] text-muted">
                      <span>{(j.num_gpus ?? 1) > 0 ? `GPU share ${j.num_gpus ?? 1}` : "CPU only"} · {j.num_cpus ?? 1} core(s)</span>
                      {j.vram_peak_mb ? <span>peak VRAM {fmtMB(j.vram_peak_mb)}</span> : null}
                      {j.executed_on_ip && <span>{j.executed_on_ip}</span>}
                      {(j.status === "PENDING" || j.status === "RUNNING") && <span className="text-warn-fg">waiting for output… (a job reports when it finishes; it may be waiting for a free GPU share or CPU cores)</span>}
                    </div>
                    {j.stdout && <pre className="thin-scroll max-h-96 overflow-auto whitespace-pre-wrap text-fg">{j.stdout}</pre>}
                    {j.stderr && <pre className="thin-scroll max-h-48 overflow-auto whitespace-pre-wrap text-warn-fg">{j.stderr}</pre>}
                    {j.result && <div className="text-fg">result: {j.result}</div>}
                    {j.error && <pre className="whitespace-pre-wrap text-danger-fg">{j.error}</pre>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}
