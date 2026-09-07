// Naming the roles someone applied to, in a sentence. One field carries the
// naming and the grammar so a single template works whether they applied to
// one role or five, and the sentence around it reads the same either way.
// Shared by the composer's merge and the Settings preview.

/** "the A role" · "the A and B roles" · "the A, B and C roles" */
export function rolesPhrase(titles: string[]): string {
  const t = titles.map((s) => (s || "").trim()).filter(Boolean);
  if (t.length === 0) return "";
  if (t.length === 1) return `the ${t[0]} role`;
  return `the ${t.slice(0, -1).join(", ")} and ${t[t.length - 1]} roles`;
}

/** The subject: names the role when there is one, general above that,
 *  because three role titles make a subject line unreadable. */
export function appliedSubject(titles: string[], orgName: string): string {
  const t = titles.map((s) => (s || "").trim()).filter(Boolean);
  if (t.length === 1) return `Your application for ${t[0]}`;
  if (t.length > 1) return orgName.trim() ? `Your applications to ${orgName.trim()}` : "Your applications";
  return "Your application";
}

/** "on the A role" · "on both roles" · "on all 3 roles" — for the "when you
 *  send" line, where naming three titles again would be noise. */
export function movePhrase(titles: string[]): string {
  const t = titles.map((s) => (s || "").trim()).filter(Boolean);
  if (t.length === 0) return "";
  if (t.length === 1) return t[0];
  if (t.length === 2) return "both roles";
  return `all ${t.length} roles`;
}
