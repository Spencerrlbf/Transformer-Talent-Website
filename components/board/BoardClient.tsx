"use client";
// Tenant job board: a light-skinned mirror of the site's roles board — same
// speculative banner, search semantics, filters, sortable table with
// APPLY +/✓ selection, and 25-per-page pagination. Selecting a role (or
// choosing the resume path) opens a checkout rail to the RIGHT of the table
// — cart on top, details form beneath — exactly like the site's /apply
// layout, collapsed onto one page. Tenant roles have no detail pages, so
// clicking a role title expands the full JD inline. Posts to /api/apply
// with the board slug; suggestions come back scoped to this company only.
// When embedded via widget.js it reports its height for iframe auto-resize.
import { useEffect, useMemo, useRef, useState } from "react";
import CompanyAbout from "@/components/board/CompanyAbout";
import type { CompanyPage } from "@/lib/server/company-page";
import {
  ROLE_FOCUS_OPTIONS,
  WORKPLACE_OPTIONS,
  SALARY_BAND_OPTIONS,
} from "@/lib/future-options";

const MAX_ROLES = 3;
const PAGE_SIZE = 25;

export type BoardRoleView = {
  jobId: string;
  title: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  roleType: string;
  techStack: string;
  visa: string;
  about: string;
  doing: string[];
  needs: string[];
  bonus: string[];
};

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | {
      kind: "ok";
      matches: { jobId: string; title: string; salary: string }[];
      wasSpeculative: boolean;
      alreadyApplied?: boolean;
    }
  | { kind: "error"; message: string };

// comma = OR groups; space-separated terms = AND; -term excludes; "quoted phrase"
function matchesQuery(hay: string, q: string): boolean {
  const groups = q.toLowerCase().split(",").map((g) => g.trim()).filter(Boolean);
  if (!groups.length) return true;
  return groups.some((g) => {
    const terms = g.match(/-?"[^"]+"|\S+/g) || [];
    return terms.every((t) => {
      const neg = t.startsWith("-");
      const term = t.replace(/^-/, "").replace(/"/g, "").trim();
      if (!term) return true;
      const has = hay.includes(term);
      return neg ? !has : has;
    });
  });
}

const visaBucket = (r: BoardRoleView) =>
  /transfer|sponsor/i.test(r.visa || "") ? "Visa transfers OK" : "No sponsorship";
const salaryMin = (r: BoardRoleView) => {
  const m = r.salary.toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)k|\$(\d{5,6})/);
  return m ? parseFloat(m[1] || String(Number(m[2]) / 1000)) : 0;
};
const yoeMin = (r: BoardRoleView) => {
  const m = r.yoe.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
};

type SortKey = "id" | "title" | "location" | "workplace" | "yoe" | "salary";
const HEADERS: { key: SortKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "title", label: "Role" },
  { key: "location", label: "Location" },
  { key: "workplace", label: "Office" },
  { key: "yoe", label: "Experience" },
  { key: "salary", label: "Base salary" },
];

// Recruiter mode: the same board rendered as a person's public page — banner
// header, first-person resume banner, mandatory resume, and attribution.
export type RecruiterHead = {
  id: string;
  name: string;
  photoUrl: string | null;
  linkedinUrl: string;
  website: string;
  bio: string;
  /** Pasted scheduling link (cal.com / Calendly / Google); empty hides Book a call. */
  bookingUrl: string;
  /** Public email for the copy-to-clipboard button; empty hides it. */
  contactEmail: string;
  /** Bounty in dollars; null hides the referral block. */
  referralAmount: number | null;
};

// Analytics beacon (recruiter pages only): fire-and-forget, deduped
// server-side per visitor per day, never blocks or errors at a candidate.
function track(profileId: string, event: string, roleId?: string) {
  try {
    const payload = JSON.stringify({
      p: profileId,
      e: event,
      r: roleId || "",
      ref: document.referrer || "",
    });
    if (!navigator.sendBeacon?.("/api/e", new Blob([payload], { type: "application/json" }))) {
      fetch("/api/e", { method: "POST", body: payload, keepalive: true }).catch(() => {});
    }
  } catch {
    /* analytics must never break the page */
  }
}

// Known schedulers get their official embed form so booking happens right on
// the page; anything unrecognized returns null and opens in a new tab instead.
function bookingEmbedSrc(url: string): string | null {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (h === "cal.com" || h.endsWith(".cal.com")) {
      u.searchParams.set("embed", "true");
      return u.toString();
    }
    if (h === "calendly.com" || h.endsWith(".calendly.com")) {
      u.searchParams.set("embed_domain", window.location.hostname);
      u.searchParams.set("embed_type", "Inline");
      u.searchParams.set("hide_gdpr_banner", "1");
      return u.toString();
    }
    // Only Google APPOINTMENT pages embed; other calendar.google.com URLs
    // (e.g. someone pasting their own week view) refuse framing, so those
    // fall through to the new-tab path instead of a blank popup.
    if (h === "calendar.google.com" && u.pathname.includes("/appointments/")) {
      u.searchParams.set("gv", "true");
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export default function BoardClient({
  org,
  roles,
  recruiter,
  company,
  initialTab = "jobs",
}: {
  org: { slug: string; name: string };
  roles: BoardRoleView[];
  recruiter?: RecruiterHead;
  /** Published company page content; undefined = plain board (as ever). */
  company?: CompanyPage;
  initialTab?: "jobs" | "about";
}) {
  const [coTab, setCoTab] = useState<"jobs" | "about">(company ? initialTab : "jobs");

  function switchCoTab(t: "jobs" | "about") {
    setCoTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (t === "about") url.searchParams.set("tab", "about");
      else url.searchParams.delete("tab");
      window.history.replaceState(null, "", url.toString());
    }
  }
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  const [office, setOffice] = useState("");
  const [type, setType] = useState("");
  const [visaF, setVisaF] = useState("");
  const [sort, setSort] = useState<SortKey>("id");
  const [dir, setDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [speculative, setSpeculative] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [formError, setFormError] = useState("");
  const railRef = useRef<HTMLElement>(null);

  // Booking + contact actions (recruiter mode): header row on desktop, a
  // bottom-pinned bar on phones — same buttons, position by screen width.
  const [bookSrc, setBookSrc] = useState<string | null>(null);
  const [emailCopied, setEmailCopied] = useState(false);

  function openBooking() {
    if (!recruiter?.bookingUrl) return;
    track(recruiter.id, "booking_click");
    const src = bookingEmbedSrc(recruiter.bookingUrl);
    if (src) setBookSrc(src);
    else window.open(recruiter.bookingUrl, "_blank", "noopener");
  }

  async function copyEmail() {
    if (!recruiter?.contactEmail) return;
    track(recruiter.id, "email_copy");
    try {
      await navigator.clipboard.writeText(recruiter.contactEmail);
      setEmailCopied(true);
      setTimeout(() => setEmailCopied(false), 1600);
    } catch {
      window.location.href = `mailto:${recruiter.contactEmail}`;
    }
  }

  const hasContactActions = Boolean(
    recruiter && (recruiter.bookingUrl || recruiter.contactEmail || recruiter.linkedinUrl)
  );
  const contactActions = recruiter ? (
    <>
      {recruiter.bookingUrl && (
        <button type="button" className="rp-abtn primary" onClick={openBooking}>
          Book a call
        </button>
      )}
      {recruiter.contactEmail && (
        <button type="button" className="rp-abtn" onClick={copyEmail}>
          {emailCopied ? "Copied ✓" : "Email"}
        </button>
      )}
      {recruiter.linkedinUrl && (
        <a
          className="rp-abtn"
          href={recruiter.linkedinUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => track(recruiter.id, "linkedin_click")}
        >
          <b>in</b> LinkedIn
        </a>
      )}
    </>
  ) : null;

  // "Hear from me later": future-interest capture. One form, two entrances —
  // the slim strip under the banners and the "no fit" doors after the table.
  const [futOpen, setFutOpen] = useState(false);
  const [futMonths, setFutMonths] = useState("6");
  const [futRoles, setFutRoles] = useState<string[]>([]);
  const [futWorkplace, setFutWorkplace] = useState<string[]>([]);
  const [futLocs, setFutLocs] = useState<string[]>([]);
  const [futSalary, setFutSalary] = useState("");
  const [futStatus, setFutStatus] = useState<
    { kind: "idle" | "sending" } | { kind: "ok"; when: string } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const futRef = useRef<HTMLDivElement>(null);
  const firstName = recruiter?.name.split(/\s+/)[0] || "us";

  function openFuture(scroll: boolean) {
    if (!recruiter) return;
    if (!futOpen) track(recruiter.id, "future_open");
    setFutOpen(true);
    if (scroll) futRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleIn(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  async function onFutureSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!recruiter) return;
    const data = new FormData(e.currentTarget);
    data.set("board", org.slug);
    data.set("recruiter", recruiter.id);
    data.set("months", futMonths);
    for (const v of futRoles) data.append("prefRoles", v);
    for (const v of futWorkplace) data.append("prefWorkplace", v);
    for (const v of futLocs) data.append("prefLocations", v);
    if (futSalary) data.set("prefSalary", futSalary);
    setFutStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/future-interest", { method: "POST", body: data });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        const when = json.followUpAt
          ? new Date(`${json.followUpAt}T00:00:00Z`).toLocaleDateString("en-GB", {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })
          : "a few months";
        setFutStatus({ kind: "ok", when });
      } else {
        setFutStatus({ kind: "error", message: json.error || "Something went wrong — please try again." });
      }
    } catch {
      setFutStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

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

  useEffect(() => {
    setPage(1);
  }, [q, loc, office, type, visaF]);

  const recruiterId = recruiter?.id;
  useEffect(() => {
    if (recruiterId) track(recruiterId, "view");
  }, [recruiterId]);

  const locations = useMemo(() => [...new Set(roles.flatMap((r) => r.locations))].sort(), [roles]);
  const offices = useMemo(() => [...new Set(roles.map((r) => r.workplace).filter(Boolean))].sort(), [roles]);
  const types = useMemo(
    () => [...new Set(roles.flatMap((r) => r.roleType.split(",").map((t) => t.trim())).filter(Boolean))].sort(),
    [roles]
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = roles.filter((r) => {
      if (loc && !r.locations.includes(loc)) return false;
      if (office && r.workplace !== office) return false;
      if (type && !r.roleType.toLowerCase().includes(type.toLowerCase())) return false;
      if (visaF && visaBucket(r) !== visaF) return false;
      if (needle) {
        const hay = [
          r.jobId, r.title, r.about, r.techStack, r.roleType,
          r.locations.join(" "), r.needs.join(" "), r.doing.join(" "),
        ].join(" ").toLowerCase();
        if (!matchesQuery(hay, needle)) return false;
      }
      return true;
    });
    const cmp: Record<SortKey, (a: BoardRoleView, b: BoardRoleView) => number> = {
      id: (a, b) => parseInt(a.jobId, 10) - parseInt(b.jobId, 10),
      title: (a, b) => a.title.localeCompare(b.title),
      location: (a, b) => (a.locations[0] || "zz").localeCompare(b.locations[0] || "zz"),
      workplace: (a, b) => (a.workplace || "zz").localeCompare(b.workplace || "zz"),
      yoe: (a, b) => yoeMin(a) - yoeMin(b),
      salary: (a, b) => salaryMin(a) - salaryMin(b),
    };
    return out.sort((a, b) => cmp[sort](a, b) * dir);
  }, [roles, q, loc, office, type, visaF, sort, dir]);

  function clickSort(k: SortKey) {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(1);
    }
  }

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

  const isSpeculative = speculative && selected.length === 0;
  const railVisible = selected.length > 0 || speculative || status.kind !== "idle";
  const selectedRoles = selected
    .map((id) => roles.find((r) => r.jobId === id))
    .filter((r): r is BoardRoleView => Boolean(r));
  const goToRail = () => railRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    const resume = data.get("resume");
    const hasResume = resume instanceof File && resume.size > 0;
    if ((isSpeculative || recruiter) && !hasResume) {
      setFormError(
        recruiter
          ? "A resume is required."
          : "A resume is required for a general application — it's what we match you with."
      );
      return;
    }
    if (!isSpeculative && selected.length === 0) {
      setFormError("Select at least one role (APPLY +), or switch to a general application.");
      return;
    }
    data.set("board", org.slug);
    if (recruiter) data.set("recruiter", recruiter.id);
    data.set("roleIds", selected.join(","));
    if (isSpeculative) data.set("speculative", "1");
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/apply", { method: "POST", body: data });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        form.reset();
        setSelected([]);
        setSpeculative(false);
        setStatus({
          kind: "ok",
          matches: json.matches || [],
          wasSpeculative: isSpeculative,
          alreadyApplied: json.alreadyApplied === true,
        });
      } else {
        setStatus({ kind: "error", message: json.error || "Something went wrong — please try again." });
      }
    } catch {
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  const pageCount = Math.ceil(shown.length / PAGE_SIZE);

  return (
    <div className="board-app">
      {company && (
        <>
          <div className="co-strip">
            {company.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="co-logo co-logo-img" src={company.logoUrl} alt={org.name} />
            ) : (
              <div className="co-logo">{org.name[0]?.toUpperCase()}</div>
            )}
            <div>
              <div className="co-name">{org.name}</div>
              {company.profile.tagline && <div className="co-tagline">{company.profile.tagline}</div>}
              {(() => {
                const p = company.profile;
                const facts = [p.headcount, p.founded, p.stage, p.funding, p.offices, p.workEnv]
                  .filter(Boolean);
                return facts.length > 0 ? (
                  <div className="co-facts">
                    {facts.map((f, i) => (
                      <span key={i} className="co-fact">{f}</span>
                    ))}
                  </div>
                ) : null;
              })()}
            </div>
            {company.website && (
              <a className="co-site" href={company.website} target="_blank" rel="noreferrer">
                {company.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")} ↗
              </a>
            )}
          </div>
          <div className="co-tabs">
            <button
              type="button"
              className={coTab === "jobs" ? "on" : ""}
              onClick={() => switchCoTab("jobs")}
            >
              Jobs<span className="n">{roles.length}</span>
            </button>
            <button
              type="button"
              className={coTab === "about" ? "on" : ""}
              onClick={() => switchCoTab("about")}
            >
              About
            </button>
          </div>
        </>
      )}
      {company && coTab === "about" ? (
        <>
          <CompanyAbout
            company={company}
            rolesCount={roles.length}
            onSeeRoles={() => switchCoTab("jobs")}
          />
          <footer className="board-foot">
            <a href="https://www.transformertalent.com" target="_blank" rel="noreferrer">
              Powered by Transformer Talent
            </a>
          </footer>
        </>
      ) : (
        <>
      {recruiter ? (
        <header className="rp-head">
          {recruiter.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="rp-photo" src={recruiter.photoUrl} alt={recruiter.name} />
          ) : (
            <span className="rp-initials">
              {recruiter.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((w) => w[0]?.toUpperCase())
                .join("")}
            </span>
          )}
          <div className="rp-id">
            <h1>{recruiter.name}</h1>
            <p className="rp-sub">
              Recruiter · <b>{org.name}</b>
            </p>
            {recruiter.bio && <p className="rp-bio">{recruiter.bio}</p>}
            {hasContactActions && <div className="rp-actions">{contactActions}</div>}
          </div>
          <div className="rp-side">
            <div className="rp-links">
              {recruiter.website && (
                <a href={recruiter.website} target="_blank" rel="noreferrer">
                  {recruiter.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                </a>
              )}
            </div>
            <span className="rp-open">
              {roles.length} OPEN ROLE{roles.length === 1 ? "" : "S"}
            </span>
          </div>
        </header>
      ) : company ? null : (
        <header className="board-head">
          <h1>{org.name}</h1>
          <p>Open roles</p>
        </header>
      )}

      {/* Org boards keep the plain resume banner. */}
      {!recruiter && !railVisible && (
        <div className="board-banners">
          <div className="board-spec">
            <p>
              <b>Nothing that fits?</b> Upload your resume — we&apos;ll match you against{" "}
              {org.name}&apos;s open roles and reach out when the right one arrives.
            </p>
            <button
              className="board-btn"
              onClick={() => {
                setSpeculative(true);
              }}
            >
              UPLOAD RESUME →
            </button>
          </div>
        </div>
      )}

      {/* Recruiter pages: one block, three doors — resume now, hear from me
          later, refer someone. Each opens its own form. */}
      {recruiter && !railVisible && (
        <div className="board-futwrap" ref={futRef}>
          <div className="board-triple">
            <p>
              <b>Not applying today?</b> Upload your resume for matching, ask{" "}
              {firstName} to come back to you later, or refer someone great
              {recruiter.referralAmount != null
                ? ` and receive $${recruiter.referralAmount.toLocaleString()} if we place them`
                : ""}
              .
            </p>
            <div className="board-triple-btns">
              <button
                type="button"
                className="board-btn"
                onClick={() => {
                  setSpeculative(true);
                }}
              >
                UPLOAD RESUME →
              </button>
              <button
                type="button"
                className="board-doorbtn"
                aria-expanded={futOpen}
                onClick={() => (futOpen ? setFutOpen(false) : openFuture(false))}
              >
                HEAR FROM {firstName.toUpperCase()} LATER
              </button>
              {recruiter.referralAmount != null && (
                <button
                  type="button"
                  className="board-refstrip-btn"
                  onClick={() => {
                    track(recruiter.id, "referral_open");
                    document
                      .getElementById("refer")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  REFER AN ENGINEER →
                </button>
              )}
            </div>
          </div>
          {futStatus.kind === "ok" ? (
            <div className="board-futdone">
              <b>
                Done. {firstName} will come back to you in {futStatus.when}.
              </b>{" "}
              Nothing before then unless something exceptional appears.
            </div>
          ) : (
            <>
              {futOpen && (
                <form className="board-fut" onSubmit={onFutureSubmit}>
                  <div className="board-fut-row">
                    <label>
                      Email
                      <input name="email" type="email" required maxLength={254} autoComplete="email" />
                    </label>
                    <label>
                      LinkedIn URL
                      <input
                        name="linkedin"
                        required
                        maxLength={300}
                        placeholder="linkedin.com/in/…"
                        autoComplete="url"
                      />
                    </label>
                  </div>
                  <div className="board-fut-row">
                    <label>
                      Resume (optional, PDF)
                      <input name="resume" type="file" accept="application/pdf" />
                    </label>
                  </div>
                  <p className="board-fut-lbl">When should {firstName} get back to you?</p>
                  <div className="board-fut-pills" role="group" aria-label="When to reach out">
                    {["3", "6", "9", "12"].map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={futMonths === m ? "on" : ""}
                        onClick={() => setFutMonths(m)}
                      >
                        {m} months
                      </button>
                    ))}
                  </div>
                  <p className="board-fut-lbl">
                    What should {firstName} come back with? <span>All optional — pick any that fit.</span>
                  </p>
                  <div className="board-fut-chips" role="group" aria-label="Role focus">
                    {ROLE_FOCUS_OPTIONS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={futRoles.includes(v)}
                        className={futRoles.includes(v) ? "on" : ""}
                        onClick={() => setFutRoles((cur) => toggleIn(cur, v))}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <div className="board-fut-chips" role="group" aria-label="Workplace">
                    {WORKPLACE_OPTIONS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={futWorkplace.includes(v)}
                        className={futWorkplace.includes(v) ? "on" : ""}
                        onClick={() => setFutWorkplace((cur) => toggleIn(cur, v))}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  {locations.length > 0 && (
                    <div className="board-fut-chips" role="group" aria-label="Locations">
                      {locations.map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={futLocs.includes(v)}
                          className={futLocs.includes(v) ? "on" : ""}
                          onClick={() => setFutLocs((cur) => toggleIn(cur, v))}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="board-fut-chips" role="group" aria-label="Minimum salary">
                    {SALARY_BAND_OPTIONS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={futSalary === v}
                        className={futSalary === v ? "on" : ""}
                        onClick={() => setFutSalary((cur) => (cur === v ? "" : v))}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <input
                    name="website"
                    tabIndex={-1}
                    autoComplete="off"
                    style={{ position: "absolute", left: "-9999px" }}
                    aria-hidden="true"
                  />
                  {futStatus.kind === "error" && <p className="board-error">{futStatus.message}</p>}
                  <button type="submit" className="board-btn" disabled={futStatus.kind === "sending"}>
                    {futStatus.kind === "sending" ? "SENDING…" : "ASK TO HEAR BACK LATER →"}
                  </button>
                  <p className="board-fut-fine">Nothing before then. No newsletter, no spam, one recruiter.</p>
                </form>
              )}
            </>
          )}
        </div>
      )}

      <div className="board-filters">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='search: python, go -java · "machine learning" · comma = OR, minus = exclude'
          aria-label="Search roles"
        />
        <select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Filter by location">
          <option value="">all locations</option>
          {locations.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select value={office} onChange={(e) => setOffice(e.target.value)} aria-label="Filter by office type">
          <option value="">all office types</option>
          {offices.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        {types.length > 0 && (
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by role type">
            <option value="">all role types</option>
            {types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
        <select value={visaF} onChange={(e) => setVisaF(e.target.value)} aria-label="Filter by visa">
          <option value="">any visa status</option>
          <option value="Visa transfers OK">Visa transfers OK</option>
          <option value="No sponsorship">No sponsorship</option>
        </select>
      </div>

      <p className="board-count">
        {shown.length} of {roles.length} roles
        {shown.length > PAGE_SIZE ? ` · page ${page} of ${pageCount}` : ""}
      </p>

      <div className={`board-layout${railVisible ? " with-panel" : ""}`}>
        <div style={{ minWidth: 0 }}>
          <div className="board-scroll">
            <table className="board-table">
              <thead>
                <tr>
                  {HEADERS.map((h) => (
                    <th
                      key={h.key}
                      onClick={() => clickSort(h.key)}
                      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                      aria-sort={sort === h.key ? (dir === 1 ? "ascending" : "descending") : "none"}
                    >
                      {h.label}
                      <span className="board-sort">{sort === h.key ? (dir === 1 ? "▲" : "▼") : ""}</span>
                    </th>
                  ))}
                  <th className="board-apcell" style={{ whiteSpace: "nowrap" }}>Apply</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => {
                  const isSel = selected.includes(r.jobId);
                  const isOpen = expanded === r.jobId;
                  return [
                    <tr key={r.jobId} className={isOpen ? "row-open" : ""}>
                      <td className="board-id">#{r.jobId}</td>
                      <td style={{ minWidth: 220 }}>
                        <button
                          className="board-rolebtn"
                          onClick={() => {
                            if (!isOpen && recruiter) track(recruiter.id, "role_open", r.jobId);
                            setExpanded(isOpen ? null : r.jobId);
                          }}
                          aria-expanded={isOpen}
                        >
                          <span className="t">{r.title}</span>
                          <span className="d">
                            {(r.about || "").slice(0, 110)}
                            {(r.about || "").length > 110 ? "…" : ""}
                          </span>
                        </button>
                      </td>
                      <td style={{ fontSize: "12.5px", minWidth: 110 }}>
                        {r.locations.length > 3
                          ? `${r.locations.slice(0, 3).join(" · ")} +${r.locations.length - 3}`
                          : r.locations.join(" · ") || "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.workplace || "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.yoe || "—"}</td>
                      <td className="board-salary" style={{ whiteSpace: "nowrap" }}>
                        {r.salary || "On request"}
                      </td>
                      <td className="board-apcell" style={{ whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className={`board-apply-btn${isSel ? " sel" : ""}`}
                          onClick={() => toggle(r.jobId)}
                          aria-pressed={isSel}
                        >
                          {isSel ? `✓ ${selected.indexOf(r.jobId) + 1}/${MAX_ROLES}` : "APPLY +"}
                        </button>
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${r.jobId}-detail`} className="board-detail-row">
                        <td colSpan={7}>
                          <div className="board-jdcard">
                            <div className="jd-chips">
                              {r.salary && <span className="jd-chip money">{r.salary}</span>}
                              {r.locations.length > 0 && (
                                <span className="jd-chip">
                                  {r.locations.length > 3
                                    ? `${r.locations.slice(0, 3).join(" · ")} +${r.locations.length - 3}`
                                    : r.locations.join(" · ")}
                                </span>
                              )}
                              {r.workplace && <span className="jd-chip">{r.workplace}</span>}
                              {r.yoe && <span className="jd-chip">{r.yoe}</span>}
                              {r.visa && <span className="jd-chip">{visaBucket(r)}</span>}
                            </div>
                            {r.about && <p className="jd-about">{r.about}</p>}
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
                            <div className="jd-foot">
                              <button
                                type="button"
                                className="board-btn"
                                onClick={() => toggle(r.jobId)}
                              >
                                {isSel ? "✓ SELECTED · REMOVE" : "APPLY TO THIS ROLE +"}
                              </button>
                              <button
                                type="button"
                                className="jd-close"
                                onClick={() => setExpanded(null)}
                              >
                                close
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>

          {shown.length > PAGE_SIZE && (
            <div className="board-pager">
              <span>
                showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, shown.length)} of {shown.length} roles
              </span>
              <div>
                <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <button key={n} className={n === page ? "cur" : ""} onClick={() => setPage(n)}>
                    {n}
                  </button>
                ))}
                <button disabled={page === pageCount} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>
            </div>
          )}
        </div>

        {/* Checkout rail beside the table: cart on top, details beneath —
            the site's /apply layout on one page. */}
        {railVisible && (
          <aside className="board-rail" ref={railRef}>
            {status.kind === "ok" ? (
              <div className="board-thanks">
                <h2>
                  {status.alreadyApplied
                    ? "You've already applied."
                    : recruiter
                      ? "Thank you for your application."
                      : status.wasSpeculative
                        ? "Resume received."
                        : "Application received."}
                </h2>
                <p>
                  {status.alreadyApplied
                    ? "We are reviewing your application and will reach out within 48 hours."
                    : recruiter
                      ? "We will be in touch within 48 hours."
                      : status.wasSpeculative
                        ? `We'll match you against ${org.name}'s open roles — and new ones as they arrive — and be in touch when there's a genuine fit.`
                        : "Every application is screened and reviewed — you'll hear back when there's a fit."}
                </p>
                <p style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="board-linkbtn"
                    onClick={() => {
                      setStatus({ kind: "idle" });
                      setSelected([]);
                      setSpeculative(false);
                    }}
                  >
                    Submit another application
                  </button>
                </p>
                {!recruiter && !status.alreadyApplied && status.matches.length > 0 && (
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
                <div className="board-panel-label">
                  {isSpeculative ? (
                    <>GENERAL APPLICATION</>
                  ) : (
                    <>
                      <b>{selected.length}/{MAX_ROLES}</b> ROLES SELECTED
                    </>
                  )}
                </div>
                {isSpeculative ? (
                  <p className="board-instr">
                    {recruiter ? (
                      <>
                        <b>No role selected? No problem.</b> Upload your resume and we
                        will match you against our roles and reach out if we have
                        suitable matches.{" "}
                      </>
                    ) : (
                      <>
                        <b>No role selected — we&apos;ll do the matching.</b> Drop your resume and
                        we&apos;ll screen you against {org.name}&apos;s roles, now and as new ones
                        open.{" "}
                      </>
                    )}
                    <button className="board-linkbtn" onClick={() => setSpeculative(false)}>
                      back to roles
                    </button>
                  </p>
                ) : (
                  <>
                    {selectedRoles.map((r) => (
                      <div key={r.jobId} className="board-panel-role">
                        <div>
                          <div className="t">{r.title}</div>
                          <div className="m">{r.salary || "Comp on request"} · #{r.jobId}</div>
                        </div>
                        <button onClick={() => toggle(r.jobId)} aria-label={`Remove ${r.title}`}>✕</button>
                      </div>
                    ))}
                    {selected.length < MAX_ROLES && (
                      <div className="board-panel-slots">
                        + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left — hit APPLY + in the table
                      </div>
                    )}
                  </>
                )}

                <form onSubmit={onSubmit} className="board-form">
                  <h3>Your details</h3>
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
                    Resume (PDF{isSpeculative || recruiter ? ", required" : ", optional but recommended"})
                    <input
                      name="resume"
                      type="file"
                      accept="application/pdf"
                      required={isSpeculative || Boolean(recruiter)}
                    />
                  </label>
                  <label>
                    Locations you&apos;re open to (optional — ⌘/Ctrl-click; empty = your profile location)
                    <select name="preferredLocations" multiple size={4}>
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
                  <button type="submit" className="board-btn" disabled={status.kind === "sending"} style={{ width: "100%" }}>
                    {status.kind === "sending"
                      ? "SUBMITTING & MATCHING…"
                      : isSpeculative
                        ? "SUBMIT FOR MATCHING →"
                        : `SUBMIT — ${selected.length} ROLE${selected.length > 1 ? "S" : ""} →`}
                  </button>
                </form>
              </>
            )}
          </aside>
        )}
      </div>

      {recruiter && recruiter.referralAmount != null && (
        <ReferralBlock recruiterId={recruiter.id} amount={recruiter.referralAmount} />
      )}

      {/* Narrow screens: rail stacks under the table; bar jumps to it. */}
      {selected.length > 0 && status.kind === "idle" && (
        <div className="board-selbar">
          <b>{selected.length}/{MAX_ROLES} selected</b>
          <button className="board-btn" onClick={goToRail}>
            COMPLETE APPLICATION →
          </button>
        </div>
      )}

      <footer className="board-foot">
        <a href="https://www.transformertalent.com" target="_blank" rel="noreferrer">
          Powered by Transformer Talent
        </a>
      </footer>

      {hasContactActions && (
        <div className="rp-mbar">
          {contactActions}
          {recruiter && recruiter.referralAmount != null && (
            <button
              type="button"
              className="rp-abtn green"
              onClick={() => {
                track(recruiter.id, "referral_open");
                document.getElementById("refer")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              Refer
            </button>
          )}
        </div>
      )}

      {bookSrc && recruiter && (
        <div
          className="rp-bkov"
          onClick={(e) => {
            if (e.target === e.currentTarget) setBookSrc(null);
          }}
        >
          <div className="rp-bk">
            <div className="rp-bkhead">
              <b>Book a call with {recruiter.name.split(/\s+/)[0]}</b>
              <button type="button" aria-label="Close" onClick={() => setBookSrc(null)}>
                ✕
              </button>
            </div>
            <iframe src={bookSrc} title={`Book a call with ${recruiter.name}`} />
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

// The referral offer at the bottom of a recruiter page. Self-contained:
// four fields to /api/referral, generic thank-you either way (the response
// never reveals whether we already know the person).
function ReferralBlock({ recruiterId, amount }: { recruiterId: string; amount: number }) {
  const [state, setState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const data = new FormData(e.currentTarget);
    setState("sending");
    try {
      const res = await fetch("/api/referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recruiter: recruiterId,
          referrerName: data.get("referrerName"),
          referrerEmail: data.get("referrerEmail"),
          candidateLinkedin: data.get("candidateLinkedin"),
          candidateEmail: data.get("candidateEmail"),
          website: data.get("website"),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setState("ok");
      else {
        setError(json.error || "Something went wrong — please try again.");
        setState("error");
      }
    } catch {
      setError("Network error — please try again.");
      setState("error");
    }
  }

  const money = `$${amount.toLocaleString()}`;
  return (
    <section className="board-referral" id="refer">
      <h2>Not looking right now? Refer an engineer.</h2>
      <p className="board-referral-sub">
        If we place someone you refer, you receive <b>{money}</b>. Paid when
        the placement completes.
      </p>
      {state === "ok" ? (
        <div>
          <p className="board-referral-thanks">
            Thank you. We will review and be in touch.
          </p>
          <p style={{ marginTop: 10 }}>
            <button
              type="button"
              className="board-linkbtn"
              onClick={() => setState("idle")}
            >
              Refer somebody else
            </button>
          </p>
        </div>
      ) : (
        <form className="board-referral-form" onSubmit={onSubmit}>
          <label>
            Your name
            <input name="referrerName" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            Your email
            <input name="referrerEmail" type="email" required maxLength={254} autoComplete="email" />
          </label>
          <label>
            Their LinkedIn URL
            <input name="candidateLinkedin" type="url" required placeholder="https://linkedin.com/in/…" maxLength={300} />
          </label>
          <label>
            Their email
            <input name="candidateEmail" type="email" required maxLength={254} />
          </label>
          <input
            name="website"
            tabIndex={-1}
            autoComplete="off"
            style={{ position: "absolute", left: "-9999px" }}
            aria-hidden="true"
          />
          <div className="board-referral-foot">
            <button type="submit" className="board-btn" disabled={state === "sending"}>
              {state === "sending" ? "SENDING…" : `REFER THEM FOR ${money} →`}
            </button>
            {state === "error" && <span className="board-error" style={{ margin: 0 }}>{error}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
