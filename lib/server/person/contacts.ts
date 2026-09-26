// Contact reads for published pool profiles. No fallback to stale legacy
// contacts is allowed when a normalized read fails.
import { checkClass, normalizeEmail } from "./normalize";
import { withPersonConnection, type PersonConnection } from "./save";
import { personWriteMode } from "./intake";
export interface PoolContact {
  email?: string | null;
  phone?: string | null;
  github?: string | null;
  otherEmails?: string[] | null;
}
export interface ResolvedPoolContact {
  contact: PoolContact;
  emails: { email: string; verified: boolean }[];
}
export function eligiblePoolContact(row: any): boolean {
  return (
    row.status === "active" &&
    !row.never_primary &&
    (row.kind !== "email" || checkClass(row.quality, row.result) !== "bad")
  );
}
export function effectivePoolContact(
  rows: any[],
  overlay: PoolContact | null,
): ResolvedPoolContact {
  const eligible = rows
    .filter((row) => row.rank != null && eligiblePoolContact(row))
    .sort(
      (a, b) =>
        Number(a.rank) - Number(b.rank) ||
        String(a.value_normalized).localeCompare(String(b.value_normalized)),
    );
  const addresses = eligible.filter((row) => row.kind === "email");
  const primary = addresses[0]?.value_normalized ?? null;
  const byValue = new Map(addresses.map((row) => [row.value_normalized, row]));
  const requested = Array.isArray(overlay?.otherEmails)
    ? overlay!.otherEmails!
    : addresses.map((row) => row.value_normalized);
  const others = [
    ...new Set(
      requested
        .map(normalizeEmail)
        .filter(
          (value): value is string =>
            !!value && value !== primary && byValue.has(value),
        ),
    ),
  ];
  const github =
    typeof overlay?.github === "string" && overlay.github.trim()
      ? overlay.github.trim()
      : null;
  return {
    contact: {
      email: primary,
      phone:
        eligible.find((row) => row.kind === "phone")?.value_normalized ?? null,
      github,
      otherEmails: others,
    },
    emails: [...(primary ? [primary] : []), ...others].map((email) => ({
      email,
      verified:
        checkClass(byValue.get(email)?.quality, byValue.get(email)?.result) ===
        "good",
    })),
  };
}
export async function publishedPoolContactsOnConnection(
  c: PersonConnection,
  ids: string[],
): Promise<Map<string, ResolvedPoolContact>> {
  const out = new Map<string, ResolvedPoolContact>();
  if (ids.length > 1000) throw Error("person_contact_read_limit");
  for (let i = 0; i < ids.length; i += 100) {
    const rows = (
      await c.query(
        `select c.id,c.contact,
   coalesce((select jsonb_agg(jsonb_build_object('kind',cc.kind,'value_normalized',cc.value_normalized,'rank',cc.rank,'status',cc.status,'never_primary',cc.never_primary,'quality',cc.quality,'result',cc.result) order by cc.kind,cc.rank,cc.value_normalized) from public.candidate_contacts cc where cc.candidate_id=c.id and cc.kind in ('email','phone') and cc.rank is not null),'[]'::jsonb) contacts
   from public.candidates c join public.person_projection_state p on p.candidate_id=c.id
   where c.id=any($1::uuid[])`,
        [ids.slice(i, i + 100)],
      )
    ).rows;
    for (const row of rows)
      out.set(row.id, effectivePoolContact(row.contacts, row.contact));
  }
  return out;
}
export async function publishedPoolContacts(
  ids: string[],
): Promise<Map<string, ResolvedPoolContact>> {
  if (personWriteMode() !== "live" || !ids.length) return new Map();
  return withPersonConnection((c) => publishedPoolContactsOnConnection(c, ids));
}
