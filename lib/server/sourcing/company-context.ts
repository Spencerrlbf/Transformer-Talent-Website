// Global company-context cache. Each employer is fetched from Harvest at
// most once ($0.004) and shared across every run and tenant. Failed
// lookups are negatively cached so we never re-pay for companies Harvest
// can't resolve. Mock mode fabricates context for free.
import { sbRest } from "../supabase";
import { providerMode } from "./harvest";

export interface CompanyContext {
  linkedin_slug: string;
  name: string | null;
  industry: string | null;
  employee_range: string | null;
  description: string | null;
  founded: number | null;
  fetch_failed: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function companySlugFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, "") : null;
}

async function fetchFromHarvest(slug: string): Promise<Omit<CompanyContext, "linkedin_slug" | "fetch_failed"> | null> {
  if (providerMode() === "mock") {
    return {
      name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      industry: "Software Development",
      employee_range: "11-50 employees",
      description: "Mock company context for testing.",
      founded: 2021,
    };
  }
  const key = (process.env.HARVEST_API_KEY || "").trim();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.harvestapi.io/linkedin/company?url=${encodeURIComponent(`https://www.linkedin.com/company/${slug}/`)}`,
      { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(25_000) }
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as Record<string, unknown>;
    const el = (payload.element ?? payload) as Record<string, unknown>;
    const name = str(el.name);
    if (!name) return null;
    const employees =
      str(el.employeeCountRange) ||
      (num(el.employeeCount) != null ? `~${el.employeeCount} employees` : null) ||
      str((el.staffCountRange as Record<string, unknown>)?.start != null
        ? `${(el.staffCountRange as Record<string, unknown>).start}-${(el.staffCountRange as Record<string, unknown>).end} employees`
        : null);
    return {
      name,
      industry: str(el.industry) || str((Array.isArray(el.industries) ? el.industries[0] : null)),
      employee_range: employees,
      description: (str(el.tagline) || str(el.description))?.slice(0, 400) ?? null,
      founded: num(el.foundedOn) ?? num((el.foundedOn as Record<string, unknown>)?.year) ?? num(el.founded),
    };
  } catch {
    return null;
  }
}

/**
 * Cache-first batch lookup. Unknown slugs are fetched (bounded concurrency)
 * and stored — including failures, so a bad slug never costs twice.
 */
export async function getCompanyContexts(slugs: string[]): Promise<Map<string, CompanyContext>> {
  const unique = [...new Set(slugs.filter(Boolean))].slice(0, 100);
  const out = new Map<string, CompanyContext>();
  if (!unique.length) return out;

  const res = await sbRest(
    `company_context?linkedin_slug=in.(${unique.map((s) => `"${s}"`).join(",")})&select=linkedin_slug,name,industry,employee_range,description,founded,fetch_failed`
  );
  const cached: CompanyContext[] = res.ok ? await res.json() : [];
  for (const c of cached) out.set(c.linkedin_slug, c);

  const missing = unique.filter((s) => !out.has(s));
  if (!missing.length) return out;

  // Bounded concurrency; failures are cached negatively.
  const CONC = 3;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, missing.length) }, async () => {
      while (next < missing.length) {
        const slug = missing[next++];
        const fetched = await fetchFromHarvest(slug);
        const row: CompanyContext = fetched
          ? { linkedin_slug: slug, ...fetched, fetch_failed: false }
          : { linkedin_slug: slug, name: null, industry: null, employee_range: null, description: null, founded: null, fetch_failed: true };
        out.set(slug, row);
        await sbRest(`company_context?on_conflict=linkedin_slug`, {
          method: "POST",
          body: JSON.stringify({ ...row, raw: null }),
          prefer: "resolution=ignore-duplicates,return=minimal",
        }).catch(() => {});
      }
    })
  );
  return out;
}

/** One judge-ready line, or null when we know nothing useful. */
export function companyContextLine(ctx: CompanyContext | undefined): string | null {
  if (!ctx || ctx.fetch_failed || !ctx.name) return null;
  const bits = [ctx.industry, ctx.employee_range, ctx.founded ? `founded ${ctx.founded}` : null]
    .filter(Boolean).join(", ");
  const desc = ctx.description ? ` — ${ctx.description}` : "";
  return `${ctx.name}${bits ? ` (${bits})` : ""}${desc}`;
}
