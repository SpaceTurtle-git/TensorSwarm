"use client";

import React from "react";
import { ClusterProvider } from "../lib/cluster";
import NavBar from "./NavBar";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClusterProvider>
      <NavBar />
      {children}
    </ClusterProvider>
  );
}
