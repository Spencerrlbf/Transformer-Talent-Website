// Future-interest preference vocabularies, shared by the public form and the
// API's validation. Fixed taxonomy on purpose: disciplines are comparable
// across pages and stable over time, where role titles are neither.

export const ROLE_FOCUS_OPTIONS = [
  "Backend",
  "Frontend",
  "Full stack / product engineering",
  "AI/ML engineering",
  "Research",
  "Data",
  "Infrastructure & platform",
  "Forward deployed / solutions",
  "GTM",
  "Engineering leadership",
] as const;

export const WORKPLACE_OPTIONS = ["Remote", "Hybrid", "On-site"] as const;

export const SALARY_BAND_OPTIONS = ["$100k+", "$150k+", "$200k+", "$250k+", "$300k+"] as const;
