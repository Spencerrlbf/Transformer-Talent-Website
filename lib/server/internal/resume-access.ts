import { createHash, createHmac, timingSafeEqual } from "crypto";
import { applicationsDb } from "@/lib/server/applications-db";

// Spencer's private resume lookup (GET /api/internal/resumes/{id}). One
// bearer token, read-only, and it is the whole wall: fail closed when unset.
// The PDF itself is served by this site from the applications files table
// through a short-lived signed link, so callers see the same shape as before.
export const LINK_TTL_SECONDS = 600;

function secret(): string | null {
  const t = process.env.INTERNAL_RESUMES_TOKEN;
  return t && t.length >= 32 ? t : null;
}

function same(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export function tokenMatches(authHeader: string | null): boolean {
  const expected = secret();
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  return !!m && same(m[1].trim(), expected);
}

export async function applicationResumePath(applicationId: string): Promise<string | null> {
  const r = await applicationsDb().query(
    "select path from public.website_application_files where application_id = $1",
    [applicationId]
  );
  return (r.rows[0]?.path as string | undefined) || null;
}

export async function applicationResumeFile(
  applicationId: string
): Promise<{ bytes: Buffer; fileName: string; mediaType: string } | null> {
  const r = await applicationsDb().query(
    "select bytes, file_name, media_type from public.website_application_files where application_id = $1",
    [applicationId]
  );
  const row = r.rows[0];
  return row ? { bytes: row.bytes as Buffer, fileName: row.file_name as string, mediaType: row.media_type as string } : null;
}

function sign(applicationId: string, exp: number): string | null {
  const s = secret();
  return s ? createHmac("sha256", s).update(`${applicationId}:${exp}`).digest("hex") : null;
}

// A link to this site's own file route, valid for LINK_TTL_SECONDS.
export function signShortResumeUrl(origin: string, applicationId: string): string | null {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const sig = sign(applicationId, exp);
  return sig ? `${origin}/api/internal/resumes/${applicationId}/file?exp=${exp}&sig=${sig}` : null;
}

export function linkValid(applicationId: string, exp: string | null, sig: string | null): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Math.floor(Date.now() / 1000) || !sig) return false;
  const want = sign(applicationId, e);
  return !!want && same(sig, want);
}
