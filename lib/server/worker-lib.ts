// Single-source entry for the nightly worker: everything it shares with the
// website is exported here and bundled by scripts/build-worker-lib.mjs into
// scripts/dist/worker-lib.mjs. The worker must never carry hand-ported copies
// of this logic — bundle and import instead.
export { computeFacts, formatFacts, undergradEndYear } from "./facts";
export type { CandidateFacts, ExperienceRow } from "./facts";
export {
  getOrgId,
  harvestToExperiences,
  linkedinProfileText,
  recordEnrichment,
  syncExperiences,
  syncCandidateEmbeddings,
} from "./spine";
export { screenRolesWithCache } from "./screening";
export type { RoleVerdict, InferredSignal } from "./screening";
export { findStretchRoles } from "./stretch";
export { roleLocationCompatible, optionsFromFreeText } from "./locations";
export { computeTier, classifySeniority, checkStack, buildScorecard, renderScorecard } from "./scorecard";
export {
  generateMatchingProfile,
  matchingProfileRequestBody,
  matchingProfileSource,
  siteEmbeddingText,
  facetTexts,
  orgRoleRow,
  embedTexts,
  EMBED_MODEL,
  EMBED_DIMS,
} from "./roles-pipeline";
export type { RoleInput, MatchingProfile } from "./roles-pipeline";
export { advanceRun, RunFailure } from "./sourcing/run";
// A role's scorecard, drafted and saved the first time it is needed: the
// job page does this on open, scripts/draft-open-roles.mjs does it for
// every open role at once.
export { ensureRoleCard, ROLE_CARD_COLS, roleDraftInput } from "./rolecard/store";
export type { RoleForCard } from "./rolecard/store";
export { canDraft } from "./rolecard/draft";

// The pool as the judge and the signals read it (scripts/compute-signals.mjs).
export { poolExperiences, poolEducation, poolProfileText, poolSignals, poolSkills, poolSourceHash } from "./pool/profile";
export type { PoolCandidate, PersonSignals } from "./pool/profile";
export { titleFamilyOf, topEmployerOf, topUniversityOf, normalise } from "./signals/match";
export { TOP_EMPLOYERS, TOP_UNIVERSITIES } from "./signals/lists";
export type { AdvanceResult } from "./sourcing/run";
