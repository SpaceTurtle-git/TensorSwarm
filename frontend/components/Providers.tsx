"use client";

import React from "react";
import { ClusterProvider } from "../lib/cluster";
import { ThemeProvider } from "../lib/theme";
import AppShell from "./AppShell";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ClusterProvider>
        <AppShell>{children}</AppShell>
      </ClusterProvider>
    </ThemeProvider>
  );
}
