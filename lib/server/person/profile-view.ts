import {
  poolDisplayPositions,
  poolExperiences,
  poolEducation,
  poolSkills,
  type PoolCandidate,
} from "../pool/profile";
import { effectivePoolContact, type ResolvedPoolContact } from "./contacts";
import { publishedPersonRowsOnConnection } from "./published";
import { withPersonConnection, type PersonConnection } from "./save";
import { personWriteMode } from "./intake";
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
/** Existing drawer/Send schema, built only from the published compatibility
 * columns. Empty canonical arrays are meaningful, never a raw-data fallback. */
export function canonicalProfileSnapshot(
  profile: PoolCandidate & Record<string, any>,
) {
  const facts = poolExperiences(profile);
  const positions = Array.isArray(profile.work_experience)
    ? profile.work_experience.filter((p) => p && typeof p === "object")
    : [];
  return {
    profileStorageVersion: "tt-published-1",
    headline: text(profile.headline),
    location: text(profile.location),
    photo: text(profile.profile_picture_url),
    about: text(profile.profile_summary),
    linkedinUrl: text(profile.linkedin_url),
    experience: poolDisplayPositions(profile).map((p, index) => {
      const row = positions[index],
        fact = facts[index];
      const current =
        typeof row?.is_current === "boolean" ? row.is_current : fact.is_current;
      const endLabel = current ? "Present" : p.to === "Present" ? null : p.to;
      return {
        position: p.title ?? undefined,
        companyName: p.company ?? undefined,
        companyLinkedinUrl: p.companyLinkedinUrl ?? undefined,
        duration: p.duration ?? undefined,
        location: p.location ?? undefined,
        description: p.description ?? undefined,
        employmentType: text(row?.employment_type),
        is_current: current,
        startDate: fact.start_year
          ? {
              year: fact.start_year,
              month: fact.start_month ?? undefined,
              text: p.from ?? undefined,
            }
          : undefined,
        endDate: current
          ? { text: "Present" }
          : fact.end_year
            ? {
                year: fact.end_year,
                month: fact.end_month ?? undefined,
                text: endLabel ?? undefined,
              }
            : undefined,
        datesText: [p.from, endLabel].filter(Boolean).join(" – ") || null,
      };
    }),
    education: poolEducation(profile).map((e) => ({
      schoolName: e.schoolName,
      degree: e.degree ?? undefined,
      fieldOfStudy: e.fieldOfStudy ?? undefined,
    })),
    skills: poolSkills(profile).map((name) => ({ name })),
  };
}
export interface PublishedPoolProfile extends ResolvedPoolContact {
  profile: Record<string, any> & PoolCandidate;
  revision: string;
  harvest: ReturnType<typeof canonicalProfileSnapshot>;
}
export async function publishedPoolProfilesOnConnection(
  c: PersonConnection,
  ids: string[],
): Promise<Map<string, PublishedPoolProfile>> {
  const rows = await publishedPersonRowsOnConnection(c, ids),
    result = new Map<string, PublishedPoolProfile>();
  for (const [id, row] of rows) {
    const {
      contacts,
      held,
      profile_hash,
      normalized_revision,
      published_revision,
      ...profile
    } = row;
    result.set(id, {
      profile,
      revision: String(published_revision),
      harvest: canonicalProfileSnapshot(profile),
      ...effectivePoolContact(contacts, profile.contact),
    });
  }
  return result;
}
export async function publishedPoolProfiles(
  ids: string[],
): Promise<Map<string, PublishedPoolProfile>> {
  if (personWriteMode() !== "live" || !ids.length) return new Map();
  return withPersonConnection((c) => publishedPoolProfilesOnConnection(c, ids));
}
