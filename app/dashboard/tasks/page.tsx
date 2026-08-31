"use client";
// Tasks: everything due, in one place — tasks the team created and
// candidate-requested follow-ups ("hear from me later") folded in as
// request rows. Candidate chips open the same drawer as everywhere else.
import { useState } from "react";
import TasksView from "@/components/dashboard/tasks/TasksView";
import CandidateDrawer from "@/components/dashboard/candidates/CandidateDrawer";

export default function TasksPage() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  return (
    <>
      <TasksView
        reloadNonce={reloadNonce}
        onOpenCandidate={setOpenKey}
      />
      <CandidateDrawer
        candKey={openKey}
        onClose={() => {
          setOpenKey(null);
          // The drawer can create tasks and clear follow-ups; refresh on close.
          setReloadNonce((n) => n + 1);
        }}
      />
    </>
  );
}
