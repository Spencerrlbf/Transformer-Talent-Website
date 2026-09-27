import { randomUUID } from "node:crypto";
import {
  transitionSupport,
  transitionUuid,
} from "../person-transition/context";
import {
  beginPersonTransaction,
  type PersonConnection,
  withPersonConnection,
} from "./save";
import { TT_ORG_ID } from "./normalize";
import {
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
  mode: "shadow";
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
    a.mode !== "shadow"
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
    const owners = (
      await c.query(
        `select id from public.candidates where lower(linkedin_username)=any($1::text[]) or directory_contact_id=$2 or airtable_id=any($3::text[])
      union select candidate_id id from public.candidate_identities i join jsonb_to_recordset($4::jsonb) x(kind text,value text) on i.kind=x.kind and i.value=x.value`,
        [
          usernames,
          snapshot.board.contact_id,
          identities
            .filter((x) => x.kind === "airtable_id")
            .map((x) => x.value),
          JSON.stringify(identities),
        ],
      )
    ).rows;
    const ids = [...new Set(owners.map((x) => x.id))];
    if (ids.length !== 1)
      throw Error(
        ids.length
          ? "directory_identity_conflict"
          : "directory_creation_unavailable",
      );
    const input = (
      await c.query(
        "select person_private.directory_bind($1,$2,$3::jsonb) result",
        [a.executionId, ids[0], JSON.stringify(identities)],
      )
    ).rows[0].result;
    const evidence = captureDirectoryAdmissionEvidence(input),
      decision = evaluateDirectoryAdmission(evidence);
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
