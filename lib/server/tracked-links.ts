// Tracked outreach links. Minting is idempotent per (org, candidate); the
// short token routes through /l/<token>, which logs a human-looking open and
// redirects to the target path stored at mint time — the minting user's
// published recruiter page, else any published page in the org, else the
// org's board. Opens are signal, not proof: link scanners get filtered by
// user-agent and prefetch headers, but nothing beats a reply.
import { randomBytes } from "crypto";
import { sbInsert, sbRest } from "./supabase";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
export const TOKEN_RE = /^[A-Za-z0-9]{8,20}$/;

export type TrackedLink = {
  candidateKey: string;
  token: string;
  path: string; // "/l/<token>"
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
};

type DbLink = {
  candidate_key: string;
  token: string;
  open_count: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function mintToken(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const shape = (r: DbLink): TrackedLink => ({
  candidateKey: r.candidate_key,
  token: r.token,
  path: `/l/${r.token}`,
  openCount: r.open_count,
  firstOpenedAt: r.first_opened_at,
  lastOpenedAt: r.last_opened_at,
});

const LINK_COLS = "candidate_key,token,open_count,first_opened_at,last_opened_at";

/** All of an org's links, keyed by candidate — attached to the list rows. */
export async function loadLinksByKey(orgId: string): Promise<Map<string, TrackedLink>> {
  const res = await sbRest(
    `tracked_links?organization_id=eq.${orgId}&select=${LINK_COLS}&limit=5000`
  );
  const rows: DbLink[] = res.ok ? await res.json() : [];
  return new Map(rows.map((r) => [r.candidate_key, shape(r)]));
}

/** Where a fresh link should land for this user: their own published page
 *  first, else any published page in the org (owner-created links still work
 *  before the owner publishes their own), else the org board. */
export async function resolveTargetPath(orgId: string, userId: string): Promise<string> {
  const mine = await sbRest(
    `recruiter_profiles?organization_id=eq.${orgId}&user_id=eq.${userId}&published=is.true&select=slug&limit=1`
  );
  const [own] = mine.ok ? ((await mine.json()) as { slug: string }[]) : [];
  if (own?.slug) return `/r/${own.slug}`;
  const anyRes = await sbRest(
    `recruiter_profiles?organization_id=eq.${orgId}&published=is.true&select=slug&limit=1`
  );
  const [anyP] = anyRes.ok ? ((await anyRes.json()) as { slug: string }[]) : [];
  if (anyP?.slug) return `/r/${anyP.slug}`;
  const orgRes = await sbRest(`organizations?id=eq.${orgId}&select=slug&limit=1`);
  const [org] = orgRes.ok ? ((await orgRes.json()) as { slug: string }[]) : [];
  return org ? `/board/${org.slug}` : "/";
}

/** Create any missing links for these candidates and return them all. */
export async function ensureLinks(args: {
  orgId: string;
  candidateKeys: string[];
  userId: string;
}): Promise<Map<string, TrackedLink>> {
  const keys = [...new Set(args.candidateKeys.filter((k) => KEY_RE.test(k)))].slice(0, 1000);
  const out = new Map<string, TrackedLink>();
  if (!keys.length) return out;

  const existingRes = await sbRest(
    `tracked_links?organization_id=eq.${args.orgId}&candidate_key=in.(${keys
      .map((k) => `"${k}"`)
      .join(",")})&select=${LINK_COLS}`
  );
  const existing: DbLink[] = existingRes.ok ? await existingRes.json() : [];
  for (const r of existing) out.set(r.candidate_key, shape(r));

  const missing = keys.filter((k) => !out.has(k));
  if (missing.length) {
    const target = await resolveTargetPath(args.orgId, args.userId);
    for (const key of missing) {
      const token = mintToken();
      const row = await sbInsert<DbLink>(
        "tracked_links",
        {
          organization_id: args.orgId,
          candidate_key: key,
          token,
          target_path: target,
          created_by: args.userId,
        },
        true
      ).catch(async () => {
        // Unique-violation race (parallel mints): the winner's row is fine.
        const res = await sbRest(
          `tracked_links?organization_id=eq.${args.orgId}&candidate_key=eq.${key}&select=${LINK_COLS}&limit=1`
        );
        const [r] = res.ok ? ((await res.json()) as DbLink[]) : [];
        return r ?? null;
      });
      if (row) out.set(key, shape(row));
    }
  }
  return out;
}

// Scanners, unfurlers, and crawlers that follow links before any human does.
const BOT_UA =
  /bot|crawl|spider|slurp|preview|scan|monitor|fetch|curl|wget|python|httpclient|headless|facebookexternalhit|linkedin|whatsapp|telegram|skype|slack|discord|twitterbot|embedly|quora|pinterest|vkshare|outbrain|ia_archiver/i;

export function looksLikeBot(userAgent: string | null, purpose: string | null): boolean {
  if (!userAgent) return true;
  if (BOT_UA.test(userAgent)) return true;
  if (purpose && /prefetch|preview|prerender/i.test(purpose)) return true;
  return false;
}

/** Log one human-looking open; returns the redirect path (null = unknown token). */
export async function recordOpen(token: string, countIt: boolean): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const res = await sbRest(
    `tracked_links?token=eq.${token}&select=id,target_path,open_count,first_opened_at&limit=1`
  );
  const [row] = res.ok
    ? ((await res.json()) as { id: string; target_path: string; open_count: number; first_opened_at: string | null }[])
    : [];
  if (!row) return null;
  if (countIt) {
    const now = new Date().toISOString();
    await sbRest(`tracked_links?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        open_count: row.open_count + 1,
        last_opened_at: now,
        ...(row.first_opened_at ? {} : { first_opened_at: now }),
      }),
    }).catch(() => {});
  }
  return row.target_path;
}
