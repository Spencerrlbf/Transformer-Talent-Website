// Company page content: one jsonb doc on organizations, sanitized here,
// rendered on the tenant board's About tab. Interview process steps come
// from the org's interview stage template; this doc only carries the
// per-step durations and the note.
import { sbRest } from "./supabase";
import { DEFAULT_STAGES, sanitizeStages, type InterviewStage } from "./interview-stages";

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

export type CompanyProfile = {
  tagline: string;
  missionHeadline: string;
  missionDetail: string;
  buildingHeadline: string;
  buildingDetail: string;
  buildingCards: { title: string; text: string }[];
  founders: CompanyFounder[];
  processNote: string;
  /** stage id -> duration label ("30 min", "Half day") */
  stepDurations: Record<string, string>;
  headcount: string;
  founded: string;
  stage: string;
  offices: string;
};

export type CompanyPage = {
  profile: CompanyProfile;
  logoUrl: string | null;
  website: string;
  stages: InterviewStage[];
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
  const founders = (Array.isArray(o.founders) ? o.founders : [])
    .slice(0, 4)
    .map((f) => {
      const r = (f ?? {}) as Record<string, unknown>;
      let id = s(r.id, 24);
      if (!/^[a-z0-9_-]{1,24}$/.test(id)) id = `f${Math.random().toString(36).slice(2, 8)}`;
      return {
        id,
        name: s(r.name, 120),
        title: s(r.title, 80),
        bio: s(r.bio, 600),
        linkedin: s(r.linkedin, 300),
        photoPath: path(r.photoPath),
      };
    })
    .filter((f) => f.name);
  const cards = (Array.isArray(o.buildingCards) ? o.buildingCards : [])
    .slice(0, 3)
    .map((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return { title: s(r.title, 60), text: s(r.text, 240) };
    })
    .filter((c) => c.title);
  const durations: Record<string, string> = {};
  const d = (o.stepDurations ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(d).slice(0, 12)) {
    if (/^[a-z0-9_-]{1,24}$/.test(k)) {
      const v = s(d[k], 30);
      if (v) durations[k] = v;
    }
  }
  return {
    tagline: s(o.tagline, 120),
    missionHeadline: s(o.missionHeadline, 220),
    missionDetail: s(o.missionDetail, 1200),
    buildingHeadline: s(o.buildingHeadline, 160),
    buildingDetail: s(o.buildingDetail, 1200),
    buildingCards: cards,
    founders,
    processNote: s(o.processNote, 300),
    stepDurations: durations,
    headcount: s(o.headcount, 40),
    founded: s(o.founded, 20),
    stage: s(o.stage, 40),
    offices: s(o.offices, 60),
  };
}

export const EMPTY_PROFILE: CompanyProfile = sanitizeProfile({}, "-");

type OrgRow = {
  company_profile: unknown;
  company_page_published: boolean;
  logo_path: string | null;
  website: string | null;
  interview_stages: unknown;
};

/** Published company page for the public board; null when unpublished. */
export async function loadCompanyPage(orgId: string): Promise<CompanyPage | null> {
  const res = await sbRest(
    `organizations?id=eq.${orgId}&select=company_profile,company_page_published,logo_path,website,interview_stages`
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
    stages: sanitizeStages(row.interview_stages) || DEFAULT_STAGES,
  };
}
