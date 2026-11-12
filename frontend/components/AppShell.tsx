"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { useEffect, useState } from "react";
import { useCluster } from "../lib/cluster";
import { useRuntime } from "../lib/runtime";
import { IconCluster, IconClose, IconDatasets, IconJobs, IconMenu, IconNotebook } from "./icons";

const LINKS = [
  { href: "/", label: "Cluster", Icon: IconCluster },
  { href: "/notebook", label: "Notebook", Icon: IconNotebook },
  { href: "/jobs", label: "Jobs & Samples", Icon: IconJobs },
  { href: "/datasets", label: "Datasets", Icon: IconDatasets },
];

const ITEM_H = 40;   // nav item height in px (indicator travels by this)
const ITEM_GAP = 2;

function isActive(path: string | null, href: string) {
  if (!path) return false;
  return href === "/" ? path === "/" : path.startsWith(href);
}

function Logo() {
  return (
    <Link href="/" className="group flex items-center gap-2.5 rounded-lg px-2 py-1">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
        <rect x="2" y="2" width="28" height="28" rx="8" className="fill-elevated stroke-line" strokeWidth="1" />
        <rect x="8" y="8" width="7" height="7" rx="2" className="fill-seat-taken" />
        <rect x="17" y="8" width="7" height="7" rx="2" className="fill-seat-taken" />
        <rect x="8" y="17" width="7" height="7" rx="2" fill="none" className="stroke-seat-free" strokeWidth="1.6" />
        <rect x="17" y="17" width="7" height="7" rx="2" className="fill-accent" />
      </svg>
      <span className="text-[16px] font-semibold tracking-[-0.02em] text-fg">TensorSwarm</span>
    </Link>
  );
}

function ConnectionStatus() {
  const { error, loading, summary } = useCluster();
  const state = error ? "down" : loading ? "wait" : "up";
  const text = state === "down" ? "Master unreachable" : state === "wait" ? "Connecting…" : "Master connected";
  return (
    <div className="flex items-center gap-2.5" role="status" aria-live="polite">
      <span className="relative flex h-2.5 w-2.5">
        {state === "up" && <span className="absolute inline-flex h-full w-full animate-status-ping rounded-full bg-ok" />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${state === "down" ? "bg-danger" : state === "wait" ? "bg-muted" : "bg-ok"}`} />
      </span>
      <span className={`text-[13px] font-medium ${state === "down" ? "text-danger-fg" : "text-fg"}`}>{text}</span>
      {summary && state === "up" && (
        <span className="ml-auto text-[12px] text-muted tabular">{summary.active_nodes}/{summary.total_nodes} PCs</span>
      )}
    </div>
  );
}

/** Which Master API this dashboard talks to (empty = the server that served the page). */
function MasterCard() {
  const { masterUrl, setMasterUrl, base, summary } = useCluster();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [host, setHost] = useState("this server");
  useEffect(() => {
    if (!base) setHost(window.location.host || "this server");
  }, [base]);

  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3">
      <ConnectionStatus />
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-muted">Master node</div>
          <div className="truncate font-mono text-[12.5px] text-fg" title={base || host}>{base ? base.replace(/^https?:\/\//, "") : host}</div>
        </div>
        <button type="button" onClick={() => { setDraft(masterUrl); setOpen((o) => !o); }} aria-expanded={open}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg">
          Change
        </button>
      </div>
      {summary && (
        <div className="mt-2 text-[12px] text-muted tabular">
          {summary.total_gpus} GPU{summary.total_gpus === 1 ? "" : "s"} · {summary.active_kernels ?? 0} runtime{summary.active_kernels === 1 ? "" : "s"}
        </div>
      )}
      {open && (
        <form className="mt-3 animate-slide-in space-y-2" onSubmit={(e) => { e.preventDefault(); setMasterUrl(draft); setOpen(false); }}>
          <label className="block text-[12px] font-medium text-muted" htmlFor="master-url">Master API URL</label>
          <input id="master-url" value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="http://100.x.y.z:8000"
            className="w-full rounded-lg border border-line bg-elevated px-2.5 py-1.5 font-mono text-[12px] text-fg placeholder:text-muted/80 focus:border-accent focus:outline-none" />
          <p className="text-[11.5px] leading-relaxed text-muted">Empty = this server. Use another Master&apos;s Tailscale address to watch a different swarm.</p>
          <div className="flex justify-end gap-1.5">
            <button type="button" className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-fg" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover">Save</button>
          </div>
        </form>
      )}
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const activeIndex = LINKS.findIndex((l) => isActive(path, l.href));
  const runtime = useRuntime();
  const rtLabel = runtime.kernelId && runtime.spec ? (runtime.spec.gpus > 0 ? "GPU" : "CPU") : null;
  return (
    <nav aria-label="Main" className="relative">
      {activeIndex >= 0 && (
        <span aria-hidden="true"
          className="absolute left-0 right-0 top-0 rounded-[10px] border border-line bg-accent-soft transition-transform duration-200 ease-out-expo"
          style={{ height: ITEM_H, transform: `translateY(${activeIndex * (ITEM_H + ITEM_GAP)}px)` }}>
          <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />
        </span>
      )}
      <ul className="relative flex flex-col" style={{ gap: ITEM_GAP }}>
        {LINKS.map(({ href, label, Icon }) => {
          const active = isActive(path, href);
          return (
            <li key={href}>
              <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-[10px] px-3 text-[14px] transition-colors duration-200 ${active ? "font-semibold text-fg" : "font-medium text-muted hover:bg-fg/[0.04] hover:text-fg"}`}
                style={{ height: ITEM_H }}>
                <Icon size={18} className={active ? "text-accent" : ""} />
                {label}
                {href === "/notebook" && rtLabel && (
                  <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-fg/85"
                    title={runtime.ready ? `Your runtime on ${runtime.spec?.hostname} is ready` : `Your runtime on ${runtime.spec?.hostname} is starting`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${runtime.ready ? "bg-ok" : "bg-accent"}`} aria-hidden="true" />
                    {rtLabel}<span className="sr-only">{runtime.ready ? " runtime ready" : " runtime starting"}</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-7 px-3 py-5">
      <Logo />
      <NavList onNavigate={onNavigate} />
      <div className="mt-auto">
        <MasterCard />
      </div>
    </div>
  );
}

/** API error banner: slides in, explains the problem and how to check it. */
function ErrorBanner() {
  const { error, base } = useCluster();
  if (!error) return null;
  return (
    <div role="alert" className="mx-4 mt-4 animate-slide-in rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-[13px] text-danger-fg md:mx-6">
      {error}{" "}
      <a href={base ? `${base}/healthz` : "/api/healthz"} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">Test Master API</a>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const path = usePathname();
  useEffect(() => setDrawer(false), [path]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 border-r border-line glass-border glass-sidebar lg:block">
        <SidebarBody />
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 h-full w-full animate-fade-in bg-canvas/70 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Navigation" className="absolute inset-y-0 left-0 w-[272px] animate-drawer-in-left border-r border-line glass-border glass-sidebar pop-shadow">
            <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu"
              className="absolute right-3 top-4 inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-fg/[0.06] hover:text-fg">
              <IconClose size={18} />
            </button>
            <SidebarBody onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line glass-border glass px-3 lg:hidden">
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg hover:bg-fg/[0.06]">
            <IconMenu size={20} />
          </button>
          <Logo />
        </header>
        <ErrorBanner />
        {children}
      </div>
    </div>
  );
}
