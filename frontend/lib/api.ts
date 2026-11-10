// Small fetch wrapper. With no Master URL configured, requests go to this Next.js app's own
// /api/* proxy (app/api/[...path]/route.ts), which forwards them to MASTER_API_URL.

export const MASTER_URL_STORAGE_KEY = "tensorswarm-master-url";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizeBase(url: string | null | undefined): string {
  return (url || "").trim().replace(/\/+$/, "");
}

export async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const url = `${normalizeBase(base)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
    });
  } catch (err) {
    throw new ApiError(0, `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail ?? body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function postJson<T>(base: string, path: string, body: unknown): Promise<T> {
  return api<T>(base, path, { method: "POST", body: JSON.stringify(body) });
}

// localStorage can throw (private windows, blocked storage). Never let that break the app.
export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
