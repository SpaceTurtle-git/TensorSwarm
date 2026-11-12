"use client";

import React, { useRef } from "react";
import { useTheme } from "../lib/theme";
import { IconMoon, IconSun } from "./icons";

/** Sun/moon switch. The ink transition starts from this button's centre. */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, transitioning, toggle } = useTheme();
  const ref = useRef<HTMLButtonElement>(null);
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => toggle(ref.current)}
      disabled={transitioning}
      aria-label={label}
      title={label}
      className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-elevated/70 text-fg transition-[background-color,border-color,filter] duration-150 hover:border-line-strong hover:bg-elevated disabled:cursor-wait ${className}`}
    >
      <IconSun className="theme-icon theme-icon-sun absolute" size={18} />
      <IconMoon className="theme-icon theme-icon-moon absolute" size={18} />
    </button>
  );
}
