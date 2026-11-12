"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { storageGet, storageSet } from "./api";
import { runInkTransition } from "./inkTransition";

export type Theme = "dark" | "light";
export const THEME_STORAGE_KEY = "tensorswarm-theme";

/**
 * Runs in <head> before first paint (app/layout.tsx), so the page never flashes the wrong
 * theme. Order: the user's saved choice, else the OS preference on a first visit, else
 * Dark Emerald. Kept dependency-free and tiny on purpose.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement,t;try{t=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){try{t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch(e){t='dark'}}d.setAttribute('data-theme',t);d.style.colorScheme=t})();`;

interface ThemeState {
  theme: Theme;
  /** true while the ink transition runs; the toggle is disabled meanwhile. */
  transitioning: boolean;
  /** Switch theme with the ink-bleed effect starting from `from` (the toggle button). */
  toggle: (from?: HTMLElement | null) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

function readDomTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function writeDomTheme(t: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", t);
  root.style.colorScheme = t;
}

/** The target theme's canvas colour, resolved from the tokens without switching the page. */
function canvasColorOf(t: Theme): string {
  const probe = document.createElement("div");
  probe.setAttribute("data-theme", t);
  probe.style.display = "none";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).getPropertyValue("--canvas").trim();
  probe.remove();
  return rgb ? `rgb(${rgb})` : t === "light" ? "#F5F7FB" : "#091815";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The inline script has already set data-theme; "dark" is only the server-render default.
  const [theme, setTheme] = useState<Theme>("dark");
  const [transitioning, setTransitioning] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    setTheme(readDomTheme());

    // Another tab changed the theme: follow it without animation.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY || (e.newValue !== "light" && e.newValue !== "dark")) return;
      writeDomTheme(e.newValue);
      setTheme(e.newValue);
    };
    // No explicit choice yet: keep following the OS setting.
    let mq: MediaQueryList | null = null;
    const onSystem = (e: MediaQueryListEvent) => {
      if (storageGet(THEME_STORAGE_KEY)) return;
      const t: Theme = e.matches ? "light" : "dark";
      writeDomTheme(t);
      setTheme(t);
    };
    window.addEventListener("storage", onStorage);
    try {
      mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", onSystem);
    } catch {
      mq = null;
    }
    return () => {
      window.removeEventListener("storage", onStorage);
      mq?.removeEventListener("change", onSystem);
    };
  }, []);

  const toggle = useCallback((from?: HTMLElement | null) => {
    if (busy.current) return;                       // never two transitions at once
    busy.current = true;
    setTransitioning(true);
    const next: Theme = readDomTheme() === "dark" ? "light" : "dark";

    const rect = from?.getBoundingClientRect();
    const origin = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth - 40, y: 40 };

    const apply = () => {
      writeDomTheme(next);
      storageSet(THEME_STORAGE_KEY, next);
      // Commit React's view of the theme inside the snapshot callback.
      flushSync(() => setTheme(next));
    };

    // Light -> dark: Dark Emerald ink spreads from the dial. Dark -> light: it retracts into it.
    runInkTransition({ origin, apply, reverse: next === "light", targetCanvas: canvasColorOf(next), live: from ?? undefined })
      .catch(() => apply())
      .finally(() => {
        busy.current = false;
        setTransitioning(false);
      });
  }, []);

  return <ThemeContext.Provider value={{ theme, transitioning, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
