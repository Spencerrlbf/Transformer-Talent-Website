import {
  beginGuardedAuditOperationLocked,
  attributeAuditMutation,
} from "./audit";
// Server/worker only. Paid requests happen outside these bounded transactions.
import { randomUUID } from "node:crypto";
import { TT_ORG_ID } from "./normalize";
import { fromHarvest } from "./fromHarvest";
import { poolSignals } from "../pool/profile";
import { enqueuePersonDerivativesLocked } from "./derivatives";
import {
  beginPersonTransaction,
  lockPerson,
  savePersonLocked,
  withPersonConnection,
  type PersonConnection,
} from "./save";

type Key = { organizationId: string; queueId: string };
type Token = Key & { token: string };
const modeOk = (mode: string) => mode === "shadow" || mode === "live";
function scope(args: Key) {
  if (args.organizationId !== TT_ORG_ID) throw Error("person_refresh_tenant");
}
async function transaction<T>(
  c: PersonConnection,
  args: Key,
  fn: (row: any, attempt: any) => Promise<T>,
  budget = false,
): Promise<T> {
  scope(args);
  try {
    await beginPersonTransaction(c);
    if (budget) await c.query("select pg_advisory_xact_lock(72010,0)");
    const peek = (
      await c.query(
        "select candidate_id from public.refresh_queue where id=$1 and organization_id=$2",
        [args.queueId, TT_ORG_ID],
      )
    ).rows[0];
    if (!peek) {
      const out = await fn(null, null);
      await c.query("commit");
      return out;
    }
    await c.query("select pg_advisory_xact_lock(72009,hashtext($1))", [
      peek.candidate_id,
    ]);
    const row = (
      await c.query(
        "select * from public.refresh_queue where id=$1 and organization_id=$2 for update",
        [args.queueId, TT_ORG_ID],
      )
    ).rows[0];
    if (row?.candidate_id !== peek.candidate_id)
      throw Error("person_refresh_queue_changed");
    const attempt = (
      await c.query(
        "select * from public.person_refresh_attempts where queue_id=$1 and organization_id=$2 for update",
        [args.queueId, TT_ORG_ID],
      )
    ).rows[0];
    if (attempt && attempt.candidate_id !== row.candidate_id)
      throw Error("person_refresh_identity_changed");
    const out = await fn(row, attempt);
    await c.query("commit");
    return out;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  }
}
async function terminal(c: PersonConnection, row: any, status: string) {
  // The legacy queue has unique(candidate_id,status). Retain prior terminal
  // history in place and its original row in the receipt instead of deleting it.
  const previous = (
    await c.query(
      "select * from public.refresh_queue where candidate_id=$1 and organization_id=$2 and status=$3 and id<>$4 order by id for update",
      [row.candidate_id, TT_ORG_ID, status, row.id],
    )
  ).rows;
  for (const old of previous)
    await c.query(
      "update public.refresh_queue set status=$2 where id=$1 and organization_id=$3",
      [old.id, `archived_${old.id}_${status}`, TT_ORG_ID],
    );
  if (previous.length)
    await c.query(
      "update public.person_refresh_attempts set previous_queue_rows=previous_queue_rows || $2::jsonb where queue_id=$1",
      [row.id, JSON.stringify(previous)],
    );
  await c.query(
    "update public.refresh_queue set status=$2,processed_at=clock_timestamp() where id=$1 and organization_id=$3",
    [row.id, status, TT_ORG_ID],
  );
}
async function review(c: PersonConnection, row: any, reason: string) {
  await c.query(
    "update public.person_refresh_attempts set phase='review',lease_until=null,error_code=$2,updated_at=clock_timestamp() where queue_id=$1",
    [row.id, reason],
  );
  await terminal(c, row, "patch_failed");
  return { status: "review" as const };
}
function active(a: any) {
  return a?.phase === "claimed" && Date.parse(a.lease_until) > Date.now();
}
function fenced(a: any, token: string) {
  if (!active(a) || a.claim_token !== token)
    throw Error("person_refresh_claim_expired");
}

export async function pickRefreshRowsOnConnection(
  c: PersonConnection,
  args: {
    organizationId: string;
    status: "queued" | "patch_failed";
    limit: number;
  },
) {
  if (
    args.organizationId !== TT_ORG_ID ||
    !["queued", "patch_failed"].includes(args.status) ||
    !Number.isInteger(args.limit) ||
    args.limit < 1 ||
    args.limit > 500
  )
    throw Error("person_refresh_scope");
  return (
    await c.query(
      `select q.id,q.candidate_id,q.priority from public.refresh_queue q
    left join public.person_refresh_attempts a on a.queue_id=q.id
    where q.organization_id=$1 and q.status=$2 and (a.queue_id is null or
      (a.phase in ('ready','claimed') and (a.phase<>'claimed' or a.lease_until<=clock_timestamp())))
    order by (a.ledger_snapshot is not null or exists (
      select 1 from public.candidate_enrichments e
      join public.candidates c on c.id=q.candidate_id
      where e.organization_id=$1 and e.candidate_id=q.candidate_id
        and lower(e.linkedin_username)=lower(btrim(c.linkedin_username))
        and e.provider='harvest' and e.status='ok' and e.cache_status='miss'
        and e.raw_payload is not null and e.created_at>=clock_timestamp()-interval '30 days'
    )) desc,q.priority,q.queued_at,q.id limit $3`,
      [TT_ORG_ID, args.status, args.limit],
    )
  ).rows;
}

export async function claimRefreshOnConnection(
  c: PersonConnection,
  args: Key & { dailyCap: number; allowPaid: boolean },
) {
  if (
    !Number.isInteger(args.dailyCap) ||
    args.dailyCap < 0 ||
    args.dailyCap > 10000
  )
    throw Error("person_refresh_cap");
  return transaction(
    c,
    args,
    async (row, prior) => {
      if (!row) return { status: "missing" as const };
      if (prior?.phase === "done") return { status: "done" as const };
      if (active(prior)) return { status: "busy" as const };
      if (!["queued", "patch_failed"].includes(row.status))
        return { status: "missing" as const };
      const competing = (
        await c.query(
          "select 1 from public.person_refresh_attempts where candidate_id=$1 and queue_id<>$2 and phase='claimed' and lease_until>clock_timestamp() limit 1",
          [row.candidate_id, row.id],
        )
      ).rows.length;
      if (competing) return { status: "busy" as const };
      const candidate = (
        await c.query(
          "select linkedin_username from public.candidates where id=$1",
          [row.candidate_id],
        )
      ).rows[0];
      const username = String(candidate?.linkedin_username ?? "")
        .trim()
        .toLowerCase();
      if (!prior)
        await c.query(
          `insert into public.person_refresh_attempts(queue_id,candidate_id,organization_id,phase,linkedin_username,linkedin_url) values($1,$2,$3,'ready',$4,$5)`,
          [
            row.id,
            row.candidate_id,
            TT_ORG_ID,
            username,
            `https://www.linkedin.com/in/${encodeURIComponent(username)}`,
          ],
        );
      const a =
        prior ??
        (
          await c.query(
            "select * from public.person_refresh_attempts where queue_id=$1",
            [row.id],
          )
        ).rows[0];
      if (
        !/^[\p{L}\p{N}\p{M}._-]{1,200}$/u.test(username) ||
        username !== a.linkedin_username
      )
        return review(c, row, "identity_changed");
      if (
        (
          await c.query(
            "select 1 from public.person_source_holds where candidate_id=$1 and resolved_at is null limit 1",
            [row.candidate_id],
          )
        ).rows.length
      )
        return review(c, row, "source_hold");
      if (
        !(
          await c.query(
            "select 1 from public.candidate_profile_state where candidate_id=$1",
            [row.candidate_id],
          )
        ).rows.length
      )
        return review(c, row, "not_migrated");
      if (a.attempts >= 3) return review(c, row, "attempt_limit");
      if (a.paid_requested_at && !a.ledger_snapshot)
        return review(c, row, "paid_response_unknown");
      let ledger = a.ledger_snapshot;
      if (!ledger)
        ledger = (
          await c.query(
            `select * from public.candidate_enrichments where organization_id=$1 and candidate_id=$2 and lower(linkedin_username)=$3 and provider='harvest' and status='ok' and cache_status='miss' and raw_payload is not null and created_at>=clock_timestamp()-interval '30 days' order by created_at desc,id desc limit 1 for share`,
            [TT_ORG_ID, row.candidate_id, username],
          )
        ).rows[0];
      const needsHarvest = !ledger;
      if (
        needsHarvest &&
        (row.status === "patch_failed" ||
          !args.allowPaid ||
          a.phase === "review")
      )
        return review(c, row, "cached_source_missing");
      if (needsHarvest) {
        if (
          (
            await c.query(
              "select 1 from public.person_refresh_attempts where candidate_id=$1 and paid_requested_at is not null and ledger_snapshot is null limit 1",
              [row.candidate_id],
            )
          ).rows.length
        )
          return review(c, row, "paid_response_unknown");
        const spent = Number(
          (
            await c.query(
              `select (select count(*) from public.candidate_enrichments where provider='harvest' and cache_status='miss' and created_at >= (date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')) + (select count(*) from public.person_refresh_attempts where paid_requested_at >= (date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') and ledger_snapshot is null) n`,
            )
          ).rows[0].n,
        );
        if (spent >= args.dailyCap) return { status: "budget" as const };
      }
      const token = randomUUID();
      const ledgerId = ledger?.id ?? a.ledger_id ?? randomUUID();
      await c.query(
        `update public.person_refresh_attempts set phase='claimed',claim_token=$2,lease_until=clock_timestamp()+interval '10 minutes',attempts=attempts+1,ledger_id=$3,ledger_snapshot=$4,paid_token=case when $5 then $2 else paid_token end,paid_requested_at=case when $5 then clock_timestamp() else paid_requested_at end,error_code=null,updated_at=clock_timestamp() where queue_id=$1`,
        [
          row.id,
          token,
          ledgerId,
          ledger ? JSON.stringify(ledger) : null,
          needsHarvest,
        ],
      );
      return {
        status: "claimed" as const,
        queueId: row.id as string,
        candidateId: row.candidate_id as string,
        token,
        needsHarvest,
        linkedinUrl: a.linkedin_url as string,
      };
    },
    true,
  );
}

export async function storeRefreshPayloadOnConnection(
  c: PersonConnection,
  args: Token & { raw: any },
) {
  if (
    !args.raw ||
    typeof args.raw !== "object" ||
    Array.isArray(args.raw) ||
    (!args.raw.experience && !args.raw.headline)
  )
    throw Error("person_refresh_empty_payload");
  return transaction(c, args, async (row, a) => {
    // A late successful response remains valuable even after its lease expired.
    // Only the original paid reservation can attach it; no new paid call occurs.
    if (!row || !a?.paid_token || a.paid_token !== args.token)
      throw Error("person_refresh_paid_token");
    if (a.ledger_snapshot) return;
    const ledger = (
      await c.query(
        `insert into public.candidate_enrichments(id,organization_id,candidate_id,linkedin_username,provider,operation,cache_status,status,raw_payload,cost_credits) values($1,$2,$3,$4,'harvest','full_profile','miss','ok',$5,1) returning *`,
        [
          a.ledger_id,
          TT_ORG_ID,
          row.candidate_id,
          a.linkedin_username,
          args.raw,
        ],
      )
    ).rows[0];
    await c.query(
      "update public.person_refresh_attempts set ledger_snapshot=$2,phase=case when phase='review' then 'ready' else phase end,error_code=null,updated_at=clock_timestamp() where queue_id=$1",
      [row.id, JSON.stringify(ledger)],
    );
    // A newer failed request may have archived this queue slot while the paid
    // response was unknown. Restore an eligible free-retry slot atomically with
    // the recovered snapshot, retaining the displaced terminal history.
    if (a.phase === "review") await terminal(c, row, "patch_failed");
  });
}

export async function saveRefreshOnConnection(
  c: PersonConnection,
  args: Token & { mode: "shadow" | "live" },
) {
  if (!modeOk(args.mode)) throw Error("person_refresh_mode");
  return transaction(c, args, async (row, a) => {
    if (!row) throw Error("person_refresh_missing");
    fenced(a, args.token);
    const ledger = a.ledger_snapshot;
    if (
      !ledger ||
      ledger.organization_id !== TT_ORG_ID ||
      ledger.candidate_id !== row.candidate_id ||
      ledger.cache_status !== "miss" ||
      ledger.provider !== "harvest" ||
      ledger.status !== "ok"
    )
      throw Error("person_refresh_source");
    const before = await lockPerson(c, row.candidate_id);
    if (
      String(before.linkedin_username).trim().toLowerCase() !==
      a.linkedin_username
    )
      throw Error("person_refresh_identity_changed");
    const audit = await beginGuardedAuditOperationLocked(c, before, {
      writer: "refresh",
      receiptRef: `refresh:${row.id}`,
    });
    const doc = fromHarvest(ledger.raw_payload, ledger, row.candidate_id);
    const result = await savePersonLocked(
      c,
      [doc],
      { mode: args.mode },
      before,
      audit,
    );
    if (args.mode === "live") {
      const canonical = (
        await c.query("select * from public.candidates where id=$1", [
          row.candidate_id,
        ])
      ).rows[0];
      const years = poolSignals({
        ...canonical,
        calculated_experience_years: null,
        total_experience_years: null,
      }).years;
      await attributeAuditMutation(
        c,
        audit,
        {
          scope: "refresh_metadata",
          table: "candidates",
          rowId: row.candidate_id,
        },
        () =>
          c.query(
            `update public.candidates set linkedin_enrichment_date=greatest(linkedin_enrichment_date,$2::timestamptz),calculated_experience_years=coalesce($3,calculated_experience_years) where id=$1 returning id`,
            [
              row.candidate_id,
              ledger.created_at,
              Number.isFinite(years) ? Math.round(years!) : null,
            ],
          ),
      );
    }
    if (args.mode === "live")
      await enqueuePersonDerivativesLocked(c, {
        organizationId: TT_ORG_ID,
        candidateId: row.candidate_id,
        receiptRef: `refresh:${row.id}`,
      });
    await c.query(
      "update public.person_refresh_attempts set phase='done',lease_until=null,documents=$2,result=$3,updated_at=clock_timestamp() where queue_id=$1",
      [row.id, JSON.stringify([doc]), JSON.stringify(result)],
    );
    await terminal(c, row, "done");
    return { status: "done" as const, ...result };
  });
}

export async function failRefreshOnConnection(
  c: PersonConnection,
  args: Token,
) {
  return transaction(c, args, async (row, a) => {
    if (!row || !a || a.claim_token !== args.token || a.phase === "done")
      return;
    if (a.paid_requested_at && !a.ledger_snapshot) {
      await review(c, row, "paid_response_unknown");
      return;
    }
    await c.query(
      "update public.person_refresh_attempts set phase='ready',lease_until=null,error_code='save_retry_required',updated_at=clock_timestamp() where queue_id=$1",
      [row.id],
    );
    await terminal(c, row, "patch_failed");
  });
}

export const claimRefresh = (
  args: Parameters<typeof claimRefreshOnConnection>[1],
) => withPersonConnection((c) => claimRefreshOnConnection(c, args));
export const pickRefreshRows = (
  args: Parameters<typeof pickRefreshRowsOnConnection>[1],
) => withPersonConnection((c) => pickRefreshRowsOnConnection(c, args));
export const storeRefreshPayload = (
  args: Parameters<typeof storeRefreshPayloadOnConnection>[1],
) => withPersonConnection((c) => storeRefreshPayloadOnConnection(c, args));
export const saveRefresh = (
  args: Parameters<typeof saveRefreshOnConnection>[1],
) => withPersonConnection((c) => saveRefreshOnConnection(c, args));
export const failRefresh = (
  args: Parameters<typeof failRefreshOnConnection>[1],
) => withPersonConnection((c) => failRefreshOnConnection(c, args));
