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
import { createHash } from "node:crypto";
import {
  checkDatabaseUrl,
  checkRestUrl,
  checkServiceKey,
  hasSelectedTarget,
  isLoopbackDatabaseUrl,
  isSealedRestUrl,
  isTargetError,
  selectedTarget,
  verifyRuntimeIdentity,
  IDENTITY_SQL,
} from "../../../scripts/person-target.mjs";
export { isTargetError, IDENTITY_SQL };

type Env = Record<string, string | undefined>;

/** A selection is required whenever one is set, or whenever a normalized-storage
 * path is enabled and either client could reach a hosted project. A sealed local
 * fixture (loopback PostgreSQL, loopback or `.invalid` REST) has nothing hosted
 * to protect and needs none. */
export function personTargetRequired(env: Env = process.env): boolean {
  if (hasSelectedTarget(env)) return true;
  const mode = env.PERSON_WRITE_MODE;
  const normalized = (mode !== undefined && mode !== "" && mode !== "legacy") || env.PERSON_TRANSITION_SUPPORT === "on";
  if (!normalized) return false;
  return !(isSealedRestUrl(env.SUPABASE_URL) && isLoopbackDatabaseUrl(env.PERSON_DATABASE_URL));
}

let checked: { key: string; ref: string } | undefined;
function cacheKey(env: Env): string {
  return [
    env.PERSON_TARGET_PROJECT_REF,
    env.PERSON_WRITE_MODE,
    env.PERSON_TRANSITION_SUPPORT,
    env.SUPABASE_URL,
    env.PERSON_DATABASE_URL,
    // Keys for different projects share a length; hash the whole value.
    env.SUPABASE_SERVICE_ROLE_KEY === undefined ? "" : createHash("sha256").update(env.SUPABASE_SERVICE_ROLE_KEY).digest("hex"),
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

// Runtime half of the gate (20261013090000). The offline checks above prove what the
// configuration NAMES; this proves what the client REACHES: the database must hold the
// selected project's label (person_private.target_identity, written once by an
// operator) and report it through person_target_identity(). A copy restored from a
// backup shares the cluster identifier with its source, so the label is the only
// runtime signal that separates them. One proof per client kind per configuration per
// process; a failed proof is not cached, so a corrected database is proved again.
// Throws `person_target:identity_unlabelled` / `identity_label_mismatch` /
// `identity_rest` / `identity_database`, never the payload.
const proofs = new Map<string, Promise<string>>();
export function assertServerIdentity(
  client: "rest" | "database",
  read: () => Promise<unknown>,
  env: Env = process.env,
): Promise<string | null> {
  const ref = assertServerTarget(env);
  if (ref === null) return Promise.resolve(null);
  const key = `${client}\u0000${cacheKey(env)}`;
  let proof = proofs.get(key);
  if (!proof) {
    const readers = { readRest: client === "rest" ? read : undefined, readDatabase: client === "database" ? read : undefined, ref };
    proof = (verifyRuntimeIdentity(readers as never) as Promise<{ key: string }>).then((identity) => identity.key);
    proofs.set(key, proof);
    proof.catch(() => {
      if (proofs.get(key) === proof) proofs.delete(key);
    });
  }
  return proof;
}

/** Test seam only. */
export function resetServerTargetCache(): void {
  checked = undefined;
  proofs.clear();
}
