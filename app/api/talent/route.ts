import { NextRequest, NextResponse } from "next/server";
import {
  extractJD,
  embed,
  matchCandidates,
  rankAndAnonymize,
} from "@/lib/server/matcher";
import { allow } from "@/lib/server/ratelimit";
import { sbInsert, sbRest } from "@/lib/server/supabase";
import { screenAgainstJD } from "@/lib/server/screening";
import { llamaParsePdf } from "@/lib/server/llamaparse";
import { enqueueMatchedCandidates, recordEnrichment } from "@/lib/server/spine";

export const maxDuration = 60;

const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwaway.email", "yopmail.com", "sharklasers.com",
]);

const MAX_JD_PDF_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let body: { email?: string; company?: string; jdText?: string; website?: string };
  let jdFile: File | null = null;
  const contentType = req.headers.get("content-type") || "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      body = {
        email: String(form.get("email") ?? ""),
        company: String(form.get("company") ?? ""),
        jdText: String(form.get("jdText") ?? ""),
        website: String(form.get("website") ?? ""),
      };
      const f = form.get("jdFile");
      if (f instanceof File && f.size > 0) jdFile = f;
    } else {
      body = await req.json();
    }
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot
  if (body.website) return NextResponse.json({ ok: true, matches: [] });

  const email = (body.email || "").trim().toLowerCase().slice(0, 254);
  const company = (body.company || "").trim().slice(0, 200);
  // PDF copy-paste often carries NUL/control chars Postgres text rejects.
  let jdText = (body.jdText || "")
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
  if (jdText.length < 200 && !jdFile) {
    return NextResponse.json(
      { error: "That job description looks too short — paste the full JD (200+ characters) or upload it as a PDF." },
      { status: 400 }
    );
  }
  if (jdFile && (jdFile.size > MAX_JD_PDF_BYTES || (jdFile.type && jdFile.type !== "application/pdf"))) {
    return NextResponse.json({ error: "JD upload must be a PDF under 8MB." }, { status: 400 });
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

  // JD PDF upload: parse only after the rate-limit gates (LlamaParse costs money).
  if (jdFile) {
    const buf = Buffer.from(await jdFile.arrayBuffer());
    const parsedJd = await llamaParsePdf(buf, jdFile.name || "jd.pdf");
    if (parsedJd) {
      await recordEnrichment({
        candidateId: null,
        linkedinUsername: null,
        provider: "llamaparse",
        operation: "jd_parse",
        cacheStatus: "miss",
      });
    }
    const combined = [parsedJd, jdText].filter(Boolean).join("\n\n").trim().slice(0, 40000);
    if (combined.length >= 200) jdText = combined;
    if (jdText.length < 200) {
      return NextResponse.json(
        { error: "We couldn't read that PDF — paste the job description as text instead." },
        { status: 400 }
      );
    }
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
    const fits = await screenAgainstJD(
      jd.embedding_summary,
      jd.skills.slice(0, 6),
      matches.map((m) => ({
        ref: m.ref,
        profileText: `${m.title}. ${m.yearsExperience ?? "?"} yrs. ${m.location ?? ""}. Prev: ${m.previousCompanies.join(", ")}. Education: ${m.education.join("; ")}. Skills: ${m.skills.join(", ")}`,
      }))
    );
    const withFit = matches.map((m) => ({
      ...m,
      fit: fits.find((f) => f.ref === m.ref) || null,
    }));

    // The candidates a real JD surfaced are the ones worth refreshing first.
    await enqueueMatchedCandidates(rows.slice(0, 10).map((r) => r.id)).catch(() => {});

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
      matches: withFit,
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
