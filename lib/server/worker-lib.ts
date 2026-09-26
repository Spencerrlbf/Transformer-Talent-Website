// Single-source entry for the nightly worker: everything it shares with the
// website is exported here and bundled by scripts/build-worker-lib.mjs into
// scripts/dist/worker-lib.mjs. The worker must never carry hand-ported copies
// of this logic — bundle and import instead.
export { computeFacts, formatFacts, undergradEndYear } from "./facts";
export type { CandidateFacts, ExperienceRow } from "./facts";
export {
  getOrgId,
  harvestToExperiences,
  harvestToPoolRecord,
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

// Phase 2: who is worth judging for a role (scripts/build-shortlists.mjs).
export { rulesOf, assess } from "./shortlist/rules";
export type { RoleRules, PersonForShortlist, Assessment } from "./shortlist/rules";
export { expandLocations } from "./matcher";

// Phase 3: the light judge over the shortlists (scripts/judge-shortlists.mjs).
export { shortlistRoleContext, judgePoolCandidate, roleHashOf, SHORTLIST_ROLE_COLS } from "./shortlist/judge";
export type { ShortlistRoleRow, ShortlistRoleContext, PoolJudgement } from "./shortlist/judge";
export { JEV_MODEL } from "./rolecard/jev";

// Applications over their company's daily review allowance, reviewed
// nightly (scripts/review-queue.mjs).
export { reviewQueued, queuedCount } from "./review-queue";

// The person writer's translators (lib/server/person/): every source's data
// as one PersonDoc for save_person, and the projection back to today's
// candidates columns (the 50-person trial's before/after page and checks).
export { fromLegacyImport, legacyRaw, legacyFetchedAt, legacyUntouched, LEGACY_IMPORT_END } from "./person/fromLegacy";
export type { LegacyCandidateRow, LegacyEmailRow, LegacyEmailV2Row, LegacyCommunicationRow, LegacyRaw } from "./person/fromLegacy";
export { fromHarvest } from "./person/fromHarvest";
export { pickRefreshRows, pickRefreshRowsOnConnection, claimRefresh, storeRefreshPayload, saveRefresh, failRefresh, claimRefreshOnConnection, storeRefreshPayloadOnConnection, saveRefreshOnConnection, failRefreshOnConnection } from "./person/refresh";
export type { HarvestLedgerRow } from "./person/fromHarvest";
export { fromDirectory, directoryCheck, directoryPhoneValue, unmappedDirectoryStatuses, DIRECTORY_STATUSES } from "./person/fromDirectory";
export type { DirectoryBoardRow, DirectoryHarvestRow, DirectoryExperienceRow, DirectoryEducationRow, DirectoryEmailRow, DirectoryPhoneRow } from "./person/fromDirectory";
export { fromApplication } from "./person/fromApplication";
export type { ApplicationRow } from "./person/fromApplication";
export { project } from "./person/project";
export type { Projection, ProjectionInput, ProjectedPosition } from "./person/project";
export {
  PARSER_VERSION,
  TT_ORG_ID,
  jobRowKey,
  eduRowKey,
  skillKeyOf,
  splitSkill,
  normalizeEmail,
  normalizePhone,
  normalizedName,
  placeholderKey,
  parseLinkedinOrgUrl,
  companyOf,
  schoolOf,
  companyIdentity,
  degreeLevel,
  isSideRole,
  realJobFirst,
  mergeContacts,
  rankedContacts,
  checkClass,
  emailsInText,
  websiteContact,
  spanYears,
  stableStringify,
} from "./person/normalize";
export { isSideRoleTitle } from "./person/role-selection";
export type * from "./person/types";
export { savePerson, savePersonOnConnection, undoPersonProjectionOnConnection, semanticProfileHash, readPersonProjection, publishPersonProjectionOnConnection, PROFILE_FIELDS, projectionProfileHash } from './person/save';
export type { PublishPersonOptions, PublishPersonResult, PublishPersonStatus } from './person/save';
export { personWriteMode, saveApplicationPerson, saveApplicationPersonOnConnection, applicationProfileDoc } from './person/intake';

export { runApplicantPipeline } from './applicant-pipeline';
export {
  directoryDocuments, directoryIdentities, directorySnapshotHash, directoryPrimary,
} from './person/directory-sources';
export {
  claimDirectoryScan, stageDirectory, saveDirectory, checkpointDirectoryScan,
  claimDirectoryScanOnConnection, stageDirectoryOnConnection,
  saveDirectoryOnConnection, checkpointDirectoryScanOnConnection,
  pendingDirectoryEmbeddings, claimDirectoryEmbedding, saveDirectoryEmbedding,
  claimDirectoryEmbeddingOnConnection, saveDirectoryEmbeddingOnConnection,
  inspectDirectoryPage, inspectDirectoryPageOnConnection,
  pendingDirectoryReceipts, pendingDirectoryReceiptsOnConnection,
} from './person/directory';

export { saveRecruiterContact, saveRecruiterContactOnConnection } from './person/recruiter';
export { publishedPoolContacts, publishedPoolContactsOnConnection, effectivePoolContact } from './person/contacts';

export { poolEmails, listNetworkMatches, sendNetworkCandidate } from './network';
export { saveUnifiedContact, unifiedCandidateDetail } from './candidates-unified';

export { publishedPoolProfiles,publishedPoolProfilesOnConnection,canonicalProfileSnapshot } from './person/profile-view';
export { enqueuePersonDerivativesLocked, preparePersonDerivativesOnConnection, completePersonDerivativesOnConnection, failPersonDerivativesOnConnection, personDerivativeChunks, embedPersonDerivativeChunks, processPersonDerivatives, drainPersonDerivatives } from './person/derivatives';
export { prepareLegacyAuditAnchor } from './person/audit-anchor';
export { beginGuardedAuditOperationLocked, attributeAuditMutation, createReceiptAuditAnchorLocked } from './person/audit';
