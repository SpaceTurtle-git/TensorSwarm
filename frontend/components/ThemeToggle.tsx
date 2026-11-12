"use client";

import React, { useRef } from "react";
import { useTheme } from "../lib/theme";
import { IconMoon, IconSun } from "./icons";

/**
 * Sun/moon dial. A knob slides under the active icon; the ink transition starts from the
 * dial's centre (lib/theme.tsx -> lib/inkTransition.ts). Styles: .theme-dial in globals.css.
 */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, transitioning, toggle } = useTheme();
  const ref = useRef<HTMLButtonElement>(null);
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={theme === "dark"}
      aria-label="Dark theme"
      title={label}
      onClick={() => toggle(ref.current)}
      disabled={transitioning}
      className={`theme-dial shrink-0 ${className}`}
    >
      <span className="theme-dial-knob" aria-hidden="true" />
      <span className="theme-dial-icon" data-icon="sun" aria-hidden="true"><IconSun size={17} /></span>
      <span className="theme-dial-icon" data-icon="moon" aria-hidden="true"><IconMoon size={16} /></span>
    </button>
  );
}
