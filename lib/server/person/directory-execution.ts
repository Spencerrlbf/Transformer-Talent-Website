import { randomUUID } from "node:crypto";
import {
  transitionSupport,
  transitionUuid,
} from "../person-transition/context";
import {
  compatibilityProjection,
  projectionEnvelope,
  readPersonProjection,
  beginPersonTransaction,
  type PersonConnection,
  withPersonConnection,
} from "./save";
import { poolProfileText, poolSignals } from "../pool/profile";
import { personDerivativeInput } from "./derivatives";
import { fromDirectory } from "./fromDirectory";
import { directoryDocuments } from "./directory-sources";
import { TT_ORG_ID, isoOf } from "./normalize";
import {
  directoryCanonicalUsername,
  directoryIdentities,
  directoryPrimary,
  type DirectorySnapshot,
} from "./directory-sources";
import {
  captureDirectoryAdmissionEvidence,
  evaluateDirectoryAdmission,
} from "./directory-admission";
export type CertifiedDirectoryRequest = {
  organizationId: string;
  workspaceId: string;
  receiptId: string | number;
  /** Persist this value across response-loss retries. */
  executionId: string;
  mode: "shadow" | "live";
};
/** Private direct writer. No caller-supplied candidate, snapshot or document.
 * This first slice deliberately does not route the nightly CLI or embeddings. */
export async function saveCertifiedDirectoryOnConnection(
  c: PersonConnection,
  a: CertifiedDirectoryRequest,
) {
  if (!transitionSupport()) throw Error("directory_execution_disabled");
  if (
    a.organizationId !== TT_ORG_ID ||
    !transitionUuid(a.workspaceId) ||
    !transitionUuid(a.executionId) ||
    !/^[1-9][0-9]*$/.test(String(a.receiptId)) ||
    !["shadow", "live"].includes(a.mode)
  )
    throw Error("directory_execution_input");
  try {
    let admission: any;
    await beginPersonTransaction(c, async () => {
      admission = (
        await c.query(
          "select person_private.directory_begin($1,$2,$3,$4,$5,$6) result",
          [
            a.organizationId,
            a.workspaceId,
            String(a.receiptId),
            a.executionId,
            a.mode,
            randomUUID(),
          ],
        )
      ).rows[0].result;
    });
    if (admission.status === "completed") {
      await c.query("commit");
      return admission.result;
    }
    const snapshot = admission.snapshot as DirectorySnapshot,
      identities = directoryIdentities(snapshot);
    const usernames = identities
      .filter((x) => x.kind === "linkedin_username")
      .map((x) => x.value)
      .sort();
    for (const username of usernames)
      await c.query("select pg_advisory_xact_lock(72007,hashtext($1))", [
        username,
      ]);
    for (const key of identities
      .filter((x) => x.kind !== "linkedin_username")
      .map((x) => `${x.kind}:${x.value}`)
      .sort())
      await c.query("select pg_advisory_xact_lock(72012,hashtext($1))", [key]);
    await c.query("select pg_advisory_xact_lock(72011,hashtext($1))", [
      snapshot.board.contact_id,
    ]);
    const terminal = (
      await c.query("select person_private.directory_outcome($1,$2) result", [
        a.executionId,
        JSON.stringify(identities),
      ])
    ).rows[0].result;
    if (terminal) {
      await c.query("commit");
      return terminal;
    }
    const owners = (
      await c.query(
        "select id from person_private.directory_identity_owners($1,$2)",
        [snapshot.board.contact_id, JSON.stringify(identities)],
      )
    ).rows;
    const ids = [...new Set(owners.map((x) => x.id))];
    if (ids.length > 1) throw Error("directory_identity_conflict");
    if (!ids.length) {
      const created = (
        await c.query("select person_private.directory_seed($1,$2,$3) id", [
          a.executionId,
          directoryCanonicalUsername(snapshot),
          JSON.stringify(identities),
        ])
      ).rows[0].id;
      ids.push(created);
    }
    const input = (
      await c.query(
        "select person_private.directory_bind($1,$2,$3::jsonb) result",
        [a.executionId, ids[0], JSON.stringify(identities)],
      )
    ).rows[0].result;
    const { createdPerson, ...decisionInput } = input;
    const evidence = input.adopted
        ? input.evidence
        : captureDirectoryAdmissionEvidence(decisionInput),
      decision = input.adopted
        ? input.decision
        : evaluateDirectoryAdmission(evidence);
    if (!input.adopted)
      await c.query(
        "select person_private.directory_seal($1,$2::jsonb,$3::jsonb,$4)",
        [
          a.executionId,
          JSON.stringify(evidence),
          JSON.stringify(decision),
          directoryPrimary(snapshot),
        ],
      );
    await c.query("select person_private.directory_audit_begin($1)", [
      a.executionId,
    ]);
    for (let i = 0; i < decision.docs.length; i++)
      await c.query("select person_private.directory_normalize($1,$2)", [
        a.executionId,
        i,
      ]);
    if (a.mode === "live" || createdPerson) {
      const id = ids[0];
      const before = (
        await c.query("select person_private.publication_candidate($1) value", [
          id,
        ])
      ).rows[0].value;
      const revision = (
        await c.query(
          "select person_private.directory_prepare($1)::text revision",
          [a.executionId],
        )
      ).rows[0].revision;
      const tables = await readPersonProjection(c, id);
      const state = (
        await c.query(
          "select * from public.candidate_profile_state where candidate_id=$1",
          [id],
        )
      ).rows[0];
      const computed = await compatibilityProjection(
        tables,
        state,
        before,
        async () => false,
      );
      await c.query("select person_private.directory_project($1,$2,$3)", [
        a.executionId,
        revision,
        projectionEnvelope(id, before, computed),
      ]);
      const profile = (
        await c.query("select person_private.publication_candidate($1) value", [
          id,
        ])
      ).rows[0].value;
      const years = poolSignals({
        ...profile,
        calculated_experience_years: null,
        total_experience_years: null,
      }).years;
      const historical = fromDirectory(
        snapshot.board,
        snapshot.harvest,
        snapshot.exps,
        snapshot.edus,
        snapshot.emails,
        snapshot.phones,
        id,
      );
      const harvest = directoryDocuments(snapshot, id).find((d) =>
        d.source.source_ref?.endsWith(":harvest"),
      );
      await c.query(
        "select person_private.directory_metadata($1,$2,$3,$4,$5)",
        [
          a.executionId,
          Number.isFinite(years) ? Math.round(years!) : null,
          JSON.stringify(
            [historical, ...(harvest ? [harvest] : [])].map((d) => d.source),
          ),
          isoOf(snapshot.board.follow_up_date)?.slice(0, 10) ?? null,
          isoOf(snapshot.harvest?.fetched_at),
        ],
      );
      const after = (
        await c.query("select person_private.publication_candidate($1) value", [
          id,
        ])
      ).rows[0].value;
      const data = await personDerivativeInput(c, id);
      const matching = (value: any) =>
        (
          poolProfileText(value) + ". actively engaged software candidate"
        ).slice(0, 8000);
      await c.query("select person_private.directory_enqueue($1,$2,$3,$4,$5)", [
        a.executionId,
        after,
        data,
        matching(after),
        matching(before),
      ]);
    }
    const result = (
      await c.query("select person_private.directory_complete($1) result", [
        a.executionId,
      ])
    ).rows[0].result;
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  }
}
export const saveCertifiedDirectory = (a: CertifiedDirectoryRequest) =>
  withPersonConnection((c) => saveCertifiedDirectoryOnConnection(c, a));
