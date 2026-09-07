"use client";
// Settings: the door to Email templates, with the counts that matter.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";
import { QUICK_BUTTONS } from "@/lib/quick-buttons";

export default function TemplatesCard() {
  const { token } = useDash();
  const [n, setN] = useState<{ templates: number; missing: number } | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/email/templates", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? (r.json() as Promise<{ templates: { actionKey: string | null }[] }>) : null))
      .then((d) => {
        if (!d) return;
        const keys = new Set(d.templates.map((t) => t.actionKey).filter(Boolean));
        setN({ templates: d.templates.length, missing: QUICK_BUTTONS.filter((b) => !keys.has(b.defaultKey)).length });
      })
      .catch(() => {});
  }, [token]);

  return (
    <>
      <div className="set-tpl">
        <span className="val">
          {n ? `${n.templates} template${n.templates === 1 ? "" : "s"}` : "Loading…"}
          {n && n.missing > 0 && (
            <>
              {" · "}
              <span className="hm-chip warn">
                {n.missing} button{n.missing === 1 ? " has" : "s have"} no wording
              </span>
            </>
          )}
        </span>
        <Link href="/dashboard/settings/templates" className="dash-btn dash-btn-2">
          Open templates
        </Link>
      </div>
      <small>
        The wording your team sends. Every quick-action button in the Inbox and on Home uses one of these, and anyone can swap to a different one in the composer before sending.
      </small>
    </>
  );
}
