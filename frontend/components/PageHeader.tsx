"use client";

import React from "react";
import ThemeToggle from "./ThemeToggle";

/** Page title row. The theme toggle always sits at its top-right, on every page. */
export default function PageHeader({ title, subtitle, actions, compact = false }: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <header className={`flex items-start justify-between gap-4 ${compact ? "" : "pb-1"}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <h1 className={`${compact ? "text-[24px]" : "text-[30px] md:text-[32px]"} font-bold leading-tight tracking-[-0.025em] text-fg`} style={{ textWrap: "balance" } as React.CSSProperties}>
          {title}
        </h1>
        {subtitle && <p className="max-w-[68ch] text-[14px] text-muted">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
