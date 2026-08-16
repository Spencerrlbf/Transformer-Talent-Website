// Canonical option lists + publish-quality thresholds for the dashboard job
// form. Client-safe (no server deps) — imported by the form UI, the JD
// extraction schema, and server-side validation so all three stay in step.
// City names are the role-side spellings of the same 10 markets candidates
// pick from (lib/server/locations.ts PATTERNS matches both).

export const ROLE_CITY_OPTIONS = [
  "San Francisco",
  "New York",
  "Miami",
  "Seattle",
  "Chicago",
  "Washington DC",
  "Austin",
  "Boston",
  "Los Angeles",
  "Canada",
] as const;

export const WORKPLACE_OPTIONS = ["Remote", "Hybrid", "On-site"] as const;

export const VISA_OPTIONS = [
  "US citizen / Green card only",
  "Visa transfers OK",
  "New visa sponsorship available",
  "OPT/CPT accepted",
  "No sponsorship",
] as const;

// Publish-quality bar: a role can't go live half-empty — the screening
// engine's output is only as good as the JD it reads.
export const MIN_JD_CHARS = 500; // pasted/uploaded JD before extraction runs
export const MIN_ABOUT_CHARS = 200; // "about the role" field
export const MIN_DOING = 3; // responsibilities
export const MIN_NEEDS = 3; // requirements
