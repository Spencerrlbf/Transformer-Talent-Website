"use client";
// Candidates v2 unified table: applicants + sourced people in one sortable,
// filterable, paginated view. Shared by the Candidates page (pool view,
// everyone visible) and the job page (role-scoped, "Not now" hidden by
// default). Role attachments live in the drawer's Pipeline tab, not here —
// a person can be on many roles. Rows open the profile drawer via onOpen.
import { useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

export type Cv2Role = {
  jobId: string;
  title: string;
  via: "applied" | "sourced";
  tag: string | null;
  tagLabel: string | null;
};

export type Cv2Row = {
  key: string;
  name: string;
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
};

type Cv2List = {
  items: Cv2Row[];
  total: number;
  counts: { all: number; applied: number; sourced: number; notNow: number };
  page: number;
  pageSize: number;
};

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
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={active ? "#4a5160" : "#d3d7dd"} strokeWidth="1.8" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);
const PhoneIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={active ? "#4a5160" : "#d3d7dd"} strokeWidth="1.8" aria-hidden>
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" />
  </svg>
);

type SortKey = "fit" | "added" | "name";

export default function CandidatesTable({
  jobId,
  defaultHideNotNow = false,
  onOpen,
  onCounts,
}: {
  jobId?: string;
  defaultHideNotNow?: boolean;
  onOpen?: (key: string) => void;
  onCounts?: (counts: Cv2List["counts"]) => void;
}) {
  const { token } = useDash();
  const [data, setData] = useState<Cv2List | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const [seg, setSeg] = useState<"" | "applied" | "sourced">("");
  const [roleFilter, setRoleFilter] = useState("");
  const [fit, setFit] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [hideNotNow, setHideNotNow] = useState(defaultHideNotNow);
  const [sort, setSort] = useState<SortKey>("fit");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const [roles, setRoles] = useState<[string, string][]>([]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Role dropdown (pool view only) from the org's jobs.
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

  useEffect(() => {
    setLoading(true);
    setError(false);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const params = new URLSearchParams();
    if (seg) params.set("source", seg);
    if (effectiveJob) params.set("job", effectiveJob);
    if (fit) params.set("fit", fit);
    if (debouncedQ) params.set("q", debouncedQ);
    if (hideNotNow) params.set("hideNotNow", "1");
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
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setError(true);
        setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, seg, effectiveJob, fit, debouncedQ, hideNotNow, sort, dir, page]);

  // Any filter change goes back to page 1.
  useEffect(() => {
    setPage(1);
  }, [seg, effectiveJob, fit, debouncedQ, hideNotNow]);

  const header = (key: SortKey, label: string) => (
    <th
      className={sort === key ? "cv2-sorted" : ""}
      onClick={() => {
        if (sort === key) setDir(dir === "desc" ? "asc" : "desc");
        else {
          setSort(key);
          setDir(key === "name" ? "asc" : "desc");
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

  return (
    <div className="cv2">
      <div className="cv2-filters">
        {pool && counts && (
          <span className="cv2-seg">
            {(
              [
                ["", `All ${counts.all + (hideNotNow ? 0 : counts.notNow)}`],
                ["applied", `Applied ${counts.applied}`],
                ["sourced", `Sourced ${counts.sourced + (hideNotNow ? 0 : counts.notNow)}`],
              ] as ["" | "applied" | "sourced", string][]
            ).map(([v, label]) => (
              <button key={v} className={seg === v ? "on" : ""} onClick={() => setSeg(v)}>
                {label}
              </button>
            ))}
          </span>
        )}
        {pool && roles.length > 0 && (
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">All roles</option>
            {roles.map(([id, title]) => (
              <option key={id} value={id}>
                {title} (#{id})
              </option>
            ))}
          </select>
        )}
        <select value={fit} onChange={(e) => setFit(e.target.value)}>
          <option value="">All fits</option>
          {FIT_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="cv2-search"
          placeholder="Search name, title or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {counts != null && counts.notNow > 0 && !fit && (
          <label className="cv2-toggle">
            <input
              type="checkbox"
              checked={hideNotNow}
              onChange={(e) => setHideNotNow(e.target.checked)}
            />
            Hide &ldquo;Not now&rdquo; ({counts.notNow})
          </label>
        )}
      </div>

      {error && <div className="dash-empty">Couldn&apos;t load candidates — refresh to retry.</div>}

      {!error && data && data.total === 0 && !loading && (
        <div className="dash-empty">
          No candidates match. Applicants appear the moment someone applies on your board; sourced
          people arrive when a sourcing run finishes.
        </div>
      )}

      {!error && data && data.total > 0 && (
        <div className="cv2-scroll">
          <table className={`cv2-table${loading ? " cv2-loading" : ""}`}>
            <thead>
              <tr>
                {header("name", "Candidate")}
                <th>Source</th>
                {header("fit", "Fit")}
                <th>Current role</th>
                <th>Company</th>
                <th>Location</th>
                <th className="cv2-th-icon">LinkedIn</th>
                <th className="cv2-th-icon">Contact</th>
                {header("added", "Added")}
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
                      <span className="cv2-avatar" style={{ background: avColor(r.name) }}>
                        {initials(r.name)}
                      </span>
                      <span className="cv2-name">
                        {r.name}
                        {r.viaTT && <span className="cv2-tt">⚡ Via Transformer Talent</span>}
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
                      <span className="dash-tag t-pending">Screening…</span>
                    )}
                  </td>
                  <td className="cv2-title">{r.currentTitle || <span className="cv2-dim">—</span>}</td>
                  <td className="cv2-company">{r.currentCompany || <span className="cv2-dim">—</span>}</td>
                  <td className="cv2-loc">{r.location || <span className="cv2-dim">—</span>}</td>
                  <td className="cv2-icons">
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
                  </td>
                  <td className="cv2-icons">
                    {r.contact.email ? (
                      <a
                        href={`mailto:${r.contact.email}`}
                        title={r.contact.email}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MailIcon active />
                      </a>
                    ) : (
                      <span title="No email — add it in the profile">
                        <MailIcon active={false} />
                      </span>
                    )}
                    {r.contact.phone ? (
                      <a
                        href={`tel:${r.contact.phone.replace(/[^\d+]/g, "")}`}
                        title={r.contact.phone}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <PhoneIcon active />
                      </a>
                    ) : (
                      <span title="No phone — add it in the profile">
                        <PhoneIcon active={false} />
                      </span>
                    )}
                  </td>
                  <td className="cv2-added">{fmtDay(r.addedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && data && data.total > 0 && (
        <div className="cv2-foot">
          <span>
            Showing {from}–{to} of {data.total}
          </span>
          {totalPages > 1 && (
            <span className="cv2-pager">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ‹
              </button>
              <span>
                Page {data.page} of {totalPages}
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                ›
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
