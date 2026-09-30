import { createHash, timingSafeEqual } from "crypto";
import { sbRest } from "@/lib/server/supabase";

// Spencer's private resume lookup (GET /api/internal/resumes/{id}). One
// bearer token, read-only, and it deliberately spans every organization, so
// the token is the whole wall: fail closed when it is unset.

export const LINK_TTL_SECONDS = 600;

export function tokenMatches(authHeader: string | null): boolean {
  const expected = process.env.INTERNAL_RESUMES_TOKEN;
  if (!expected || expected.length < 32) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  if (!m) return false;
  // Hash both sides so the comparison is constant-time at any length.
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function applicationResumePath(applicationId: string): Promise<string | null> {
  const res = await sbRest(
    `website_applications?id=eq.${applicationId}&select=resume_path&limit=1`
  );
  if (!res.ok) throw new Error(`application lookup failed: ${res.status}`);
  const rows = (await res.json()) as { resume_path: string | null }[];
  return rows[0]?.resume_path || null;
}

// Same signing call as signResumeUrl (lib/server/applicants.ts), with the
// short expiry this endpoint promises. Null when the file is missing.
export async function signShortResumeUrl(resumePath: string): Promise<string | null> {
  const key = process.env.SUPABASE_STORAGE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL;
  if (!key || !url) throw new Error("storage not configured");
  const res = await fetch(`${url}/storage/v1/object/sign/resumes/${resumePath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: LINK_TTL_SECONDS }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);
  const { signedURL } = (await res.json()) as { signedURL?: string };
  return signedURL ? `${url}/storage/v1${signedURL}` : null;
}
