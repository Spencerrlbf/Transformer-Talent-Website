// Server-side use of the shared target selection (scripts/person-target.mjs).
//
// The normalized-storage paths (PERSON_WRITE_MODE shadow/live, transition
// support on) write through two independently configured clients: REST via
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and PostgreSQL via PERSON_DATABASE_URL.
// A mixed configuration (REST on one project, PostgreSQL on another) passes
// visible UI testing while writing elsewhere. Whenever those paths are enabled,
// or PERSON_TARGET_PROJECT_REF is set at all, every client must name the one
// selected project or no connection is opened. Legacy mode with no selection
// keeps today's production behavior unchanged.
import {
  checkDatabaseUrl,
  checkRestUrl,
  checkServiceKey,
  hasSelectedTarget,
  selectedTarget,
} from "../../../scripts/person-target.mjs";

type Env = Record<string, string | undefined>;

export function personTargetRequired(env: Env = process.env): boolean {
  if (hasSelectedTarget(env)) return true;
  const mode = env.PERSON_WRITE_MODE;
  if (mode !== undefined && mode !== "" && mode !== "legacy") return true;
  return env.PERSON_TRANSITION_SUPPORT === "on";
}

let checked: { key: string; ref: string } | undefined;
function cacheKey(env: Env): string {
  return [
    env.PERSON_TARGET_PROJECT_REF,
    env.PERSON_WRITE_MODE,
    env.PERSON_TRANSITION_SUPPORT,
    env.SUPABASE_URL,
    env.PERSON_DATABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY?.length,
  ].join("\u0000");
}

/** Validates REST URL, service key and PERSON_DATABASE_URL against the selected
 * project. Returns the selected ref, or null when no selection is required.
 * Throws `person_target:*` (never the configured values) on any mismatch. */
export function assertServerTarget(env: Env = process.env): string | null {
  if (!personTargetRequired(env)) return null;
  const key = cacheKey(env);
  if (checked?.key === key) return checked.ref;
  const target = selectedTarget(env);
  if (env.SUPABASE_URL !== undefined) checkRestUrl(env.SUPABASE_URL, target);
  if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined) checkServiceKey(env.SUPABASE_SERVICE_ROLE_KEY, target);
  if (env.PERSON_DATABASE_URL !== undefined) checkDatabaseUrl(env.PERSON_DATABASE_URL, target);
  checked = { key, ref: target.ref };
  return target.ref;
}

/** Test seam only. */
export function resetServerTargetCache(): void {
  checked = undefined;
}
