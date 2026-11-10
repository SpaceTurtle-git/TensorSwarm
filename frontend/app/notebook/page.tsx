"use client";

import React, { Suspense } from "react";
import NotebookApp from "../../components/notebook/NotebookApp";

export default function NotebookPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-500">Loading notebook…</div>}>
      <NotebookApp />
    </Suspense>
  );
}
