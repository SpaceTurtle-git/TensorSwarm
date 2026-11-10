export function fmtNum(v: number | null | undefined, digits = 0, unit = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}${unit}`;
}

export function fmtMB(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec - m * 60)}s`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Status thresholds -> reserved status roles (always shown with a text label, never color alone).
export type Level = "good" | "warning" | "serious" | "critical";

export function tempLevel(c: number | null | undefined): Level {
  if (c === null || c === undefined) return "good";
  if (c >= 87) return "critical";
  if (c >= 80) return "serious";
  if (c >= 70) return "warning";
  return "good";
}

export function loadLevel(p: number): Level {
  if (p >= 95) return "critical";
  if (p >= 85) return "serious";
  if (p >= 65) return "warning";
  return "good";
}

export const LEVEL_LABEL: Record<Level, string> = {
  good: "OK",
  warning: "High",
  serious: "Very high",
  critical: "Critical",
};
