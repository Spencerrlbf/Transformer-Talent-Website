// Contact reads for published pool profiles. No fallback to stale legacy
// contacts is allowed when a normalized read fails.
import { checkClass, normalizeEmail } from "./normalize";
import { withPersonConnection, type PersonConnection } from "./save";
import { personWriteMode } from "./intake";
import { publishedPersonRowsOnConnection } from "./published";
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
  const rows = await publishedPersonRowsOnConnection(c, ids);
  for (const [id, row] of rows) out.set(id, effectivePoolContact(row.contacts, row.contact));
  return out;
}
export async function publishedPoolContacts(
  ids: string[],
): Promise<Map<string, ResolvedPoolContact>> {
  if (personWriteMode() !== "live" || !ids.length) return new Map();
  return withPersonConnection((c) => publishedPoolContactsOnConnection(c, ids));
}
