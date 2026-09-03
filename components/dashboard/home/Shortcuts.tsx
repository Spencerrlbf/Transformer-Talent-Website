"use client";
// Home: the row of shortcuts under the greeting. Links go where the work
// lives; the three that need a person or a role open a small picker first.
import { useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";

const SITE = "https://www.transformertalent.com";

export default function Shortcuts({ onCompose, onNewTask, onSourcing }: { onCompose: () => void; onNewTask: () => void; onSourcing: () => void }) {
  const { role, myPage } = useDash();
  const [copied, setCopied] = useState(false);

  const copyPage = async () => {
    if (!myPage?.published) return;
    try {
      await navigator.clipboard.writeText(`${SITE}/r/${myPage.slug}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the My page link still shows the URL */
    }
  };

  return (
    <div className="hm-short" role="group" aria-label="Shortcuts">
      <Link href="/dashboard/jobs/new">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add a role
      </Link>
      <button type="button" onClick={onCompose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
        Compose email
      </button>
      <button type="button" onClick={onNewTask}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
        New task
      </button>
      {myPage?.published ? (
        <button type="button" className={copied ? "ok" : ""} onClick={copyPage}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
          {copied ? "Copied" : "Copy my page link"}
        </button>
      ) : (
        <Link href="/dashboard/my-page">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
          Set up my page
        </Link>
      )}
      <button type="button" onClick={onSourcing}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        Start a sourcing run
      </button>
      {role === "owner" && (
        <Link href="/dashboard/team">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>
          Invite a teammate
        </Link>
      )}
    </div>
  );
}
