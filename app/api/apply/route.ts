import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { applicationsDb } from "@/lib/server/applications-db";
import { linkedinUsername } from "@/lib/server/linkedin";
import { sanitizeLocationOptions } from "@/lib/server/locations";
import { pdfText } from "@/lib/server/resume-text";
import { verifyTurnstile } from "@/lib/server/turnstile";

// The paused site's apply route. Every application is a speculative one
// (there is no role list while the project is paused): one row and, when a
// PDF was attached, one file row. The reply-ops sync reads the row within
// 15 minutes and puts it on the board; nothing else runs here.
export const maxDuration = 60;

const MAX_RESUME_BYTES = 8 * 1024 * 1024;
const ORG_ID = "801865a7-6533-41d2-9c45-e4a90e6ad51a";

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, max);
}

// A fresh response each time: a Response body can be sent only once.
const saved = () => NextResponse.json({ ok: true });
const failed = () =>
  NextResponse.json({ error: "Something went wrong saving your application. Please try again." }, { status: 502 });

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (clean(form.get("website"), 50)) return saved(); // honeypot
  if (!(await verifyTurnstile(form.get("cf-turnstile-response")))) {
    return NextResponse.json(
      { error: "We couldn't verify your browser. Please refresh the page and try again." },
      { status: 403 }
    );
  }
  const name = clean(form.get("name"), 120);
  const email = clean(form.get("email"), 254).toLowerCase();
  const linkedin = clean(form.get("linkedin"), 300);
  const visa = clean(form.get("visa"), 150);
  const note = clean(form.get("note"), 2000);
  const preferredLocations = sanitizeLocationOptions(form.getAll("preferredLocations").map((v) => clean(v, 30)));
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please provide your name and a valid email." }, { status: 400 });
  }
  const username = linkedinUsername(linkedin);
  if (!linkedin || !username) {
    return NextResponse.json({ error: "Please provide your LinkedIn profile URL (linkedin.com/in/…)." }, { status: 400 });
  }
  const file = form.get("resume");
  if (!(file instanceof File && file.size > 0)) {
    return NextResponse.json({ error: "A resume is required." }, { status: 400 });
  }
  if (file.size > MAX_RESUME_BYTES || (file.type && file.type !== "application/pdf")) {
    return NextResponse.json({ error: "Resume must be a PDF under 8MB." }, { status: 400 });
  }
  const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || null;
  const userAgent = clean(req.headers.get("user-agent"), 500) || null;

  let db;
  try {
    db = applicationsDb();
    // Same person again within 14 days: same answer, no second row.
    const dup = await db.query(
      `select 1 from public.website_applications
        where created_at >= now() - interval '14 days' and (email = $1 or linkedin_username = $2) limit 1`,
      [email, username]
    );
    if (dup.rowCount) return saved();
    // Per-person limits over 24 hours: this address, this connection.
    const limits = await db.query(
      `select count(*) filter (where email = $1) as by_email,
              count(*) filter (where $2::inet is not null and ip = $2::inet) as by_ip
         from public.website_applications where created_at >= now() - interval '24 hours'`,
      [email, ip]
    );
    if (Number(limits.rows[0].by_email) >= 4 || Number(limits.rows[0].by_ip) >= 8) {
      return NextResponse.json(
        { error: "Too many applications today. Email hello@transformertalent.com directly." },
        { status: 429 }
      );
    }
  } catch (e) {
    console.error("application lookup failed", (e as Error).message);
    return failed();
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const safeName = (file.name || "resume.pdf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = await pdfText(bytes);
  if (!text) console.error("application resume text empty", bytes.length);
  const source = ["speculative", note ? `note: ${note}` : null].filter(Boolean).join("; ");

  const client = await db.connect().catch((e) => {
    console.error("application connect failed", (e as Error).message);
    return null;
  });
  if (!client) return failed();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into public.website_applications
         (organization_id, name, email, linkedin_url, linkedin_username, visa_status, preferred_locations,
          role_ids, role_titles, resume_path, resume_text, person_resume_sha256, status, source, ip, user_agent)
       values ($1,$2,$3,$4,$5,$6,$7,'{}','{}',$8,$9,$10,'received',$11,$12::inet,$13)
       returning id`,
      [ORG_ID, name, email, linkedin, username, visa || null, preferredLocations, path, text || null, sha256, source, ip, userAgent]
    );
    await client.query(
      `insert into public.website_application_files (application_id, path, file_name, media_type, bytes, sha256)
       values ($1,$2,$3,'application/pdf',$4,$5)`,
      [ins.rows[0].id, path, safeName, bytes, sha256]
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    console.error("application insert failed", (e as Error).message);
    return failed();
  } finally {
    client.release();
  }
  return saved();
}
