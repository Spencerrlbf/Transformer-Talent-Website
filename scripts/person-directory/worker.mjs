// Sequential source observations under a fenced website lease. No outbound
// messages or Harvest requests. Optional embeddings have a separate hard cap.
export async function runDirectory({
  lib,
  reader,
  workspaceId,
  mode,
  dry = false,
  limit = 100000,
  pageSize = 100,
}) {
  if (!["shadow", "live"].includes(mode)) throw Error("person_directory_mode");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000)
    throw Error("person_directory_limit");
  const key = { organizationId: lib.TT_ORG_ID, workspaceId };
  const lease = dry
    ? { token: null, cursor: "0" }
    : await lib.claimDirectoryScan(key);
  if (lease.status === "busy") return { status: "busy" };
  let cursor = lease.cursor,
    complete = false;
  const stats = {
    status: "done",
    read: 0,
    recovered: 0,
    unchanged: 0,
    saved: 0,
    review: 0,
    suppressed: 0,
  };
  const checkpoint = async (release = false) => {
    if (!dry)
      await lib.checkpointDirectoryScan({
        ...key,
        token: lease.token,
        cursor,
        release,
        complete,
      });
  };
  try {
    if (!dry && lib.pendingDirectoryReceipts) {
      while (stats.recovered < limit) {
        const pending = await lib.pendingDirectoryReceipts({
          ...key,
          token: lease.token,
          limit: Math.min(100, limit - stats.recovered),
        });
        if (!pending.length) break;
        for (const receiptId of pending) {
          const result = await lib.saveDirectory({
            organizationId: key.organizationId,
            receiptId,
            mode,
          });
          stats.recovered++;
          if (result.status === "done") {
            stats.saved++;
            stats.review += result.reviewCount ?? 0;
          } else if (result.status === "suppressed") stats.suppressed++;
          else stats.review++;
        }
        await checkpoint();
      }
    }
    while (stats.read + stats.recovered < limit) {
      const ids = (
        await reader.page(
          cursor,
          Math.min(pageSize, limit - stats.read - stats.recovered),
        )
      ).slice(0, limit - stats.read - stats.recovered);
      if (!ids.length) {
        complete = true;
        break;
      }
      const snapshots = await reader.snapshots(ids);
      const inspected = new Map(
        !dry && lib.inspectDirectoryPage
          ? (
              await lib.inspectDirectoryPage({
                ...key,
                token: lease.token,
                snapshots: [...snapshots.values()],
              })
            ).map((r) => [r.contactId, r])
          : [],
      );
      for (const id of ids) {
        const snapshot = snapshots.get(id);
        // A disappearance between discovery and snapshot is retried instead of
        // silently acknowledging a source we did not actually read.
        if (!snapshot) throw Error("person_directory_source_disappeared");
        if (dry) {
          lib.directoryDocuments(snapshot, id);
        } else {
          let consumed = false;
          for (let attempt = 0; attempt < 3 && !consumed; attempt++) {
            const receipt =
              attempt === 0 && inspected.has(id)
                ? inspected.get(id)
                : await lib.stageDirectory({
                    ...key,
                    token: lease.token,
                    snapshot,
                  });
            if (
              receipt.phase === "done" &&
              (mode === "shadow" || receipt.projected)
            ) {
              stats.unchanged++;
              stats.review += receipt.reviewCount ?? 0;
            } else {
              const result = await lib.saveDirectory({
                organizationId: key.organizationId,
                receiptId: receipt.receiptId,
                mode,
              });
              if (result.status === "done") {
                stats.saved++;
                stats.review += result.reviewCount ?? 0;
              } else if (result.status === "suppressed") stats.suppressed++;
              else stats.review++;
            }
            consumed = !receipt.pendingPrevious;
          }
          if (!consumed) throw Error("person_directory_pending_receipt");
        }
        cursor = id;
        stats.read++;
      }
      if (stats.read + stats.recovered < limit) await checkpoint();
    }
    await checkpoint(true);
    return stats;
  } catch (error) {
    // The cursor always stops before an unsuccessful save. Its immutable
    // receipt remains ready; the next claim re-reads and retries that contact.
    await checkpoint(true).catch(() => {});
    throw error;
  }
}
export async function main() {
  const lib = await import("../dist/worker-lib.mjs");
  const { openComms, commsColumns, readDirectory, missingComms } =
    await import("../person-trial.mjs");
  const mode = lib.personWriteMode();
  if (mode === "legacy") throw Error("person_directory_legacy_entry");
  if (!process.env.COMMS_DATABASE_URL)
    throw Error("person_directory_comms_required");
  const db = await openComms(process.env.COMMS_DATABASE_URL);
  try {
    const cols = await commsColumns(db);
    if (missingComms(cols).length || !cols.has("comms.identifiers"))
      throw Error("person_directory_schema");
    const workspaces = (
      await db.query("select id,name from comms.workspaces order by id")
    ).rows;
    const wanted = process.env.COMMS_WORKSPACE?.trim();
    const workspace = wanted
      ? workspaces.find((x) => x.name === wanted)
      : workspaces.length === 1
        ? workspaces[0]
        : null;
    if (!workspace) throw Error("person_directory_workspace");
    const reader = {
      page: async (cursor, size) =>
        (
          await db.query(
            "select v.contact_id from board.candidates v join comms.contacts c on c.id=v.contact_id where c.workspace_id=$1 and v.contact_id>$2::uuid order by v.contact_id limit $3",
            [
              workspace.id,
              cursor === "0" ? "00000000-0000-0000-0000-000000000000" : cursor,
              size,
            ],
          )
        ).rows.map((x) => x.contact_id),
      snapshots: (ids) => readDirectory(db, ids, cols, { provenance: true }),
    };
    const limit = Number(process.env.LIMIT || 0) || 100000;
    const result = await runDirectory({
      lib,
      reader,
      workspaceId: workspace.id,
      mode,
      dry: !!process.env.DRY_RUN,
      limit,
    });
    const derivatives =
      !process.env.DRY_RUN && mode === "live" && process.env.OPENAI_API_KEY
        ? await drainDirectoryEmbeddings({
            lib,
            workspaceId: workspace.id,
            limit: Number(process.env.PERSON_DIRECTORY_EMBED_LIMIT ?? 50),
          })
        : { embedded: 0, stale: 0, failed: 0 };
    console.log(
      JSON.stringify({
        phase: "normalized_directory_complete",
        ...result,
        ...derivatives,
      }),
    );
  } finally {
    await db.end();
  }
}

/** A hard maximum of fifty requests per invocation. Queued work persists
 * in receipts across capped runs; profile revision is checked before commit. */
export async function drainDirectoryEmbeddings({
  lib,
  workspaceId,
  limit = 50,
}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 50)
    throw Error("person_directory_derivative_limit");
  const result = { embedded: 0, stale: 0, failed: 0 };
  if (!limit) return result;
  const ids = await lib.pendingDirectoryEmbeddings({
    organizationId: lib.TT_ORG_ID,
    workspaceId,
    limit,
  });
  for (const receiptId of ids.slice(0, limit)) {
    const key = { organizationId: lib.TT_ORG_ID, receiptId };
    const claim = await lib.claimDirectoryEmbedding(key);
    if (claim.status !== "claimed") continue;
    try {
      const vectors = await lib.embedTexts([claim.text]);
      const saved = await lib.saveDirectoryEmbedding({
        ...key,
        token: claim.token,
        vector: vectors[0],
      });
      if (saved.status === "saved") result.embedded++;
      else result.stale++;
    } catch {
      result.failed++;
    } // no source text/API error body in public Actions logs
  }
  return result;
}
