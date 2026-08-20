"use client";
// Candidates v2: the org's whole talent pool — applicants and sourced people
// in one sortable table. "Not now" people stay visible here (a per-role
// judgment isn't a judgment on the person); the job page hides them.
import { useState } from "react";
import CandidatesTable from "@/components/dashboard/candidates/CandidatesTable";

export default function CandidatesPage() {
  const [counts, setCounts] = useState<{
    all: number;
    applied: number;
    sourced: number;
    notNow: number;
  } | null>(null);

  return (
    <>
      <h1 className="dash-h1">Candidates</h1>
      <p className="dash-sub">
        {counts
          ? `${counts.all + counts.notNow} people across all roles · ${counts.applied} applied · ${
              counts.sourced + counts.notNow
            } sourced${counts.notNow ? ` · ${counts.notNow} tagged "Not now"` : ""}`
          : "Everyone in your pipeline — applicants and sourced candidates."}
      </p>
      <CandidatesTable onCounts={setCounts} />
    </>
  );
}
