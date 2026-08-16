// Location gate for candidate -> role matching (the JD -> candidate
// direction has its own filter in the matcher). One rule, used by the
// apply flow, the nightly precompute, and the stretch channel:
//   - remote roles are always eligible
//   - hybrid/on-site roles need the candidate's selected locations (or,
//     when none selected, their LinkedIn location) to intersect the role's
//     cities
//   - completely unknown location passes — humans judge from the card.

export const LOCATION_OPTIONS = [
  "SF",
  "NYC",
  "Miami",
  "Seattle",
  "Chicago",
  "Washington DC",
  "Austin",
  "Boston",
  "Los Angeles",
  "Canada",
] as const;
export type LocationOption = (typeof LOCATION_OPTIONS)[number];

// Lowercase substrings that identify each option in role location lists
// AND in candidate free-text locations ("San Francisco, CA").
const PATTERNS: Record<string, string[]> = {
  SF: ["san francisco", "bay area", "south bay", "oakland", "berkeley", "palo alto", "mountain view", "san jose", "sunnyvale", "menlo park", "redwood city", "cupertino", "santa clara"],
  NYC: ["new york", "nyc", "brooklyn", "manhattan", "jersey city", "hoboken"],
  Miami: ["miami", "florida", "fort lauderdale"],
  Seattle: ["seattle", "bellevue", "redmond", "kirkland"],
  Chicago: ["chicago", "evanston"],
  "Washington DC": ["washington", "dmv", "arlington", "alexandria"],
  Austin: ["austin", "texas", "round rock"],
  Boston: ["boston", "cambridge", "somerville"],
  "Los Angeles": ["los angeles", "santa monica", "culver city", "pasadena"],
  Canada: ["canada", "toronto", "vancouver", "montreal", "ottawa"],
};

export function sanitizeLocationOptions(values: string[]): string[] {
  const valid = new Set<string>(LOCATION_OPTIONS);
  return [...new Set(values.filter((v) => valid.has(v)))];
}

// Map a free-text location ("San Francisco, CA") to option keys.
export function optionsFromFreeText(location: string | null | undefined): string[] {
  const loc = (location || "").toLowerCase();
  if (!loc) return [];
  return LOCATION_OPTIONS.filter((opt) => PATTERNS[opt].some((p) => loc.includes(p)));
}

export function roleLocationCompatible(
  role: { locations?: string[] | null; workplace?: string | null },
  preferred: string[],
  freeTextLocation?: string | null
): boolean {
  // Remote (incl. "On-site or Remote") is location-free.
  if (/remote/i.test(role.workplace || "")) return true;
  const prefs = preferred.length ? sanitizeLocationOptions(preferred) : optionsFromFreeText(freeTextLocation);
  if (!prefs.length) return true; // unknown location — pass, human judges
  const roleLocs = (role.locations || []).map((l) => l.toLowerCase());
  if (!roleLocs.length) return true; // unlocated role — pass
  return prefs.some((opt) => PATTERNS[opt].some((p) => roleLocs.some((l) => l.includes(p) || p.includes(l))));
}
