// TEST BRANCH ONLY (verify/stage2-combined). Never merged. Reports why the person
// database connection fails on Vercel, as identifier-like codes only.
import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
const safe = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_:.\-]{1,100}$/.test(v) ? v : null);
export async function GET(req: NextRequest) {
  const token = process.env.DIAG_TOKEN;
  if (!token || req.headers.get("x-diag-token") !== token) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const out: Record<string, unknown> = { has_url: !!process.env.PERSON_DATABASE_URL, node: process.version, region: process.env.VERCEL_REGION ?? null };
  try { const u = new URL(process.env.PERSON_DATABASE_URL || ""); out.host_is_pooler = u.hostname.endsWith(".pooler.supabase.com"); out.port = u.port; } catch { out.url_parse = "failed"; }
  let pg: any;
  try { pg = (await import("pg")).default; out.pg_import = "ok"; } catch (e: any) { out.pg_import = { code: safe(e?.code), name: safe(e?.name) }; return NextResponse.json(out); }
  const pool = new pg.Pool({ connectionString: process.env.PERSON_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  try { const c = await pool.connect(); try { const r = await c.query("select current_user u, current_setting('transaction_isolation') iso"); out.connect = "ok"; out.user_ok = String(r.rows[0].u).startsWith("postgres"); out.iso = r.rows[0].iso; } finally { c.release(); } }
  catch (e: any) { out.connect = { code: safe(e?.code), name: safe(e?.name), syscall: safe(e?.syscall), errno: typeof e?.errno === "number" ? e.errno : safe(e?.errno) }; }
  finally { await pool.end().catch(() => {}); }
  try { const { withPersonConnection } = await import("@/lib/server/person/save"); await withPersonConnection(async (c) => { await c.query("select 1"); }); out.with_person_connection = "ok"; }
  catch (e: any) { out.with_person_connection = { message: safe(e?.message), code: safe(e?.code) }; }
  return NextResponse.json(out);
}
