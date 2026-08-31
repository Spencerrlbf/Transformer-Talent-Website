// Supported social platforms for company boards, in board render order
// (the org website leads them as the globe icon). Shared by the server
// sanitizer, the board icon cluster, and the settings editor — keep it free
// of server imports so client bundles can use it.
export const SOCIAL_KEYS = [
  "linkedin",
  "x",
  "github",
  "youtube",
  "instagram",
  "facebook",
  "glassdoor",
  "crunchbase",
] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];
export type CompanySocials = Partial<Record<SocialKey, string>>;

export const SOCIAL_LABELS: Record<SocialKey, string> = {
  linkedin: "LinkedIn",
  x: "X",
  github: "GitHub",
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  glassdoor: "Glassdoor",
  crunchbase: "Crunchbase",
};

export const SOCIAL_PLACEHOLDERS: Record<SocialKey, string> = {
  linkedin: "https://linkedin.com/company/…",
  x: "https://x.com/…",
  github: "https://github.com/…",
  youtube: "https://youtube.com/@…",
  instagram: "https://instagram.com/…",
  facebook: "https://facebook.com/…",
  glassdoor: "https://glassdoor.com/…",
  crunchbase: "https://crunchbase.com/organization/…",
};
