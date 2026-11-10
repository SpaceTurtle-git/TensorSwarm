"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { clockTime } from "../lib/format";

export interface Point {
  t: number;              // epoch ms
  v: number | null;       // null = no reading (gap)
}

interface Props {
  title: string;
  points: Point[];
  windowMs: number;
  yMax: number;
  yMin?: number;
  format: (v: number) => string;
  height?: number;
  /** Optional horizontal reference line, e.g. the power limit. */
  reference?: { value: number; label: string };
}

const GAP_MS = 16000; // > 3 missed heartbeats: draw a break instead of a line across the gap

/**
 * Single-series time chart: 2px line over a faint area, recessive grid, crosshair + tooltip
 * on hover. One series per chart, so the title names it and no legend is needed.
 */
export default function TimeChart({ title, points, windowMs, yMax, yMin = 0, format, height = 112, reference }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(160, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padL = 36, padR = 8, padT = 8, padB = 18;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const now = points.length ? Math.max(points[points.length - 1].t, Date.now() - 2000) : Date.now();
  const t0 = now - windowMs;
  const top = Math.max(yMax, yMin + 1e-9);

  const x = (t: number) => padL + ((t - t0) / windowMs) * innerW;
  const y = (v: number) => padT + innerH - ((Math.min(Math.max(v, yMin), top) - yMin) / (top - yMin)) * innerH;

  const visible = useMemo(() => points.filter((p) => p.t >= t0 - 5000), [points, t0]);

  // Split into continuous runs (breaks at gaps and nulls).
  const runs = useMemo(() => {
    const out: Point[][] = [];
    let cur: Point[] = [];
    let prevT = -Infinity;
    for (const p of visible) {
      if (p.v === null || p.t - prevT > GAP_MS) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      if (p.v !== null) cur.push(p);
      prevT = p.t;
    }
    if (cur.length) out.push(cur);
    return out;
  }, [visible]);

  const latest = [...visible].reverse().find((p) => p.v !== null);
  const hovered = hover !== null ? visible[hover] : null;

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    if (!visible.length) return;
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - rect.left + padL;
    let best = 0, bestD = Infinity;
    visible.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  }

  const gridValues = [yMin, yMin + (top - yMin) / 2, top];

  return (
    <div className="viz-card rounded-lg border border-slate-800 bg-slate-950/50 p-3" role="group" aria-label={title}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</h4>
        <span className="font-mono text-sm text-slate-100">{latest ? format(latest.v as number) : "—"}</span>
      </div>
      <div ref={wrap} className="relative mt-1">
        <svg width={width} height={height} className="block" role="img" aria-label={`${title} over the last ${Math.round(windowMs / 60000)} minutes`}>
          {gridValues.map((g, i) => (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y(g)} y2={y(g)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={padL - 6} y={y(g) + 3} textAnchor="end" className="fill-slate-500" fontSize={9}>
                {format(g)}
              </text>
            </g>
          ))}
          {reference && reference.value > yMin && reference.value <= top && (
            <g>
              <line x1={padL} x2={width - padR} y1={y(reference.value)} y2={y(reference.value)}
                stroke="var(--viz-axis)" strokeDasharray="3 3" strokeWidth={1} />
              <text x={width - padR} y={y(reference.value) - 3} textAnchor="end" fontSize={9} className="fill-slate-400">
                {reference.label}
              </text>
            </g>
          )}
          {runs.map((run, i) => {
            const line = run.map((p, j) => `${j ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v as number).toFixed(1)}`).join("");
            const area = `${line}L${x(run[run.length - 1].t).toFixed(1)},${y(yMin)}L${x(run[0].t).toFixed(1)},${y(yMin)}Z`;
            return (
              <g key={i}>
                <path d={area} fill="var(--viz-series)" opacity={0.12} />
                <path d={line} fill="none" stroke="var(--viz-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          <text x={padL} y={height - 4} fontSize={9} className="fill-slate-500">
            −{Math.round(windowMs / 60000)} min
          </text>
          <text x={width - padR} y={height - 4} fontSize={9} textAnchor="end" className="fill-slate-500">
            now
          </text>
          {hovered && hovered.v !== null && (
            <g pointerEvents="none">
              <line x1={x(hovered.t)} x2={x(hovered.t)} y1={padT} y2={padT + innerH} stroke="var(--viz-axis)" strokeWidth={1} />
              <circle cx={x(hovered.t)} cy={y(hovered.v)} r={4} fill="var(--viz-series)" stroke="var(--viz-surface)" strokeWidth={2} />
            </g>
          )}
          {/* Hit target covers the whole plot, larger than the marks. */}
          <rect x={padL} y={0} width={innerW} height={height} fill="transparent"
            onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {hovered && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md border border-slate-700 bg-slate-900/95 px-2 py-1 text-[11px] shadow-lg"
            style={{ left: Math.min(Math.max(x(hovered.t) - 50, 0), width - 110) }}
          >
            <div className="font-mono text-slate-100">{hovered.v === null ? "no data" : format(hovered.v)}</div>
            <div className="text-slate-400">{clockTime(hovered.t)}</div>
          </div>
        )}
        {!visible.length && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">
            collecting samples…
          </div>
        )}
      </div>
    </div>
  );
}
