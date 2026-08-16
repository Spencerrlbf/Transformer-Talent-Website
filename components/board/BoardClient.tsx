"use client";
// Tenant job board: company-name header, open roles with expandable detail,
// select-up-to-3 apply flow, speculative resume drop. Posts to /api/apply
// with the board slug; suggestions come back scoped to this company only.
// When embedded via widget.js (?embed=1 in an iframe) it reports its height
// to the parent for auto-resizing.
import { useEffect, useRef, useState } from "react";

const MAX_ROLES = 3;

export type BoardRoleView = {
  jobId: string;
  title: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  roleType: string;
  about: string;
  doing: string[];
  needs: string[];
  bonus: string[];
};

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; matches: { jobId: string; title: string; salary: string }[]; wasSpeculative: boolean }
  | { kind: "error"; message: string };

export default function BoardClient({
  org,
  roles,
}: {
  org: { slug: string; name: string };
  roles: BoardRoleView[];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [speculative, setSpeculative] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [formError, setFormError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  // Embed mode: report height to the parent page for iframe auto-resize.
  useEffect(() => {
    if (window.self === window.top) return;
    const post = () =>
      window.parent.postMessage(
        { ttBoard: org.slug, height: document.documentElement.scrollHeight },
        "*"
      );
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [org.slug]);

  const isSpeculative = speculative && selected.length === 0;

  function toggle(jobId: string) {
    setSpeculative(false);
    setSelected((cur) =>
      cur.includes(jobId)
        ? cur.filter((x) => x !== jobId)
        : cur.length >= MAX_ROLES
          ? cur
          : [...cur, jobId]
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    const resume = data.get("resume");
    const hasResume = resume instanceof File && resume.size > 0;
    if (isSpeculative && !hasResume) {
      setFormError("A resume is required for a general application — it's what we match you with.");
      return;
    }
    if (!isSpeculative && selected.length === 0) {
      setFormError("Select at least one role above, or use the general application instead.");
      return;
    }
    data.set("board", org.slug);
    data.set("roleIds", selected.join(","));
    if (isSpeculative) data.set("speculative", "1");
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/apply", { method: "POST", body: data });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        form.reset();
        setSelected([]);
        setStatus({ kind: "ok", matches: json.matches || [], wasSpeculative: isSpeculative });
      } else {
        setStatus({ kind: "error", message: json.error || "Something went wrong — please try again." });
      }
    } catch {
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  const selectedRoles = selected
    .map((id) => roles.find((r) => r.jobId === id))
    .filter((r): r is BoardRoleView => Boolean(r));

  return (
    <div className="board-app" ref={rootRef}>
      <header className="board-head">
        <h1>{org.name}</h1>
        <p>Open roles</p>
      </header>

      {roles.length === 0 && (
        <p className="board-empty">No open roles right now — check back soon.</p>
      )}

      <div className="board-roles">
        {roles.map((r) => {
          const isOpen = openRole === r.jobId;
          const isSel = selected.includes(r.jobId);
          return (
            <div key={r.jobId} className={`board-role ${isOpen ? "open" : ""}`}>
              <button className="board-role-row" onClick={() => setOpenRole(isOpen ? null : r.jobId)}>
                <span className="board-role-title">{r.title}</span>
                <span className="board-role-meta">
                  {[r.workplace, r.locations.join(", "), r.salary, r.yoe]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className={`board-role-add ${isSel ? "on" : ""}`}>
                  {isSel ? "✓ Selected" : "Select"}
                </span>
              </button>
              {isOpen && (
                <div className="board-role-body">
                  {r.about && <p>{r.about}</p>}
                  {r.doing.length > 0 && (
                    <>
                      <h4>What you&apos;ll do</h4>
                      <ul>{r.doing.map((d, i) => <li key={i}>{d}</li>)}</ul>
                    </>
                  )}
                  {r.needs.length > 0 && (
                    <>
                      <h4>What they&apos;re looking for</h4>
                      <ul>{r.needs.map((d, i) => <li key={i}>{d}</li>)}</ul>
                    </>
                  )}
                  {r.bonus.length > 0 && (
                    <>
                      <h4>Nice to have</h4>
                      <ul>{r.bonus.map((d, i) => <li key={i}>{d}</li>)}</ul>
                    </>
                  )}
                  <button
                    className={`board-btn ${isSel ? "board-btn-2" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.jobId);
                      if (!isSel) formRef.current?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    {isSel ? "Remove from application" : "Apply to this role"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="board-apply" ref={formRef}>
        {status.kind === "ok" ? (
          <div className="board-thanks">
            <h2>
              {status.wasSpeculative
                ? "Resume received."
                : "Application received."}
            </h2>
            <p>
              {status.wasSpeculative
                ? `We'll match you against ${org.name}'s open roles — and new ones as they arrive — and be in touch when there's a genuine fit.`
                : "Every application is screened and reviewed — you'll hear back when there's a fit."}
            </p>
            {status.matches.length > 0 && (
              <>
                <h3>You also look like a fit for</h3>
                <ul className="board-matchlist">
                  {status.matches.map((m) => (
                    <li key={m.jobId}>
                      <b>{m.title}</b>
                      {m.salary ? ` — ${m.salary}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="board-apply-head">
              <h2>
                {isSpeculative
                  ? "General application"
                  : selected.length > 0
                    ? `Apply — ${selected.length} role${selected.length > 1 ? "s" : ""} selected`
                    : "Apply"}
              </h2>
              {selected.length === 0 && !speculative && (
                <p>
                  Select up to {MAX_ROLES} roles above — or{" "}
                  <button className="board-linkbtn" onClick={() => setSpeculative(true)}>
                    send a general application
                  </button>{" "}
                  and we&apos;ll match you.
                </p>
              )}
              {isSpeculative && (
                <p>
                  No role selected — drop your resume and we&apos;ll match you against{" "}
                  {org.name}&apos;s roles.{" "}
                  <button className="board-linkbtn" onClick={() => setSpeculative(false)}>
                    Back to selecting roles
                  </button>
                </p>
              )}
              {selectedRoles.length > 0 && (
                <ul className="board-cart">
                  {selectedRoles.map((r) => (
                    <li key={r.jobId}>
                      {r.title}
                      <button className="board-linkbtn" onClick={() => toggle(r.jobId)}>
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form onSubmit={onSubmit} className="board-form">
              <label>
                Name
                <input name="name" required maxLength={120} autoComplete="name" />
              </label>
              <label>
                Email
                <input name="email" type="email" required maxLength={254} autoComplete="email" />
              </label>
              <label>
                LinkedIn URL (required)
                <input name="linkedin" type="url" required placeholder="https://linkedin.com/in/…" maxLength={300} />
              </label>
              <label>
                Resume (PDF{isSpeculative ? ", required" : ", optional but recommended"})
                <input name="resume" type="file" accept="application/pdf" required={isSpeculative} />
              </label>
              <label>
                Locations you&apos;re open to (optional — ⌘/Ctrl-click for several; empty = your profile location)
                <select name="preferredLocations" multiple size={5}>
                  <option value="SF">SF / Bay Area</option>
                  <option value="NYC">NYC</option>
                  <option value="Miami">Miami</option>
                  <option value="Seattle">Seattle</option>
                  <option value="Chicago">Chicago</option>
                  <option value="Washington DC">Washington DC</option>
                  <option value="Austin">Austin</option>
                  <option value="Boston">Boston</option>
                  <option value="Los Angeles">Los Angeles</option>
                  <option value="Canada">Canada</option>
                </select>
              </label>
              <label>
                Visa status
                <select name="visa" defaultValue="">
                  <option value="" disabled>
                    select…
                  </option>
                  <option value="None needed (US citizen / green card)">
                    None needed (US citizen / green card)
                  </option>
                  <option value="H-1B">H-1B</option>
                  <option value="STEM OPT">STEM OPT</option>
                  <option value="TN">TN</option>
                  <option value="O-1">O-1</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <label>
                Anything else
                <textarea name="note" rows={2} maxLength={2000} />
              </label>
              <input
                name="website"
                tabIndex={-1}
                autoComplete="off"
                style={{ position: "absolute", left: "-9999px" }}
                aria-hidden="true"
              />
              {(formError || status.kind === "error") && (
                <p className="board-error">
                  {formError || (status.kind === "error" ? status.message : "")}
                </p>
              )}
              <button type="submit" className="board-btn" disabled={status.kind === "sending"}>
                {status.kind === "sending"
                  ? "Submitting…"
                  : isSpeculative
                    ? "Submit for matching"
                    : "Submit application"}
              </button>
            </form>
          </>
        )}
      </div>

      <footer className="board-foot">
        <a href="https://www.transformertalent.com" target="_blank" rel="noreferrer">
          Powered by Transformer Talent
        </a>
      </footer>
    </div>
  );
}
