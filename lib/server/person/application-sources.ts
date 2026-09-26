// Strict, tenant-scoped cached Harvest access. Cached reads retain the original
// ledger id/date, and a fresh paid result is durable before resume processing.
import { sbRest } from "../supabase";
import {
  extractEmails,
  extractPhone,
  normalizePhone,
} from "../contact-extract";
import type { ParsedProfile } from "../applicants";
import { TT_ORG_ID } from "./normalize";
export async function cachedApplicationHarvest(
  org: string,
  username: string,
  since: string,
  ledgerId?: string,
): Promise<{ id: string; raw_payload: unknown } | null> {
  if (org !== TT_ORG_ID) throw Error("person_intake_tenant");
  const result = await sbRest(
    `candidate_enrichments?organization_id=eq.${org}&linkedin_username=eq.${encodeURIComponent(username)}&provider=eq.harvest&status=eq.ok&raw_payload=not.is.null${ledgerId ? `&id=eq.${encodeURIComponent(ledgerId)}` : `&created_at=gte.${encodeURIComponent(since)}`}&select=id,raw_payload&order=created_at.desc,id.desc&limit=1`,
  );
  if (!result.ok) throw Error("person_intake_cache_read");
  return (await result.json())[0] ?? null;
}
export async function storeApplicationHarvest(
  org: string,
  username: string,
  payload: unknown,
): Promise<string> {
  if (org !== TT_ORG_ID) throw Error("person_intake_tenant");
  const result = await sbRest("candidate_enrichments?select=id", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({
      organization_id: org,
      candidate_id: null,
      linkedin_username: username,
      provider: "harvest",
      operation: "full_profile",
      cache_status: "miss",
      status: "ok",
      raw_payload: payload,
      cost_credits: 1,
    }),
  });
  if (!result.ok) throw Error("person_intake_cache_write");
  const id = (await result.json())[0]?.id;
  if (!id) throw Error("person_intake_cache_write");
  return id;
}

export async function applicationIntakeReceipt(
  org: string,
  applicationId: string,
): Promise<{
  application_snapshot: {
    parsed_profile: import("../applicants").ParsedProfile | null;
  };
  harvest_ledger_id: string | null;
} | null> {
  if (org !== TT_ORG_ID) throw Error("person_intake_tenant");
  const result = await sbRest(
    `person_application_receipts?application_id=eq.${encodeURIComponent(applicationId)}&select=application_snapshot,harvest_ledger_id&limit=1`,
  );
  if (!result.ok) throw Error("person_intake_receipt_read");
  return (await result.json())[0] ?? null;
}

export function applicationResumeContacts(
  parsed: ParsedProfile | null,
  resumeText: string | null,
  email: string,
): { phone?: string | null; email?: string | null; emails?: string[] } {
  if (!resumeText) return {};
  const phone = parsed
    ? normalizePhone(parsed.phone) || extractPhone(resumeText.slice(0, 1500))
    : extractPhone(resumeText);
  const modelEmail = (parsed?.email || "").trim();
  return parsed
    ? {
        phone,
        email:
          modelEmail && modelEmail.toLowerCase() !== email.toLowerCase()
            ? modelEmail
            : null,
      }
    : { phone, emails: extractEmails(resumeText, email) };
}
