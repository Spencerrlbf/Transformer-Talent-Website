// Shared client types for the sourcing UI. Mirrors the API payloads —
// client-safe fields only.
export type QueryDraft = {
  currentJobTitles: string[];
  locations: string[];
  currentCompanies: string[]; // LinkedIn company URLs
  companyLabels: Record<string, string>; // url -> display name (client-only)
  pastCompanies: string[];
  search: string;
  schools: string[];
  yearsOfExperienceIds: string[];
  companyHeadcount: string[];
  excludeCurrentCompanies: string[];
  excludeLocations: string[];
};

export const emptyQuery = (jobTitle?: string): QueryDraft => ({
  currentJobTitles: jobTitle ? [jobTitle] : [],
  locations: [],
  currentCompanies: [],
  companyLabels: {},
  pastCompanies: [],
  search: "",
  schools: [],
  yearsOfExperienceIds: [],
  companyHeadcount: [],
  excludeCurrentCompanies: [],
  excludeLocations: [],
});

/** API body from a draft (drops the client-only label map + empties). */
export function queryFromDraft(d: QueryDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (k: string, v: string[] | string) => {
    if (Array.isArray(v) ? v.length : v.trim()) body[k] = v;
  };
  put("currentJobTitles", d.currentJobTitles);
  put("locations", d.locations);
  put("currentCompanies", d.currentCompanies);
  put("pastCompanies", d.pastCompanies);
  put("search", d.search);
  put("schools", d.schools);
  put("yearsOfExperienceIds", d.yearsOfExperienceIds);
  put("companyHeadcount", d.companyHeadcount);
  put("excludeCurrentCompanies", d.excludeCurrentCompanies);
  put("excludeLocations", d.excludeLocations);
  // Display names for picked companies ride along with the search: run
  // summaries and the judge's "targeted companies" context both read them.
  const labels: Record<string, string> = {};
  for (const url of [...d.currentCompanies, ...d.pastCompanies, ...d.excludeCurrentCompanies]) {
    if (d.companyLabels[url]) labels[url] = d.companyLabels[url];
  }
  if (Object.keys(labels).length) body.companyLabels = labels;
  return body;
}

/** Rebuild an editable draft from a stored run's search_params. */
export function draftFromParams(p: Record<string, unknown>): QueryDraft {
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  return {
    currentJobTitles: list(p.currentJobTitles),
    locations: list(p.locations),
    currentCompanies: list(p.currentCompanies),
    companyLabels: (p.companyLabels && typeof p.companyLabels === "object" ? p.companyLabels : {}) as Record<string, string>,
    pastCompanies: list(p.pastCompanies),
    search: typeof p.search === "string" ? p.search : "",
    schools: list(p.schools),
    yearsOfExperienceIds: list(p.yearsOfExperienceIds),
    companyHeadcount: list(p.companyHeadcount),
    excludeCurrentCompanies: list(p.excludeCurrentCompanies),
    excludeLocations: list(p.excludeLocations),
  };
}

export type RunSummary = {
  id: string;
  status: string;
  error?: string | null;
  search_params: Record<string, unknown>;
  match_estimate: number | null;
  pages_fetched: number;
  imported_count: number;
  duplicate_count: number;
  screened_count: number;
  screen_target: number;
  next_attempt_at?: string | null;
  unreviewable?: number;
  created_at: string;
  finished_at: string | null;
  org_roles?: { external_id: string; title: string };
};

export type CandidateRow = {
  membershipId: string;
  rank: number | null;
  tag: "strong" | "possible" | "stretch" | "strong_yes" | "yes" | "worth_message" | "not_now" | null;
  reason: string | null;
  screenStatus: string;
  shortlisted: boolean;
  hidden: boolean;
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
};

export const TAG_UI: Record<string, { label: string; cls: string }> = {
  // 4-tier outreach scale (EM judge)
  strong_yes: { label: "Strong yes", cls: "t-strong" },
  yes: { label: "Yes", cls: "t-yes" },
  worth_message: { label: "Worth a message", cls: "t-possible" },
  not_now: { label: "Not now", cls: "t-stretch" },
  // legacy 3-tier (older runs keep rendering)
  strong: { label: "Strong fit", cls: "t-strong" },
  possible: { label: "Worth a look", cls: "t-possible" },
  stretch: { label: "Likely a stretch", cls: "t-stretch" },
};

/** One-line human summary of a run's search, for the runs list. */
export function summarizeParams(p: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const labels = (p.companyLabels && typeof p.companyLabels === "object" ? p.companyLabels : {}) as Record<string, string>;
  const companyName = (url: string) =>
    labels[url] || url.replace(/\/$/, "").split("/").pop()?.replace(/-/g, " ") || url;
  const parts = [
    list(p.currentJobTitles).slice(0, 3).join(", "),
    list(p.locations).slice(0, 2).join(", "),
    list(p.currentCompanies).concat(list(p.pastCompanies)).slice(0, 3).map(companyName).join(" + "),
    typeof p.search === "string" && p.search ? `“${p.search.slice(0, 40)}”` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "All filters empty";
}
