"use client";

import React, { useEffect, useRef, useState } from "react";
import type { CellOutput } from "../../lib/types";
import { terminalText } from "../../lib/notebook";

/** Sandboxed HTML output (pandas tables, etc.): no scripts run, height follows the content. */
function HtmlOutput({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:6px;font:12px ui-sans-serif,system-ui;color:#e2e8f0;background:#0b1220}
    table{border-collapse:collapse}th,td{border:1px solid #334155;padding:3px 8px;text-align:right}
    th{background:#111827}tr:nth-child(even) td{background:#0f172a}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      ref={ref}
      title="HTML output"
      sandbox="allow-same-origin"
      srcDoc={doc}
      className="w-full rounded border border-slate-800"
      style={{ height }}
      onLoad={() => {
        const h = ref.current?.contentDocument?.documentElement?.scrollHeight;
        if (h) setHeight(Math.min(h + 4, 600));
      }}
    />
  );
}

function MimeBundle({ data }: { data: Record<string, string> }) {
  if (data["image/png"]) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`data:image/png;base64,${data["image/png"]}`} alt="cell output" className="max-w-full rounded bg-white/5" />;
  }
  if (data["text/html"]) return <HtmlOutput html={data["text/html"]} />;
  return <pre className="whitespace-pre-wrap break-words text-slate-200">{data["text/plain"] ?? ""}</pre>;
}

export default function CellOutputs({ outputs, running, execCount }: { outputs: CellOutput[]; running: boolean; execCount?: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the output like a terminal while the cell runs, unless the user scrolled up.
  useEffect(() => {
    const el = box.current;
    if (el && running && stick.current) el.scrollTop = el.scrollHeight;
  });

  if (!outputs.length) return null;
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="thin-scroll max-h-[520px] space-y-2 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed"
    >
      {outputs.map((o, i) => {
        switch (o.output_type) {
          case "stream":
            return (
              <pre key={i} className={`whitespace-pre-wrap break-words ${o.name === "stderr" ? "text-amber-200/90" : "text-slate-200"}`}>
                {terminalText(o.text)}
              </pre>
            );
          case "error":
            return (
              <div key={i} className="rounded-md border border-rose-900/70 bg-rose-950/40 p-2">
                <div className="mb-1 font-semibold text-rose-300">
                  {o.ename}: <span className="font-normal">{o.evalue}</span>
                </div>
                <pre className="whitespace-pre-wrap break-words text-[11.5px] text-rose-200/80">{terminalText(o.traceback)}</pre>
              </div>
            );
          case "execute_result":
            return (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 select-none text-rose-300/70">Out[{o.execution_count ?? execCount ?? " "}]:</span>
                <div className="min-w-0 flex-1"><MimeBundle data={o.data} /></div>
              </div>
            );
          default:
            return <div key={i}><MimeBundle data={o.data} /></div>;
        }
      })}
    </div>
  );
}
