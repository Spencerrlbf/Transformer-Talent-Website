import { NextRequest, NextResponse } from "next/server";
import {
  extractJD,
  embed,
  matchCandidates,
  rankAndAnonymize,
} from "@/lib/server/matcher";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";

export const maxDuration = 60;

const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwaway.email", "yopmail.com", "sharklasers.com",
]);

export async function POST(req: NextRequest) {
  let body: { email?: string; company?: string; jdText?: string; website?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot
  if (body.website) return NextResponse.json({ ok: true, matches: [] });

  const email = (body.email || "").trim().toLowerCase().slice(0, 254);
  const company = (body.company || "").trim().slice(0, 200);
  // PDF copy-paste often carries NUL/control chars Postgres text rejects.
  const jdText = (body.jdText || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, 40000);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please use a valid work email." }, { status: 400 });
  }
  if (DISPOSABLE.has(email.split("@")[1])) {
    return NextResponse.json({ error: "Please use a company email address." }, { status: 400 });
  }
  if (!company) {
    return NextResponse.json({ error: "Please tell us your company name." }, { status: 400 });
  }
  if (jdText.length < 200) {
    return NextResponse.json(
      { error: "That job description looks too short — paste the full JD (200+ characters)." },
      { status: 400 }
    );
  }

  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";

  // Layered limits guarding the paid extraction/matching pipeline.
  if (!(await allow(`jd:email:${email}`, 3, 24))) {
    return NextResponse.json(
      { error: "You've reached today's limit — email spencer@transformertalent.com for more searches." },
      { status: 429 }
    );
  }
  if (!(await allow(`jd:ip:${ip}`, 5, 24))) {
    return NextResponse.json(
      { error: "Too many searches from this network today — try again tomorrow." },
      { status: 429 }
    );
  }
  if (!(await allow("jd:global", 40, 24))) {
    return NextResponse.json(
      { error: "We're at capacity today — email spencer@transformertalent.com and we'll run your search personally." },
      { status: 429 }
    );
  }

  const submission = await sbInsert<{ id: string }>(
    "jd_submissions",
    {
      email,
      company_name: company,
      jd_text: jdText,
      ip: ip === "unknown" ? null : ip,
      user_agent: (req.headers.get("user-agent") || "").slice(0, 500),
      status: "processing",
    },
    true
  );

  try {
    const jd = await extractJD(jdText);
    const vector = await embed(jd.embedding_summary);
    const rows = await matchCandidates(vector, jd);
    const matches = rankAndAnonymize(rows, jd, 5);

    if (submission) {
      await sbRest(`jd_submissions?id=eq.${submission.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          jd_extracted: jd,
          matched_candidate_ids: rows.slice(0, 10).map((r) => r.id),
          match_scores: matches.map((m) => ({ ref: m.ref, score: m.score })),
          status: "matched",
        }),
        prefer: "return=minimal",
      });
    }

    return NextResponse.json({
      ok: true,
      roleTitle: jd.title,
      matches,
      lowConfidence: matches.length === 0 || matches[0].score < 0.45,
    });
  } catch (err) {
    console.error("matcher pipeline failed", err);
    if (submission) {
      await sbRest(`jd_submissions?id=eq.${submission.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "failed" }),
        prefer: "return=minimal",
      }).catch(() => {});
    }
    return NextResponse.json(
      {
        error:
          "We hit a snag processing that JD — it's saved, and our team will run your search by hand. You'll hear from us within 24h.",
      },
      { status: 500 }
    );
  }
}
