import { NextRequest, NextResponse } from "next/server";

const MAX = { name: 120, email: 254, linkedin: 300, role: 120, note: 2000 };

export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot: real users never fill this hidden field.
  if (body.website) {
    return NextResponse.json({ ok: true });
  }

  const name = (body.name || "").trim().slice(0, MAX.name);
  const email = (body.email || "").trim().slice(0, MAX.email);
  const linkedin = (body.linkedin || "").trim().slice(0, MAX.linkedin);
  const role = (body.role || "").trim().slice(0, MAX.role);
  const note = (body.note || "").trim().slice(0, MAX.note);

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "Please provide your name and a valid email." },
      { status: 400 }
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      {
        error:
          "Applications are temporarily offline — please email spencer@transformertalent.com directly.",
      },
      { status: 503 }
    );
  }

  const details = [
    role && `Role interest: ${role}`,
    linkedin && `LinkedIn: ${linkedin}`,
    note && `Note: ${note}`,
    "Source: transformertalent.com apply form",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(`${supabaseUrl}/rest/v1/applications`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      full_name: name,
      email,
      resume: details,
      stage: "website_inbound",
      created_by: "website",
      date_applied: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    console.error("apply insert failed", res.status, await res.text());
    return NextResponse.json(
      {
        error:
          "Something went wrong — please email spencer@transformertalent.com directly.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
