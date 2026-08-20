import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { signResumeUrl } from "@/lib/server/applicants";
import { saveUnifiedResumePath, resumeNameFromPath } from "@/lib/server/candidates-unified";

export const maxDuration = 60;

// Upload (or replace) a candidate's resume from the profile drawer. Same
// bucket, size cap, and dated-uuid path convention as the apply flow.
const MAX_RESUME_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const { key } = await ctx.params;
  if (!/^(app|src)_[0-9a-f-]{36}$/i.test(key))
    return NextResponse.json({ error: "bad_key" }, { status: 400 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "bad_form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_RESUME_BYTES || (file.type && file.type !== "application/pdf"))
    return NextResponse.json({ error: "pdf_only_8mb" }, { status: 400 });

  const storageKey = process.env.SUPABASE_STORAGE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = process.env.SUPABASE_URL;
  if (!storageKey || !base) return NextResponse.json({ error: "storage_unavailable" }, { status: 502 });

  const safeName = (file.name || "resume.pdf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
  const up = await fetch(`${base}/storage/v1/object/resumes/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${storageKey}`,
      apikey: storageKey,
      "Content-Type": "application/pdf",
    },
    body: new Uint8Array(await file.arrayBuffer()),
  });
  if (!up.ok) {
    console.error("drawer resume upload failed", up.status, await up.text());
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }

  if (!(await saveUnifiedResumePath(member.org.id, key, path)))
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    resumeUrl: await signResumeUrl(path),
    resumeName: resumeNameFromPath(path),
    hasResume: true,
  });
}
