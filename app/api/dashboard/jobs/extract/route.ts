import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { extractJd, extractionWarnings } from "@/lib/server/jd-extract";
import { llamaParsePdf } from "@/lib/server/llamaparse";
import { MIN_JD_CHARS } from "@/lib/role-options";

export const maxDuration = 60;

const MAX_PDF_BYTES = 8 * 1024 * 1024;

async function pdfFallbackText(buf: Buffer): Promise<string> {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = (mod.default || mod) as (b: Buffer) => Promise<{ text: string }>;
    return (await pdf(buf)).text || "";
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let text = "";
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File))
      return NextResponse.json({ error: "no_file" }, { status: 400 });
    if (file.size > MAX_PDF_BYTES)
      return NextResponse.json({ error: "file_too_large" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    text = (await llamaParsePdf(buf, file.name || "jd.pdf")) || (await pdfFallbackText(buf));
    if (!text.trim())
      return NextResponse.json({ error: "pdf_unreadable" }, { status: 422 });
  } else {
    try {
      text = String((await req.json()).text || "");
    } catch {
      /* fall through to length check */
    }
  }

  text = text.trim();
  if (text.length < MIN_JD_CHARS)
    return NextResponse.json({ error: "jd_too_short" }, { status: 400 });

  try {
    const extracted = await extractJd(text);
    return NextResponse.json({ extracted, warnings: extractionWarnings(extracted) });
  } catch (e) {
    console.error("jd extract failed", e);
    return NextResponse.json({ error: "extract_failed" }, { status: 502 });
  }
}
