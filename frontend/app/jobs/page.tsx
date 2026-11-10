"use client";

import React, { Suspense } from "react";
import JobsApp from "../../components/JobsApp";

export default function JobsPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-slate-500">Loading…</div>}>
      <JobsApp />
    </Suspense>
  );
}
