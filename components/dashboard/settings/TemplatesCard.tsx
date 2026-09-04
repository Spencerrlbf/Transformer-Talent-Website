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
      .then(async (r) => (r.ok ? (r.json() as Promise<{ templates: unknown[]; buttons: Record<string, string | null> }>) : null))
      .then((d) => {
        if (!d) return;
        setN({ templates: d.templates.length, missing: QUICK_BUTTONS.filter((b) => !d.buttons[b.key]).length });
      })
      .catch(() => {});
  }, [token]);

  return (
    <>
      <div className="set-tpl">
        <span className="val">
          {n ? `${n.templates} template${n.templates === 1 ? "" : "s"} · ${QUICK_BUTTONS.length} buttons` : "Loading…"}
          {n && n.missing > 0 && (
            <>
              {" · "}
              <span className="hm-chip warn">
                {n.missing} button{n.missing === 1 ? " has" : "s have"} no template
              </span>
            </>
          )}
        </span>
        <Link href="/dashboard/settings/templates" className="dash-btn dash-btn-2">
          Open templates
        </Link>
      </div>
      <small>
        Shared with your whole team. Every quick-action button in the Inbox and on Home sends one of these; edit the wording, or change which template a button uses.
      </small>
    </>
  );
}
