"use client";
// Candidates v2 unified table: applicants + sourced people in one sortable,
// filterable, paginated view. Shared by the Candidates page (pool view,
// everyone visible) and the job page (role-scoped, "Not now" hidden by
// default). Role attachments live in the drawer's Pipeline tab, not here —
// a person can be on many roles. Rows open the profile drawer via onOpen.
import { useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { downloadCsv } from "@/lib/csv";

export type Cv2Role = {
  jobId: string;
  title: string;
  via: "applied" | "sourced" | "matched";
  tag: string | null;
  tagLabel: string | null;
};

export type Cv2Row = {
  key: string;
  name: string;
  photoUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  linkedinUrl: string | null;
  contact: { email: string | null; phone: string | null };
  source: "applied" | "sourced";
  viaTT: boolean;
  alsoSourced: boolean;
  roles: Cv2Role[];
  bestTag: string | null;
  bestTagLabel: string | null;
  yearsExperience: number | null;
  addedAt: string;
  stage: string | null;
  interviewStage?: string | null;
  stageUpdatedAt?: string | null;
  screeningPending?: boolean;
  followUpAt?: string | null;
  skills?: string[] | null;
  visa?: string | null;
};

type Cv2List = {
  items: Cv2Row[];
  total: number;
  counts: { all: number; applied: number; sourced: number; notNow: number; rejected: number };
  followups?: { total: number; due: number; dueNames: string[] };
  filters?: { locations: string[]; skills: string[]; visas: string[] };
  page: number;
  pageSize: number;
};

const TODAY = new Date().toISOString().slice(0, 10);
function fuLabel(at: string): string {
  const when = new Date(`${at}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return at <= TODAY ? `Due · ${when}` : when;
}

export const STAGE_OPTIONS: [string, string][] = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["interviewing", "Interviewing"],
  ["offer", "Offer"],
  ["hired", "Hired"],
  ["rejected", "Rejected"],
];

// Stage dropdown styled as a chip. The human pipeline status — separate from
// the AI fit tag; picking Rejected moves the candidate to the job's Past tab.
export function StageSelect({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (stage: string) => void;
  busy?: boolean;
}) {
  return (
    <select
      className={`cv2-stagesel st-${value}`}
      value={value}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
    >
      {STAGE_OPTIONS.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

const TAG_CLASS: Record<string, string> = {
  strong_yes: "t-strong",
  strong: "t-strong",
  yes: "t-yes",
  possible: "t-possible",
  worth_message: "t-msg",
  stretch: "t-stretch",
  not_now: "t-notnow",
};

const FIT_OPTIONS: [string, string][] = [
  ["strong", "Strong"],
  ["yes", "Yes"],
  ["look", "Worth a look"],
  ["message", "Worth a message"],
  ["stretch", "Likely a stretch"],
  ["not_now", "Not now"],
  ["pending", "Screening…"],
];

// Proposed filters shown greyed in the menu (§9.5, approved): each needs a
// new query param on /candidates/v2 before it can go live.
const YOE_OPTIONS: [string, string][] = [
  ["0-3", "0–3 years"],
  ["4-7", "4–7 years"],
  ["8-12", "8–12 years"],
  ["13plus", "13+ years"],
];

const AV_COLORS = ["#5B7FDB", "#4CA88C", "#C4736B", "#8A6FC2", "#C99242", "#5E9DB8", "#7A8699"];
const avColor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AV_COLORS[Math.abs(h) % AV_COLORS.length];
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function RowAvatar({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!photoUrl || broken)
    return (
      <span className="cv2-avatar" style={{ background: avColor(name) }}>
        {initials(name)}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="cv2-avatar cv2-avatar-img"
      src={photoUrl}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

/* Small inline icons so nothing external is loaded. */
const InIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
    <rect width="24" height="24" rx="4" fill="#0A66C2" />
    <path
      fill="#fff"
      d="M7.1 9.4H4.9V19h2.2V9.4Zm-1.1-1c.7 0 1.3-.6 1.3-1.3 0-.7-.6-1.3-1.3-1.3-.7 0-1.3.6-1.3 1.3 0 .7.6 1.3 1.3 1.3Zm4.3 1h-2.1V19h2.2v-4.7c0-2 2.6-2.2 2.6 0V19h2.2v-5.5c0-3.4-3.7-3.3-4.9-1.6v-1.5Z"
    />
  </svg>
);
const MailIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={active ? "#4A5160" : "#D3D7DD"} strokeWidth="1.8" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);
const PhoneIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={active ? "#4A5160" : "#D3D7DD"} strokeWidth="1.8" aria-hidden>
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" />
  </svg>
);

// Contact icon: instant tooltip with the value on hover; click copies it to
// the clipboard and confirms. Greyed (no tooltip target) when nothing's on file.
function ContactIcon({
  value,
  emptyHint,
  children,
}: {
  value: string | null;
  emptyHint: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  if (!value)
    return (
      <span className="cv2-ic cv2-ic-empty">
        {children}
        <span className="cv2-tip">{emptyHint}</span>
      </span>
    );
  return (
    <button
      className="cv2-ic"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {children}
      <span className={`cv2-tip${copied ? " cv2-tip-ok" : ""}`}>
        {copied ? "Copied ✓" : `${value} — click to copy`}
      </span>
    </button>
  );
}

type SortKey = "fit" | "added" | "name" | "followup";
const SORT_LABEL: Record<SortKey, string> = {
  fit: "fit",
  added: "date added",
  name: "name",
  followup: "reach-out date",
};

export default function CandidatesTable({
  jobId,
  defaultHideNotNow = false,
  past = false,
  refreshKey = 0,
  onOpen,
  onCounts,
  onRestored,
  onKeys,
}: {
  jobId?: string;
  defaultHideNotNow?: boolean;
  /** With jobId: show ONLY rejected candidates (the Past tab) + a Restore action. */
  past?: boolean;
  /** Bump to force a refetch (e.g. a restore happened in the Past tab). */
  refreshKey?: number;
  onOpen?: (key: string) => void;
  onCounts?: (counts: Cv2List["counts"]) => void;
  onRestored?: () => void;
  /** Current page's row keys in display order — drives drawer prev/next. */
  onKeys?: (keys: string[]) => void;
}) {
  const { token } = useDash();
  const [data, setData] = useState<Cv2List | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const [seg, setSeg] = useState<"" | "applied" | "sourced" | "followups">("");
  const [roleFilter, setRoleFilter] = useState("");
  const [fit, setFit] = useState("");
  const [loc, setLoc] = useState("");
  const [stageF, setStageF] = useState("");
  const [yoe, setYoe] = useState("");
  const [skill, setSkill] = useState("");
  const [visa, setVisa] = useState("");
  const [exporting, setExporting] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [hideNotNow, setHideNotNow] = useState(defaultHideNotNow);
  const [sort, setSort] = useState<SortKey>("fit");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [bump, setBump] = useState(0); // refetch trigger (stage → rejected)
  const [savingStage, setSavingStage] = useState<string | null>(null);

  const [roles, setRoles] = useState<[string, string][]>([]);

  // One Filters control (§2.3): button opens a grouped menu; a live row opens
  // its option pane; active filters render as chips below the row.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPane, setMenuPane] = useState<
    "" | "role" | "fit" | "loc" | "stage" | "yoe" | "skill" | "visa"
  >("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setMenuPane("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Role pane options (pool view only) from the org's jobs.
  useEffect(() => {
    if (jobId) return;
    fetch("/api/dashboard/jobs", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { jobs?: { id: string; title: string }[] } | null) => {
        setRoles((j?.jobs || []).map((r) => [r.id, r.title]));
      })
      .catch(() => {});
  }, [token, jobId]);

  const effectiveJob = jobId || roleFilter;
  const abortRef = useRef<AbortController | null>(null);
  // Poll-triggered refetches skip the loading dim so the table doesn't
  // flicker while it quietly re-asks.
  const silentRef = useRef(false);
  const pollCount = useRef(0);

  useEffect(() => {
    setLoading(!silentRef.current);
    silentRef.current = false;
    setError(false);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const params = new URLSearchParams();
    if (seg === "followups") params.set("followups", "1");
    else if (seg) params.set("source", seg);
    if (effectiveJob) params.set("job", effectiveJob);
    if (fit) params.set("fit", fit);
    if (loc) params.set("loc", loc);
    if (stageF) params.set("stage", stageF);
    if (yoe) params.set("yoe", yoe);
    if (skill) params.set("skill", skill);
    if (visa) params.set("visa", visa);
    if (debouncedQ) params.set("q", debouncedQ);
    if (hideNotNow && !past) params.set("hideNotNow", "1");
    if (past) params.set("past", "1");
    params.set("sort", sort);
    params.set("dir", dir);
    params.set("page", String(page));
    fetch(`/api/dashboard/candidates/v2?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Cv2List>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
        onCounts?.(d.counts);
        onKeys?.(d.items.map((r) => r.key));
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(true);
        setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, seg, effectiveJob, fit, loc, stageF, yoe, skill, visa, debouncedQ, hideNotNow, sort, dir, page, bump, past, refreshKey]);

  // Self-refresh, two speeds. Fast (10s): an applicant on screen is still
  // mid-pipeline ("Screening…"), so refetch until it settles — capped so a
  // stuck row can't poll forever; filter changes reset the cap. Ambient
  // (45s): a lead that arrives AFTER the page loaded should appear on its
  // own, so the visible tab re-checks quietly even when nothing is pending.
  useEffect(() => {
    if (!data) return;
    const pending = data.items.some((r) => r.source === "applied" && r.screeningPending);
    const fast = pending && pollCount.current < 30;
    const t = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      if (fast) pollCount.current += 1;
      silentRef.current = true;
      setBump((b) => b + 1);
    }, fast ? 10000 : 45000);
    return () => clearTimeout(t);
  }, [data]);
  useEffect(() => {
    pollCount.current = 0;
  }, [seg, effectiveJob, fit, loc, stageF, yoe, skill, visa, debouncedQ, hideNotNow, past]);
  // Coming back to a background tab: catch up immediately.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      silentRef.current = true;
      setBump((b) => b + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Past tab: put a rejected candidate back into the active pipeline.
  async function restore(key: string) {
    if (!jobId) return;
    setSavingStage(key);
    const res = await fetch(`/api/dashboard/candidates/v2/${key}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId, status: "new" }),
    }).catch(() => null);
    setSavingStage(null);
    if (res?.ok) {
      setBump((b) => b + 1);
      onRestored?.();
    }
  }

  // Save a row's stage; Rejected refetches so the row moves to Past.
  async function changeStage(key: string, stage: string) {
    if (!jobId || !data) return;
    const prev = data.items.find((r) => r.key === key)?.stage ?? "new";
    setSavingStage(key);
    setData({
      ...data,
      items: data.items.map((r) => (r.key === key ? { ...r, stage } : r)),
    });
    const res = await fetch(`/api/dashboard/candidates/v2/${key}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId, status: stage }),
    }).catch(() => null);
    setSavingStage(null);
    if (!res?.ok) {
      setData((d) =>
        d ? { ...d, items: d.items.map((r) => (r.key === key ? { ...r, stage: prev } : r)) } : d
      );
      return;
    }
    if (stage === "rejected") setBump((b) => b + 1);
  }

  // Any filter change goes back to page 1.
  useEffect(() => {
    setPage(1);
  }, [seg, effectiveJob, fit, loc, stageF, yoe, skill, visa, debouncedQ, hideNotNow]);

  // Download the CURRENT filtered view (all pages) as a CSV — the stop-gap
  // for people carrying data into an ATS until a real integration exists.
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const all: Cv2Row[] = [];
      for (let p = 1; p <= 50; p++) {
        const params = new URLSearchParams();
        if (seg === "followups") params.set("followups", "1");
        else if (seg) params.set("source", seg);
        if (effectiveJob) params.set("job", effectiveJob);
        if (fit) params.set("fit", fit);
        if (loc) params.set("loc", loc);
        if (stageF) params.set("stage", stageF);
        if (yoe) params.set("yoe", yoe);
        if (skill) params.set("skill", skill);
        if (visa) params.set("visa", visa);
        if (debouncedQ) params.set("q", debouncedQ);
        if (hideNotNow && !past) params.set("hideNotNow", "1");
        if (past) params.set("past", "1");
        params.set("sort", sort);
        params.set("dir", dir);
        params.set("page", String(p));
        params.set("pageSize", "100");
        const res = await fetch(`/api/dashboard/candidates/v2?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as Cv2List;
        all.push(...d.items);
        if (all.length >= d.total || d.items.length === 0) break;
      }
      const header = [
        "Name",
        "Current title",
        "Company",
        "Location",
        "Years of experience",
        "Email",
        "Phone",
        "LinkedIn",
        "Source",
        "Fit",
        "Roles",
        ...(jobId ? ["Stage"] : []),
        "Skills",
        "Visa",
        "Follow up",
        "Added",
      ];
      const rows = all.map((r) => [
        r.name,
        r.currentTitle,
        r.currentCompany,
        r.location,
        r.yearsExperience,
        r.contact.email,
        r.contact.phone,
        r.linkedinUrl,
        r.source,
        r.bestTagLabel,
        r.roles.map((x) => x.title).join("; "),
        ...(jobId ? [r.stage || "new"] : []),
        (r.skills || []).join("; "),
        r.visa,
        r.followUpAt,
        r.addedAt.slice(0, 10),
      ]);
      const day = new Date().toISOString().slice(0, 10);
      downloadCsv(jobId ? `applicants-job-${jobId}-${day}.csv` : `candidates-${day}.csv`, header, rows);
    } catch {
      // No toast system here; the button simply re-enables for a retry.
    } finally {
      setExporting(false);
    }
  }

  const header = (key: SortKey, label: string, cls?: string) => (
    <th
      className={`${cls || ""}${sort === key ? " cv2-sorted" : ""}`}
      onClick={() => {
        if (sort === key) setDir(dir === "desc" ? "asc" : "desc");
        else {
          setSort(key);
          // Dates and names read soonest/A-first; everything else best-first.
          setDir(key === "name" || key === "followup" ? "asc" : "desc");
        }
      }}
    >
      {label}
      {sort === key ? (dir === "desc" ? " ▾" : " ▴") : ""}
    </th>
  );

  const counts = data?.counts;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const from = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  const pool = !jobId;
  const roleTitle = roles.find(([id]) => id === roleFilter)?.[1] || "";
  const fitLabel = FIT_OPTIONS.find(([v]) => v === fit)?.[1] || "";
  const stageLabel = STAGE_OPTIONS.find(([v]) => v === stageF)?.[1] || "";
  const yoeLabel = YOE_OPTIONS.find(([v]) => v === yoe)?.[1] || "";
  const activeCount = [roleFilter && pool, fit, loc, stageF, yoe, skill, visa, hideNotNow && !past].filter(
    Boolean
  ).length;

  const menuRow = (label: string, value: string, onClick: () => void) => (
    <div className="row" role="button" tabIndex={0} onClick={onClick}>
      {label}
      <span className="val">{value}</span>
      <span className="car">›</span>
    </div>
  );

  const paneOption = (label: string, on: boolean, pick: () => void) => (
    <div key={label} className={`row${on ? " onopt" : ""}`} role="button" onClick={pick}>
      {label}
      {on && <span className="val">✓</span>}
    </div>
  );

  return (
    <div className="cv2">
      <div className="cv2-filters">
        {pool && counts && (
          <span className="dash-seg">
            {(
              [
                ["", `All ${counts.all + (hideNotNow ? 0 : counts.notNow)}`],
                ["applied", `Applied ${counts.applied}`],
                ["sourced", `Sourced ${counts.sourced + (hideNotNow ? 0 : counts.notNow)}`],
              ] as ["" | "applied" | "sourced" | "followups", string][]
            ).map(([v, label]) => (
              <button key={v} className={seg === v ? "on" : ""} onClick={() => setSeg(v)}>
                {label}
              </button>
            ))}
          </span>
        )}

        <div className="dash-filters-wrap" ref={menuRef}>
          <button
            type="button"
            className="dash-filters-btn"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen(!menuOpen);
              setMenuPane("");
            }}
          >
            ☰ Filters
            {activeCount > 0 && <span className="count">{activeCount}</span>}
            <span aria-hidden>▾</span>
          </button>
          {menuOpen && (
            <div className="dash-filters-menu">
              {menuPane === "" && (
                <>
                  <div className="head">Add filter…</div>
                  <div className="group">Filters</div>
                  {pool &&
                    roles.length > 0 &&
                    menuRow("Role", roleTitle || "Any", () => setMenuPane("role"))}
                  {menuRow("Fit", fitLabel || "Any", () => setMenuPane("fit"))}
                  {!past &&
                    (counts?.notNow ?? 0) > 0 &&
                    menuRow("“Not now”", hideNotNow ? "Hidden" : "Shown", () =>
                      setHideNotNow(!hideNotNow)
                    )}
                  {menuRow("Stage", stageLabel || "Any", () => setMenuPane("stage"))}
                  {!!(data?.filters?.locations.length || loc) &&
                    menuRow("Location", loc || "Any", () => setMenuPane("loc"))}
                  {menuRow("Years of experience", yoeLabel || "Any", () => setMenuPane("yoe"))}
                  {!!(data?.filters?.skills.length || skill) &&
                    menuRow("Skills", skill || "Any", () => setMenuPane("skill"))}
                  {!!(data?.filters?.visas.length || visa) &&
                    menuRow("Visa", visa || "Any", () => setMenuPane("visa"))}
                </>
              )}
              {menuPane === "stage" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Stage
                  </div>
                  {paneOption("Any", !stageF, () => {
                    setStageF("");
                    setMenuOpen(false);
                  })}
                  {STAGE_OPTIONS.map(([v, label]) =>
                    paneOption(label, stageF === v, () => {
                      setStageF(v);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "loc" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Location
                  </div>
                  {paneOption("Any", !loc, () => {
                    setLoc("");
                    setMenuOpen(false);
                  })}
                  {(data?.filters?.locations || []).map((v) =>
                    paneOption(v, loc === v, () => {
                      setLoc(v);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "yoe" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Years of experience
                  </div>
                  {paneOption("Any", !yoe, () => {
                    setYoe("");
                    setMenuOpen(false);
                  })}
                  {YOE_OPTIONS.map(([v, label]) =>
                    paneOption(label, yoe === v, () => {
                      setYoe(v);
                      setMenuOpen(false);
                    })
                  )}
                  <div className="note">Years come from enrichment; people without a value are left out.</div>
                </>
              )}
              {menuPane === "skill" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Skills
                  </div>
                  {paneOption("Any", !skill, () => {
                    setSkill("");
                    setMenuOpen(false);
                  })}
                  {(data?.filters?.skills || []).map((v) =>
                    paneOption(v, skill === v, () => {
                      setSkill(v);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "visa" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Visa
                  </div>
                  {paneOption("Any", !visa, () => {
                    setVisa("");
                    setMenuOpen(false);
                  })}
                  {(data?.filters?.visas || []).map((v) =>
                    paneOption(v, visa === v, () => {
                      setVisa(v);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "role" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Role
                  </div>
                  {paneOption("Any", !roleFilter, () => {
                    setRoleFilter("");
                    setMenuOpen(false);
                  })}
                  {roles.map(([id, title]) =>
                    paneOption(`${title} (#${id})`, roleFilter === id, () => {
                      setRoleFilter(id);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "fit" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Fit
                  </div>
                  {paneOption("Any", !fit, () => {
                    setFit("");
                    setMenuOpen(false);
                  })}
                  {FIT_OPTIONS.map(([v, label]) =>
                    paneOption(label, fit === v, () => {
                      setFit(v);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <input
          className="cv2-search"
          placeholder="Search candidates by name, title or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="dash-sortnote">Sorted by {SORT_LABEL[sort]}</span>
        <button
          type="button"
          className="dash-filters-btn cv2-export"
          onClick={exportCsv}
          disabled={exporting || !data || data.total === 0}
          title="Download the current view as a CSV"
        >
          {exporting ? "Preparing…" : "⇩ CSV"}
        </button>
      </div>

      {activeCount > 0 && (
        <div className="dash-chips">
          {pool && roleFilter && (
            <span className="dash-chip">
              Role: <b>{roleTitle || `#${roleFilter}`}</b>
              <button type="button" aria-label="Clear role filter" onClick={() => setRoleFilter("")}>
                ✕
              </button>
            </span>
          )}
          {fit && (
            <span className="dash-chip">
              Fit: <b>{fitLabel}</b>
              <button type="button" aria-label="Clear fit filter" onClick={() => setFit("")}>
                ✕
              </button>
            </span>
          )}
          {stageF && (
            <span className="dash-chip">
              Stage: <b>{stageLabel}</b>
              <button type="button" aria-label="Clear stage filter" onClick={() => setStageF("")}>
                ✕
              </button>
            </span>
          )}
          {loc && (
            <span className="dash-chip">
              Location: <b>{loc}</b>
              <button type="button" aria-label="Clear location filter" onClick={() => setLoc("")}>
                ✕
              </button>
            </span>
          )}
          {yoe && (
            <span className="dash-chip">
              Years: <b>{yoeLabel}</b>
              <button type="button" aria-label="Clear years filter" onClick={() => setYoe("")}>
                ✕
              </button>
            </span>
          )}
          {skill && (
            <span className="dash-chip">
              Skill: <b>{skill}</b>
              <button type="button" aria-label="Clear skill filter" onClick={() => setSkill("")}>
                ✕
              </button>
            </span>
          )}
          {visa && (
            <span className="dash-chip">
              Visa: <b>{visa}</b>
              <button type="button" aria-label="Clear visa filter" onClick={() => setVisa("")}>
                ✕
              </button>
            </span>
          )}
          {hideNotNow && !past && (
            <span className="dash-chip">
              “Not now”: <b>Hidden{counts ? ` (${counts.notNow})` : ""}</b>
              <button type="button" aria-label="Show Not now" onClick={() => setHideNotNow(false)}>
                ✕
              </button>
            </span>
          )}
          <button
            type="button"
            className="clear"
            onClick={() => {
              setRoleFilter("");
              setFit("");
              setLoc("");
              setStageF("");
              setYoe("");
              setSkill("");
              setVisa("");
              setHideNotNow(past ? hideNotNow : false);
            }}
          >
            Clear all
          </button>
        </div>
      )}

      {error && <div className="dash-empty">Couldn&apos;t load candidates — refresh to retry.</div>}

      {!error && data && data.total === 0 && !loading && (
        <div className="dash-empty">
          {past
            ? "No past candidates. Set someone's stage to “Rejected” in the Pipeline tab and they move here — profile and reviews kept."
            : "No candidates match. Applicants appear the moment someone applies on your board; sourced people arrive when a sourcing run finishes."}
        </div>
      )}

      {!error && data && data.total > 0 && (
        <div className="cv2-scroll">
          <table className={`cv2-table${loading ? " cv2-loading" : ""}`}>
            <thead>
              <tr>
                {header("name", "Candidate")}
                <th className="w-src">Source</th>
                {header("fit", "Fit", "w-fit")}
                {jobId && <th className="w-stage">{past ? "" : "Stage"}</th>}
                <th>Current role</th>
                <th>Company</th>
                <th>Location</th>
                <th className="cv2-th-icon w-in">LinkedIn</th>
                <th className="cv2-th-icon w-ct">Contact</th>
                {pool && header("followup", "Reach out", "w-fu")}
                {header("added", "Added", "w-added")}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr
                  key={r.key}
                  className={onOpen ? "cv2-click" : ""}
                  onClick={() => onOpen?.(r.key)}
                >
                  <td>
                    <span className="cv2-cand">
                      <RowAvatar photoUrl={r.photoUrl} name={r.name} />
                      <span className="cv2-name">
                        {r.name}
                        {r.viaTT && <span className="cv2-via">Via TT</span>}
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className={`cv2-src cv2-src-${r.source}`}>
                      <i />
                      {r.source === "applied" ? "Applied" : "Sourced"}
                    </span>
                  </td>
                  <td>
                    {r.bestTag ? (
                      <span className={`dash-tag ${TAG_CLASS[r.bestTag] || "t-pending"}`}>
                        {r.bestTagLabel}
                      </span>
                    ) : (
                      <span
                        className="dash-tag t-pending"
                        title={
                          r.screeningPending === false
                            ? "Screening finished — no open role matched strongly enough to run a full screen."
                            : undefined
                        }
                      >
                        {r.screeningPending === false ? "No role match" : "Screening…"}
                      </span>
                    )}
                  </td>
                  {jobId && (
                    <td className="cv2-stagecell" onClick={(e) => e.stopPropagation()}>
                      {past ? (
                        <button
                          className="cv2-restore"
                          disabled={savingStage === r.key}
                          title="Move back to the active pipeline (stage: New)"
                          onClick={() => restore(r.key)}
                        >
                          {savingStage === r.key ? "Restoring…" : "↩ Restore"}
                        </button>
                      ) : (
                        <StageSelect
                          value={r.stage || "new"}
                          busy={savingStage === r.key}
                          onChange={(s) => changeStage(r.key, s)}
                        />
                      )}
                    </td>
                  )}
                  <td className="cv2-rolecell">
                    <div className="cv2-role-t">
                      {r.currentTitle || <span className="cv2-dim">—</span>}
                    </div>
                  </td>
                  <td className="cv2-company">
                    {r.currentCompany || <span className="cv2-dim">—</span>}
                  </td>
                  <td className="cv2-loc">
                    {r.location || <span className="cv2-dim">—</span>}
                  </td>
                  <td className="cv2-icons">
                    <span className="cv2-icwrap">
                      {r.linkedinUrl ? (
                        <a
                          href={r.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="Open LinkedIn profile"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <InIcon />
                        </a>
                      ) : (
                        <span className="cv2-ic-off" title="No LinkedIn on file">
                          <InIcon />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="cv2-icons">
                    <span className="cv2-icwrap">
                      <ContactIcon value={r.contact.email} emptyHint="No email — add it in the profile">
                        <MailIcon active={!!r.contact.email} />
                      </ContactIcon>
                      <ContactIcon value={r.contact.phone} emptyHint="No phone — add it in the profile">
                        <PhoneIcon active={!!r.contact.phone} />
                      </ContactIcon>
                    </span>
                  </td>
                  {pool && (
                    <td className="cv2-reach">
                      {r.followUpAt ? (
                        <span className={`cv2-fu${r.followUpAt <= TODAY ? " due" : ""}`}>
                          {fuLabel(r.followUpAt)}
                        </span>
                      ) : (
                        <span className="cv2-dim">—</span>
                      )}
                    </td>
                  )}
                  <td className="cv2-added">{fmtDay(r.addedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && data && data.total > 0 && (
        <div className="pager">
          <span>
            Showing {from}–{to} of {data.total}
          </span>
          {totalPages > 1 && (
            <span className="pages">
              <button className="pg-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ‹
              </button>
              <span className="pg-label">
                Page {data.page} of {totalPages}
              </span>
              <button
                className="pg-btn"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                ›
              </button>
            </span>
          )}
        </div>
      )}

      {pool && !past && !error && data && data.total > 0 && (
        <p className="cv2-caption">
          Fit tags come from screening and stay client-safe — a tag and a plain-English reason,
          never the underlying scorecard. Contact icons copy on click; greyed means nothing on
          file. &ldquo;Via TT&rdquo; marks someone who came through the Transformer Talent network.
        </p>
      )}
    </div>
  );
}
