// Harvest API provider for the sourcing module. This file is the ONLY place
// that knows Harvest exists — the pipeline calls searchLeadsPage /
// previewLeadCount / getFullProfile / searchCompanies and never sees HTTP.
// Ported from the proven Recruitment-Automation-Sourcing providers
// (harvest-lead-search.ts, harvest-profile.ts, company-lookup.ts), trimmed
// to this repo's conventions.
//
// Mode: SOURCING_PROVIDER_MODE=mock forces deterministic fake data (build
// and test the pipeline/UI without spending credits). Default is live when
// HARVEST_API_KEY is set, mock otherwise.
//
// Rate limits (docs.harvestapi.io/guides/concurrency): no per-minute caps —
// plans cap CONCURRENT requests (Starter 5 … Business 40) with a 10-deep
// queue. Callers must bound their own concurrency; see Task 4's pipeline.

const BASE = "https://api.harvestapi.io";

export type ProviderMode = "live" | "mock";

export function providerMode(): ProviderMode {
  const forced = (process.env.SOURCING_PROVIDER_MODE || "").trim().toLowerCase();
  if (forced === "mock") return "mock";
  if (forced === "live") return "live";
  return process.env.HARVEST_API_KEY ? "live" : "mock";
}

function apiKey(): string {
  const key = (process.env.HARVEST_API_KEY || "").trim();
  if (!key) throw new Error("HARVEST_API_KEY is not set (or use SOURCING_PROVIDER_MODE=mock)");
  return key;
}

async function harvestGet(path: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}?${params.toString()}`, {
    headers: { "X-API-Key": apiKey() },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`harvest ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  // Harvest wraps some errors inside 200 responses — callers check shapes.
  return (await res.json()) as Record<string, unknown>;
}

// ---------- tiny value helpers (same defensive style as the RAS port) ----------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];

/**
 * linkedin.com/in/<username>. Lead-search URLs often carry a hashed member
 * URN ("ACwAA…") instead of the public handle — those are NOT usernames
 * (the real one arrives with the full profile), so we return null for them.
 * Pre-fetch dedupe must key on Lead.memberId instead.
 */
export function linkedinUsernameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  const handle = decodeURIComponent(m[1]).toLowerCase();
  return /^acwaa/i.test(handle) ? null : handle;
}

// ---------- lead search (/linkedin/lead-search) ----------

// Full pass-through of Harvest's Sales-Nav-grade filters. All optional;
// company filters want LinkedIn company URLs (resolve via searchCompanies).
export interface LeadSearchQuery {
  search?: string;
  currentJobTitles?: string[];
  pastJobTitles?: string[];
  locations?: string[];
  geoIds?: string[];
  currentCompanies?: string[];
  pastCompanies?: string[];
  schools?: string[];
  industryIds?: string[];
  functionIds?: string[];
  seniorityLevelIds?: string[];
  yearsOfExperienceIds?: string[];
  yearsAtCurrentCompanyIds?: string[];
  companyHeadcount?: string[];
  companyHeadquarterLocations?: string[];
  profileLanguages?: string[];
  firstNames?: string[];
  lastNames?: string[];
  excludeLocations?: string[];
  excludeGeoIds?: string[];
  excludeCurrentCompanies?: string[];
  excludePastCompanies?: string[];
  excludeSchools?: string[];
  excludeCurrentJobTitles?: string[];
  excludePastJobTitles?: string[];
  excludeIndustryIds?: string[];
  excludeSeniorityLevelIds?: string[];
  excludeFunctionIds?: string[];
  excludeCompanyHeadquarterLocations?: string[];
  recentlyChangedJobs?: boolean;
  postedOnLinkedin?: boolean;
  salesNavUrl?: string;
}

export interface Lead {
  fullName: string;
  /** Stable hashed LinkedIn member id ("ACwAA…") — the pre-fetch dedupe key. */
  memberId: string | null;
  /** Public handle when the search exposed one; usually null until the full profile is fetched. */
  linkedinUsername: string | null;
  linkedinUrl: string;
  currentTitle: string | null;
  currentCompany: string | null;
  currentCompanyLinkedinUrl: string | null;
  headline: string | null;
  location: string | null;
  summary: string | null;
  raw: Record<string, unknown>;
}

export interface LeadPage {
  leads: Lead[];
  page: number;
  pageSize: number | null;
  totalElements: number | null;
  totalPages: number | null;
}

const LIST_KEYS = [
  "currentJobTitles", "pastJobTitles", "locations", "geoIds", "currentCompanies",
  "pastCompanies", "schools", "industryIds", "functionIds", "seniorityLevelIds",
  "yearsOfExperienceIds", "yearsAtCurrentCompanyIds", "companyHeadcount",
  "companyHeadquarterLocations", "profileLanguages", "firstNames", "lastNames",
  "excludeLocations", "excludeGeoIds", "excludeCurrentCompanies", "excludePastCompanies",
  "excludeSchools", "excludeCurrentJobTitles", "excludePastJobTitles", "excludeIndustryIds",
  "excludeSeniorityLevelIds", "excludeFunctionIds", "excludeCompanyHeadquarterLocations",
] as const;

function leadSearchParams(query: LeadSearchQuery, page: number): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.salesNavUrl?.trim()) params.set("salesNavUrl", query.salesNavUrl.trim());
  for (const key of LIST_KEYS) {
    const values = (query[key] || []).map((v) => v.trim()).filter(Boolean);
    if (values.length) params.set(key, [...new Set(values)].join(","));
  }
  if (query.recentlyChangedJobs) params.set("recentlyChangedJobs", "true");
  if (query.postedOnLinkedin) params.set("postedOnLinkedin", "true");
  params.set("page", String(Math.max(1, Math.trunc(page))));
  return params;
}

function mapLead(lead: Record<string, unknown>): Lead | null {
  const linkedinUrl = str(lead.linkedinUrl);
  const memberId = str(lead.id);
  const username = linkedinUsernameFromUrl(linkedinUrl);
  if (!linkedinUrl || (!memberId && !username)) return null;
  const fullName =
    [str(lead.firstName), str(lead.lastName)].filter(Boolean).join(" ").trim() || str(lead.name);
  if (!fullName) return null;
  const position = arr(lead.currentPositions)[0] ?? null;
  const currentTitle = str(position?.title) || str(position?.position) || str(lead.position);
  const currentCompany = str(position?.companyName);
  return {
    fullName,
    memberId,
    linkedinUsername: username,
    linkedinUrl: username ? `https://www.linkedin.com/in/${username}/` : linkedinUrl,
    currentTitle,
    currentCompany,
    currentCompanyLinkedinUrl: str(position?.companyLinkedinUrl),
    headline: str(lead.headline) || [currentTitle, currentCompany].filter(Boolean).join(" at ") || null,
    location: str(obj(lead.location)?.linkedinText) || str(lead.location),
    summary: str(lead.summary),
    raw: lead,
  };
}

function mapLeadPage(payload: Record<string, unknown>, page: number): LeadPage {
  const pagination = obj(payload.pagination);
  return {
    leads: arr(payload.elements).map(mapLead).filter((l): l is Lead => !!l),
    page: num(pagination?.pageNumber) ?? page,
    pageSize: num(pagination?.pageSize),
    totalElements: num(pagination?.totalElements),
    totalPages: num(pagination?.totalPages),
  };
}

/** One page (~25 leads) of the lead search. The pipeline loops pages. */
export async function searchLeadsPage(query: LeadSearchQuery, page = 1): Promise<LeadPage> {
  if (providerMode() === "mock") return mockLeadPage(query, page);
  const payload = await harvestGet("/linkedin/lead-search", leadSearchParams(query, page));
  return mapLeadPage(payload, page);
}

/** Preview: page 1 only (one metered search-page request) → total count. */
export async function previewLeadCount(
  query: LeadSearchQuery
): Promise<{ total: number | null; totalPages: number | null; sample: Lead[] }> {
  const first = await searchLeadsPage(query, 1);
  return { total: first.totalElements, totalPages: first.totalPages, sample: first.leads.slice(0, 5) };
}

// ---------- full profile (/linkedin/profile) ----------

/**
 * Full profile payload (experience, education, skills) for one person.
 * Returns Harvest's `element` object — the same shape the site's apply-flow
 * enrichment stores, so downstream facts/screening helpers work unchanged.
 */
export async function getFullProfile(linkedinUrl: string): Promise<Record<string, unknown> | null> {
  if (providerMode() === "mock") return mockProfile(linkedinUrl);
  const payload = await harvestGet("/linkedin/profile", new URLSearchParams({ url: linkedinUrl }));
  const element = obj(payload.element) ?? payload;
  // Harvest wraps errors in 200s — require a real profile shape.
  if (!element || (!element.experience && !element.headline && !element.firstName)) return null;
  return element;
}

// ---------- company search (/linkedin/company-search) ----------

export interface CompanyHit {
  name: string;
  linkedinUrl: string;
  universalName: string | null;
  location: string | null;
  logo: string | null;
  followers: number | null;
}

/** Name → LinkedIn companies, for the ideal-companies typeahead. */
export async function searchCompanies(search: string, limit = 8): Promise<CompanyHit[]> {
  if (providerMode() === "mock") return mockCompanies(search, limit);
  const payload = await harvestGet(
    "/linkedin/company-search",
    new URLSearchParams({ search: search.trim(), page: "1" })
  );
  return arr(payload.elements)
    .flatMap((c) => {
      const name = str(c.name);
      const linkedinUrl = str(c.linkedinUrl);
      if (!name || !linkedinUrl) return [];
      const logos = arr(c.logo);
      return [{
        name,
        linkedinUrl,
        universalName: str(c.universalName),
        location: str(obj(c.location)?.linkedinText) || str(c.location),
        logo: str(logos[0]?.url) || str(c.logo),
        followers: num(c.followers),
      }];
    })
    .slice(0, limit);
}

// ---------- mock mode (deterministic, free) ----------

const MOCK_NAMES = [
  "Avery Stone", "Jordan Lee", "Morgan Chen", "Taylor Brooks", "Riley Patel",
  "Casey Nguyen", "Quinn Rivera", "Jamie Park", "Drew Ellis", "Samira Khan",
  "Alex Kim", "Hayden Ross", "Mina Shah", "Robin Gray", "Devin Cruz",
  "Skyler Reed", "Parker Lin", "Emery Cole", "Rowan Blake", "Kendall Moore",
  "Ari Wright", "Noa Singh", "Sage Turner", "Finley Ward", "Blair Young",
];
const MOCK_TOTAL = 137; // deliberately not a page multiple: exercises the last-page path

function mockLeadPage(query: LeadSearchQuery, page: number): LeadPage {
  const titles = query.currentJobTitles?.length
    ? query.currentJobTitles
    : ["Senior Backend Engineer", "Staff Engineer", "Full Stack Engineer"];
  const locations = query.locations?.length ? query.locations : ["New York, NY", "San Francisco, CA"];
  const companies = ["Acme AI", "Northstar Labs", "Vector Works", "Bolt Systems"];
  const pageSize = 25;
  const start = (page - 1) * pageSize;
  const count = Math.max(0, Math.min(pageSize, MOCK_TOTAL - start));
  return {
    leads: Array.from({ length: count }, (_, i) => {
      const n = start + i;
      const name = `${MOCK_NAMES[n % MOCK_NAMES.length]} ${Math.floor(n / MOCK_NAMES.length) + 1}`;
      const username = `mock-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const title = titles[n % titles.length];
      const company = companies[n % companies.length];
      return {
        fullName: name,
        memberId: `ACmock${String(n).padStart(6, "0")}`,
        linkedinUsername: username,
        linkedinUrl: `https://www.linkedin.com/in/${username}/`,
        currentTitle: title,
        currentCompany: company,
        currentCompanyLinkedinUrl: `https://www.linkedin.com/company/${company.toLowerCase().replace(/\s+/g, "-")}/`,
        headline: `${title} at ${company}`,
        location: locations[n % locations.length],
        summary: null,
        raw: { mock: true, index: n },
      };
    }),
    page,
    pageSize,
    totalElements: MOCK_TOTAL,
    totalPages: Math.ceil(MOCK_TOTAL / pageSize),
  };
}

function mockProfile(linkedinUrl: string): Record<string, unknown> {
  const username = linkedinUsernameFromUrl(linkedinUrl) || "mock-user";
  const seed = [...username].reduce((a, c) => a + c.charCodeAt(0), 0);
  const skillPool = ["Python", "TypeScript", "React", "PostgreSQL", "AWS", "Kubernetes", "Go", "Node.js"];
  return {
    firstName: username.split("-")[1] || "Mock",
    lastName: username.split("-")[2] || "User",
    headline: "Senior Backend Engineer at Acme AI",
    linkedinUrl,
    publicIdentifier: username,
    location: { linkedinText: seed % 2 ? "New York, NY" : "San Francisco, CA" },
    skills: skillPool.filter((_, i) => (seed + i) % 2 === 0).map((name) => ({ name })),
    experience: [
      {
        position: "Senior Backend Engineer",
        companyName: "Acme AI",
        startDate: { text: `Jan ${2020 + (seed % 3)}` },
        endDate: { text: "Present" },
        description: "Built distributed services handling millions of requests.",
      },
      {
        position: "Software Engineer",
        companyName: "Northstar Labs",
        startDate: { text: `Jun ${2016 + (seed % 3)}` },
        endDate: { text: `Dec ${2019 + (seed % 3)}` },
        description: "Full-stack product engineering on a small team.",
      },
    ],
    education: [{ schoolName: "Mock State University", degree: "BSc Computer Science" }],
  };
}

function mockCompanies(search: string, limit: number): CompanyHit[] {
  const slug = search.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "acme";
  return Array.from({ length: Math.min(3, limit) }, (_, i) => ({
    name: i === 0 ? search : `${search} ${["Labs", "Systems"][i - 1]}`,
    linkedinUrl: `https://www.linkedin.com/company/${slug}${i ? `-${i}` : ""}/`,
    universalName: `${slug}${i ? `-${i}` : ""}`,
    location: "San Francisco, California",
    logo: null,
    followers: 1000 * (i + 1),
  }));
}
