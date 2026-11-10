"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { useState } from "react";
import { useCluster } from "../lib/cluster";

const LINKS = [
  { href: "/", label: "Cluster" },
  { href: "/notebook", label: "Notebook" },
  { href: "/jobs", label: "Jobs & Samples" },
  { href: "/datasets", label: "Datasets" },
];

export default function NavBar() {
  const path = usePathname();
  const { masterUrl, setMasterUrl, error, summary, base } = useCluster();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-2.5 md:px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {!error && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${error ? "bg-rose-500" : "bg-emerald-500"}`} />
          </span>
          <span className="bg-gradient-to-r from-emerald-300 to-cyan-300 bg-clip-text text-base font-semibold tracking-tight text-transparent">
            TensorSwarm
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path?.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${active ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
          {summary && (
            <span className="hidden md:inline">
              {summary.active_nodes} node{summary.active_nodes === 1 ? "" : "s"} · {summary.total_gpus} GPU{summary.total_gpus === 1 ? "" : "s"}
              {summary.active_kernels ? ` · ${summary.active_kernels} runtime${summary.active_kernels === 1 ? "" : "s"}` : ""}
            </span>
          )}
          <div className="relative">
            <button
              onClick={() => { setDraft(masterUrl); setOpen((o) => !o); }}
              className="rounded-md border border-slate-800 px-2.5 py-1 font-mono text-[11px] text-slate-300 hover:border-slate-600"
              title="Change which Master API this dashboard talks to"
            >
              {base || "this server"}
            </button>
            {open && (
              <div className="absolute right-0 mt-2 w-80 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
                <label className="text-[11px] text-slate-400" htmlFor="master-url">Master API URL</label>
                <input id="master-url" value={draft} onChange={(e) => setDraft(e.target.value)}
                  placeholder="http://100.x.y.z:8000 (empty = this server)"
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Empty uses this app&apos;s /api proxy, which forwards to <code>MASTER_API_URL</code> (default http://127.0.0.1:8000).
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button className="rounded px-2 py-1 text-xs text-slate-400 hover:text-white" onClick={() => setOpen(false)}>Cancel</button>
                  <button className="rounded bg-emerald-500 px-2.5 py-1 text-xs font-medium text-slate-950" onClick={() => { setMasterUrl(draft); setOpen(false); }}>Save</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {error && (
        <div className="border-t border-rose-900/60 bg-rose-950/50 px-4 py-1.5 text-center text-xs text-rose-300">
          {error}{" "}
          <a href={base ? `${base}/healthz` : "/api/healthz"} target="_blank" rel="noreferrer" className="underline opacity-80">Test Master API</a>
        </div>
      )}
    </header>
  );
}
