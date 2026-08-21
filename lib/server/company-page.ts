// Company page content: one jsonb doc on organizations, sanitized here,
// rendered on the tenant board's About tab. Interview process steps come
// from the org's interview stage template; this doc only carries the
// per-step durations and the note.
import { sbRest } from "./supabase";

export type CompanyFounder = {
  id: string;
  name: string;
  title: string;
  bio: string;
  linkedin: string;
  photoPath: string | null;
  /** Filled by loaders (public URL for photoPath). */
  photoUrl?: string | null;
};

export type CompanySection = { title: string; subtitle: string; body: string };

export type CompanyRound = {
  id: string;
  name: string;
  duration: string;
  /** One line shown in the collapsed row. */
  hint: string;
  /** Full paragraph shown in the drawer. */
  detail: string;
};

export type CompanyProfile = {
  tagline: string;
  missionHeadline: string;
  missionDetail: string;
  /** Free-form content sections: title / subtitle / body. */
  sections: CompanySection[];
  founders: CompanyFounder[];
  /** Interview rounds the company draws from (decoupled from pipeline stages). */
  rounds: CompanyRound[];
  processNote: string;
  /** Facts rendered as chips with the identity, exactly as typed. */
  headcount: string;
  founded: string;
  stage: string;
  funding: string;
  offices: string;
  workEnv: string;
};

export type CompanyPage = {
  profile: CompanyProfile;
  logoUrl: string | null;
  website: string;
};

const s = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

export function assetPublicUrl(path: string | null): string | null {
  if (!path) return null;
  const base = process.env.SUPABASE_URL;
  return base ? `${base}/storage/v1/object/public/company-assets/${path}` : null;
}

/** Sanitize an incoming profile doc. Asset paths must live under orgId/. */
export function sanitizeProfile(input: unknown, orgId: string): CompanyProfile {
  const o = (input ?? {}) as Record<string, unknown>;
  const path = (v: unknown): string | null => {
    const p = s(v, 300);
    return p && p.startsWith(`${orgId}/`) && !p.includes("..") ? p : null;
  };
  const stableId = (v: unknown, prefix: string): string => {
    const id = s(v, 24);
    return /^[a-z0-9_-]{1,24}$/.test(id)
      ? id
      : `${prefix}${Math.random().toString(36).slice(2, 8)}`;
  };
  const founders = (Array.isArray(o.founders) ? o.founders : [])
    .slice(0, 6)
    .map((f) => {
      const r = (f ?? {}) as Record<string, unknown>;
      return {
        id: stableId(r.id, "f"),
        name: s(r.name, 120),
        title: s(r.title, 80),
        bio: s(r.bio, 600),
        linkedin: s(r.linkedin, 300),
        photoPath: path(r.photoPath),
      };
    })
    .filter((f) => f.name);
  const sections = (Array.isArray(o.sections) ? o.sections : [])
    .slice(0, 6)
    .map((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return { title: s(r.title, 80), subtitle: s(r.subtitle, 160), body: s(r.body, 2000) };
    })
    .filter((c) => c.title && c.body);
  const rounds = (Array.isArray(o.rounds) ? o.rounds : [])
    .slice(0, 8)
    .map((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return {
        id: stableId(r.id, "r"),
        name: s(r.name, 60),
        duration: s(r.duration, 30),
        hint: s(r.hint, 120),
        detail: s(r.detail, 800),
      };
    })
    .filter((c) => c.name);
  return {
    tagline: s(o.tagline, 120),
    missionHeadline: s(o.missionHeadline, 220),
    missionDetail: s(o.missionDetail, 1200),
    sections,
    founders,
    rounds,
    processNote: s(o.processNote, 300),
    headcount: s(o.headcount, 40),
    founded: s(o.founded, 30),
    stage: s(o.stage, 40),
    funding: s(o.funding, 40),
    offices: s(o.offices, 60),
    workEnv: s(o.workEnv, 40),
  };
}

export const EMPTY_PROFILE: CompanyProfile = sanitizeProfile({}, "-");

type OrgRow = {
  company_profile: unknown;
  company_page_published: boolean;
  logo_path: string | null;
  website: string | null;
};

/** Published company page for the public board; null when unpublished. */
export async function loadCompanyPage(orgId: string): Promise<CompanyPage | null> {
  const res = await sbRest(
    `organizations?id=eq.${orgId}&select=company_profile,company_page_published,logo_path,website`
  );
  const [row] = res.ok ? ((await res.json()) as OrgRow[]) : [];
  if (!row || !row.company_page_published) return null;
  const profile = sanitizeProfile(row.company_profile, orgId);
  profile.founders = profile.founders.map((f) => ({
    ...f,
    photoUrl: assetPublicUrl(f.photoPath),
  }));
  return {
    profile,
    logoUrl: assetPublicUrl(row.logo_path),
    website: row.website || "",
  };
}
