// Global company-context cache. Each employer is fetched from Harvest at
// most once ($0.004) and shared across every run and tenant. Failed
// lookups are negatively cached so we never re-pay for companies Harvest
// can't resolve. Mock mode fabricates context for free, in memory only: it
// never writes to the shared cache.
//
// Two readers share these rows: the judge (companyContextLine and employerOf,
// whose output must not change) and the report card's company hover
// (snapshotOf, the shape in lib/company-snapshot).
import { sbRest } from "../supabase";
import { providerMode } from "./harvest";
import { companySlug, type CompanySnapshot } from "../../company-snapshot";

export interface CompanyContext {
  linkedin_slug: string;
  name: string | null;
  industry: string | null;
  employee_range: string | null;
  description: string | null;
  founded: number | null;
  /** The headquarters as the page states it: "San Francisco, California, United States". */
  hq: string | null;
  website: string | null;
  /** "Privately Held", "Public Company", ... as LinkedIn words it. */
  company_type: string | null;
  fetch_failed: boolean;
  fetched_at: string | null;
  /** The row format it was written in. Rows from before the snapshot columns
   *  carry none, and are fetched again once. */
  raw?: { v: number } | null;
}

/** Stamped on every row written since the snapshot columns exist, so a page
 *  that genuinely states no headquarters, website or company type is not
 *  fetched again and again. */
const ROW_FORMAT = { v: 2 } as const;

/** What one company page parses to: every column except the key, the
 *  failure flag and the fetch time, which the cache layer adds. */
export type ParsedCompany = Omit<CompanyContext, "linkedin_slug" | "fetch_failed" | "fetched_at">;

const SELECT = "linkedin_slug,name,industry,employee_range,description,founded,hq,website,company_type,fetch_failed,fetched_at,raw";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function companySlugFromUrl(url: string | null | undefined): string | null {
  return companySlug(url);
}

/** "51-200 employees" from a { start, end } range; "10001+ employees" when
 *  the range has no upper end. */
function rangeText(v: unknown): string | null {
  const range = obj(v);
  const start = num(range?.start);
  if (start == null) return null;
  const end = num(range?.end);
  return end != null ? `${start}-${end} employees` : `${start}+ employees`;
}

/** The first industry, whether the page lists names or { name, title } objects. */
function firstIndustry(v: unknown): string | null {
  const first = Array.isArray(v) ? v[0] : null;
  return str(first) || str(obj(first)?.name) || str(obj(first)?.title);
}

/** The headquarters: the location flagged as such, else the first one. Its
 *  parsed text when the page gives one, else city, area and country. */
function headquarters(v: unknown): string | null {
  const locations = (Array.isArray(v) ? v : []).map(obj).filter((l): l is Record<string, unknown> => l !== null);
  const hq = locations.find((l) => l.headquarter === true) || locations[0];
  if (!hq) return null;
  return (
    str(obj(hq.parsed)?.text) ||
    [str(hq.city), str(hq.geographicArea), str(hq.country)].filter(Boolean).join(", ") ||
    null
  );
}

/**
 * Harvest's /linkedin/company element as one cache row. Null when the page
 * has no name (Harvest wraps errors in 200s). Pure, so a docs-shaped element
 * can be tested without a network.
 */
export function parseCompanyElement(el: Record<string, unknown>): ParsedCompany | null {
  const name = str(el.name);
  if (!name) return null;
  // The head count as the page words it. A plain count says more than the
  // range it sits in, so it wins ("~183 employees" over "51-200 employees").
  const employee_range =
    str(el.employeeCountRange) ||
    (num(el.employeeCount) != null ? `~${el.employeeCount} employees` : null) ||
    rangeText(el.employeeCountRange) ||
    rangeText(el.staffCountRange);
  return {
    name,
    industry: str(el.industry) || firstIndustry(el.industries),
    employee_range,
    description: (str(el.tagline) || str(el.description))?.slice(0, 400) ?? null,
    founded: num(el.foundedOn) ?? num(obj(el.foundedOn)?.year) ?? num(el.founded),
    hq: headquarters(el.locations),
    website: str(el.website),
    company_type: str(el.companyType),
  };
}

/** Mock mode's stand-in for a page, deterministic from the slug. Never cached. */
function mockCompany(slug: string): ParsedCompany {
  return {
    name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    industry: "Software Development",
    employee_range: "11-50 employees",
    description: "Mock company context for testing.",
    founded: 2021,
    hq: "San Francisco, California, United States",
    website: `https://${slug}.example.com`,
    company_type: "Privately Held",
  };
}

async function fetchFromHarvest(slug: string, key: string): Promise<ParsedCompany | null> {
  try {
    const res = await fetch(
      `https://api.harvestapi.io/linkedin/company?url=${encodeURIComponent(`https://www.linkedin.com/company/${slug}/`)}`,
      { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(25_000) }
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as Record<string, unknown>;
    return parseCompanyElement(obj(payload.element) ?? payload);
  } catch {
    return null;
  }
}

/** The head count a company page states, as one integer: "~183 employees"
 *  is 183, and a range ("1,001-5,000 employees") reads as its upper bound.
 *  Null when the page says nothing. */
export function employeeCount(range: string | null | undefined): number | null {
  const nums = (String(range || "").replace(/,/g, "").match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.length === 1 ? nums[0] : Math.max(...nums);
}

/** A cached page that resolved before the snapshot columns existed: it was
 *  written without the row format stamp. It is fetched again on the next
 *  live lookup so the hover has its facts. A failed page stays failed. */
function predatesSnapshot(c: CompanyContext): boolean {
  return !c.fetch_failed && !c.raw;
}

const EMPTY: ParsedCompany = { name: null, industry: null, employee_range: null, description: null, founded: null, hq: null, website: null, company_type: null };

/**
 * Cache-first batch lookup. Unknown slugs are fetched (bounded concurrency)
 * and stored, failures too, so a bad slug never costs twice. A page cached
 * without its snapshot columns is fetched again and its row replaced. With
 * `cacheOnly` nothing is fetched: what the cache knows is returned, and an
 * unknown company is simply absent (the applicant path, which has no import
 * step to prefetch employers and no time budget for one).
 */
export async function getCompanyContexts(
  slugs: string[],
  opts: {
    cacheOnly?: boolean;
    /** Use the real provider whenever a key exists, even where runs are
     *  mocked (preview deploys): for metadata a hover is worth $0.004 for,
     *  cached for everyone. Without a key, mock mode fabricates as usual. */
    liveIfKey?: boolean;
  } = {}
): Promise<Map<string, CompanyContext>> {
  const unique = [...new Set(slugs.filter(Boolean))].slice(0, 100);
  const out = new Map<string, CompanyContext>();
  if (!unique.length) return out;

  const res = await sbRest(
    `company_context?linkedin_slug=in.(${unique.map((s) => `"${s}"`).join(",")})&select=${SELECT}`
  );
  const cached: CompanyContext[] = res.ok ? await res.json() : [];
  for (const c of cached) out.set(c.linkedin_slug, c);
  if (opts.cacheOnly) return out;

  // Mock mode fabricates what the cache lacks, in memory only. It never
  // writes: fabricated rows once reached the shared cache this way.
  const key = (process.env.HARVEST_API_KEY || "").trim();
  if (providerMode() === "mock" && !(opts.liveIfKey && key)) {
    const now = new Date().toISOString();
    for (const slug of unique) {
      if (!out.has(slug)) out.set(slug, { linkedin_slug: slug, ...mockCompany(slug), fetch_failed: false, fetched_at: now, raw: ROW_FORMAT });
    }
    return out;
  }

  const wanted = unique.filter((s) => {
    const c = out.get(s);
    return !c || predatesSnapshot(c);
  });
  // Without a key nothing can be fetched, and nothing is remembered: a
  // missing key must not fill the shared cache with failures.
  if (!wanted.length || !key) return out;

  // Bounded concurrency; failures are cached negatively. Merge on conflict,
  // so a page fetched again replaces the row it had.
  const CONC = 3;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, wanted.length) }, async () => {
      while (next < wanted.length) {
        const slug = wanted[next++];
        const fetched = await fetchFromHarvest(slug, key);
        // A page we already had keeps its row when the fetch fails.
        if (!fetched && out.has(slug)) continue;
        const row: CompanyContext = {
          linkedin_slug: slug,
          ...(fetched ?? EMPTY),
          fetch_failed: !fetched,
          fetched_at: new Date().toISOString(),
          raw: ROW_FORMAT,
        };
        out.set(slug, row);
        await sbRest(`company_context?on_conflict=linkedin_slug`, {
          method: "POST",
          body: JSON.stringify(row),
          prefer: "resolution=merge-duplicates,return=minimal",
        }).catch(() => {});
      }
    })
  );
  return out;
}

/** The current employer as the report card states it: its name, head count
 *  and founding year from its company page, or null when the page is not
 *  known. Facts about the employer are shown once, as facts; they never tick
 *  a row. */
export function employerOf(ctx: CompanyContext | undefined): { name: string; employees: number | null; founded: number | null } | null {
  if (!ctx || ctx.fetch_failed || !ctx.name) return null;
  return { name: ctx.name, employees: employeeCount(ctx.employee_range), founded: ctx.founded ?? null };
}

/** One judge-ready line, or null when we know nothing useful. */
export function companyContextLine(ctx: CompanyContext | undefined): string | null {
  if (!ctx || ctx.fetch_failed || !ctx.name) return null;
  const bits = [ctx.industry, ctx.employee_range, ctx.founded ? `founded ${ctx.founded}` : null]
    .filter(Boolean).join(", ");
  const desc = ctx.description ? ` — ${ctx.description}` : "";
  return `${ctx.name}${bits ? ` (${bits})` : ""}${desc}`;
}

/** The company as the report card's hover shows it, or null when the page
 *  is not on file, failed to fetch or has no name. */
export function snapshotOf(ctx: CompanyContext | undefined): CompanySnapshot | null {
  if (!ctx || ctx.fetch_failed || !ctx.name) return null;
  return {
    slug: ctx.linkedin_slug,
    linkedinUrl: `https://www.linkedin.com/company/${ctx.linkedin_slug}/`,
    name: ctx.name,
    industry: ctx.industry ?? null,
    employeeRange: ctx.employee_range ?? null,
    employees: employeeCount(ctx.employee_range),
    founded: ctx.founded ?? null,
    tagline: ctx.description ?? null,
    hq: ctx.hq ?? null,
    website: ctx.website ?? null,
    companyType: ctx.company_type ?? null,
    fetchedAt: ctx.fetched_at ?? null,
  };
}
