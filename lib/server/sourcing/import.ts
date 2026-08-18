// Normalization of a Harvest full-profile payload into a sourced_candidates
// row + the text that gets embedded for ranking. Reuses the spine helpers so
// a sourced profile and an applicant profile read identically downstream.
import { computeFacts } from "../facts";
import { harvestToExperiences, linkedinProfileText } from "../spine";
import { linkedinUsernameFromUrl } from "./harvest";

export interface SourcedFields {
  linkedin_username: string | null;
  linkedin_url: string | null;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  current_title: string | null;
  current_company: string | null;
  skills: string[];
  years_experience: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function profileToFields(profile: Record<string, unknown>): SourcedFields {
  const skills = (Array.isArray(profile.skills) ? profile.skills : [])
    .map((s) => str((s as Record<string, unknown>)?.name))
    .filter((s): s is string => !!s);
  const expList = Array.isArray(profile.experience) ? (profile.experience as Record<string, unknown>[]) : [];
  const current =
    expList.find((e) => /present/i.test(str((e.endDate as Record<string, unknown>)?.text) || "")) || expList[0];
  const location = profile.location as Record<string, unknown> | string | null;
  const facts = computeFacts(harvestToExperiences(profile), [], skills, profile.education ?? null);
  const username =
    str(profile.publicIdentifier) || linkedinUsernameFromUrl(str(profile.linkedinUrl));
  return {
    linkedin_username: username,
    linkedin_url: username
      ? `https://www.linkedin.com/in/${username}/`
      : str(profile.linkedinUrl),
    full_name:
      [str(profile.firstName), str(profile.lastName)].filter(Boolean).join(" ").trim() || null,
    headline: str(profile.headline),
    location:
      typeof location === "string"
        ? str(location)
        : str(location?.linkedinText) || str((location?.parsed as Record<string, unknown>)?.text),
    current_title: str(current?.position) || str(current?.title),
    current_company: str(current?.companyName) || str(current?.company),
    skills,
    years_experience: facts.careerYears,
  };
}

/** Text embedded once per sourced candidate — same profile text the site embeds for applicants. */
export function sourcedEmbedText(profile: Record<string, unknown>): string {
  return linkedinProfileText(profile).slice(0, 6000);
}
