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
export type { AdvanceResult } from "./sourcing/run";
