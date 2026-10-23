import { TT_ORG_ID } from "./normalize";
import {
  transitionSupport,
  transitionUuid,
} from "../person-transition/context";
import {
  beginPersonTransaction,
  withPersonConnection,
  type PersonConnection,
} from "./save";
type Request = {
  organizationId: string;
  workspaceId: string;
  receiptId: string | number;
};
export type CertifiedDirectoryCurrent =
  | { status: "ready" }
  | {
      status: "completed";
      mode: "shadow" | "live";
      disposition: "normalized" | "outcome";
      result: Record<string, any>;
    };
/** A completed public receipt alone cannot authorize a worker to skip intake. */
export async function readCertifiedDirectoryCurrentOnConnection(
  c: PersonConnection,
  a: Request,
): Promise<CertifiedDirectoryCurrent> {
  if (!transitionSupport()) throw Error("directory_current_disabled");
  if (
    a.organizationId !== TT_ORG_ID ||
    !transitionUuid(a.workspaceId) ||
    !/^[1-9][0-9]*$/.test(String(a.receiptId))
  )
    throw Error("directory_current_input");
  try {
    await beginPersonTransaction(c);
    const out = (
      await c.query(
        "select person_private.directory_current($1,$2,$3) result",
        [a.organizationId, a.workspaceId, String(a.receiptId)],
      )
    ).rows[0].result;
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}
export const readCertifiedDirectoryCurrent = (a: Request) =>
  withPersonConnection((c) => readCertifiedDirectoryCurrentOnConnection(c, a));
