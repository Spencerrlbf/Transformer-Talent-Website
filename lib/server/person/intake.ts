import {
  beginGuardedAuditOperationLocked,
  createReceiptAuditAnchorLocked,
  attributeAuditMutation,
} from "./audit";
// Server-only entry point for TT's shared application/referral/future pipeline.
import { randomUUID } from "node:crypto";
import { fromApplication, type ApplicationRow } from "./fromApplication";
import { fromHarvest } from "./fromHarvest";
import {
  assembleDoc,
  makeHeader,
  SkillBag,
  TT_ORG_ID,
  schoolOf,
  makeEducation,
  finishEducations,
} from "./normalize";
import {
  beginPersonTransaction,
  lockPerson,
  savePersonLocked,
  withPersonConnection,
  type PersonConnection,
} from "./save";
import type { PersonDoc } from "./types";
import type { ParsedProfile } from "../applicants";
import { enqueuePersonDerivativesLocked } from "./derivatives";

export function applicationMatchingText(
  parsed: Partial<ParsedProfile> | null,
  resumeText: string | null,
): string {
  return (
    parsed?.profile_summary ||
    [
      parsed?.current_title,
      parsed?.current_company && `at ${parsed.current_company}`,
    ]
      .filter(Boolean)
      .join(" ") ||
    resumeText?.slice(0, 2000) ||
    ""
  );
}

export function personWriteMode(
  env: Record<string, string | undefined> = process.env,
): "legacy" | "shadow" | "live" {
  const value = env.PERSON_WRITE_MODE || "legacy";
  if (value !== "legacy" && value !== "shadow" && value !== "live")
    throw Error("invalid_person_write_mode");
  return value;
}
export interface ApplicationSnapshot {
  parsed_profile: ParsedProfile | null;
  resume_text: string | null;
  harvest_profile: Record<string, unknown> | null;
  [key: string]: unknown;
}
export interface ApplicationPersonInput {
  organizationId: string;
  applicationId: string;
  linkedinUsername: string;
  name: string;
  parsed: Partial<ParsedProfile> | null;
  resumeText: string | null;
  matchingVector?: number[] | null;
  resumeContacts?: {
    phone?: string | null;
    email?: string | null;
    emails?: string[];
  };
  harvestLedgerId?: string | null;
  mode: "shadow" | "live";
}
/** Parsed resume facts have their own source reference. Historical person-v3
 * application parsing remains unchanged. Unpaired school/degree arrays stay
 * on the original application; no guessed education relationship is created. */
export function applicationProfileDoc(
  app: ApplicationRow,
  id: string,
  parsed: Partial<ParsedProfile> | null,
): PersonDoc {
  const bag = new SkillBag();
  for (const skill of parsed?.top_skills ?? [])
    bag.add(skill, { is_top: true });
  const schools = (parsed?.education_schools ?? [])
    .map((name) => schoolOf({ name }))
    .filter((school): school is NonNullable<typeof school> => !!school);
  const education = finishEducations(
    schools.map((school, index) =>
      makeEducation({
        school,
        degree:
          schools.length === 1 && parsed?.education_degrees?.length === 1
            ? parsed.education_degrees[0]
            : null,
        field_of_study:
          schools.length === 1 && parsed?.education_fields?.length === 1
            ? parsed.education_fields[0]
            : null,
        start_year: null,
        start_month: null,
        end_year: null,
        end_month: null,
        description: null,
        activities: null,
        sort_order: index,
      }),
    ),
  ).educations;
  return assembleDoc({
    candidate_id: id,
    mode: "fill_gaps",
    source: {
      source: "application",
      provider: "website-resume",
      source_ref: `${app.id}:profile`,
      fetched_at: new Date(app.created_at).toISOString(),
      raw_in: "inline",
      enrichment_id: null,
    },
    identities: [],
    header: makeHeader({
      current_title: parsed?.current_title,
      current_company: parsed?.current_company,
      headline: parsed?.headline,
      summary: parsed?.profile_summary,
      location: parsed?.location,
    }),
    skills: bag.list(),
    educations: education,
    contacts: [],
  });
}
export async function saveApplicationPersonOnConnection(
  client: PersonConnection,
  args: ApplicationPersonInput,
) {
  if (args.organizationId !== TT_ORG_ID) throw Error("person_intake_tenant");
  const username = args.linkedinUsername.trim().toLowerCase();
  if (!/^[\p{L}\p{N}\p{M}._-]{1,200}$/u.test(username))
    throw Error("person_intake_linkedin");
  try {
    await beginPersonTransaction(client);
    // Serializes new identity resolution, before any candidate lock. Claimed
    // email is never a lookup key. The unique legacy username is a backstop.
    await client.query("select pg_advisory_xact_lock(72007,hashtext($1))", [
      username,
    ]);
    const application = (
      await client.query(
        "select * from public.website_applications where id=$1 and organization_id=$2 for update",
        [args.applicationId, TT_ORG_ID],
      )
    ).rows[0];
    if (
      !application ||
      String(application.linkedin_username ?? "").toLowerCase() !== username
    )
      throw Error("person_intake_application");
    const receipt = (
      await client.query(
        "select * from public.person_application_receipts where application_id=$1",
        [args.applicationId],
      )
    ).rows[0];
    const ids = (
      await client.query(
        `select id from public.candidates where linkedin_username=$1
   union select candidate_id from public.candidate_identities where kind='linkedin_username' and value=$1`,
        [username],
      )
    ).rows;
    if (ids.length > 1) throw Error("person_intake_identity_conflict");
    let id = receipt?.candidate_id ?? ids[0]?.id;
    if (receipt && ids.length && ids[0].id !== id)
      throw Error("person_intake_identity_conflict");
    let created = receipt?.created_person ?? false;
    let insertedNow = false;
    if (!id) {
      id = randomUUID();
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [id]);
      const inserted = (
        await client.query(
          `insert into public.candidates(id,full_name,first_name,last_name,linkedin_username,linkedin_url,source,status)
    values($1,$2,$3,$4,$5,$6,'website_applicant','applicant') on conflict(linkedin_username) do nothing returning id`,
          [
            id,
            application.name || args.name || username,
            (application.name || args.name || username).split(/\s+/)[0],
            (application.name || args.name || "")
              .split(/\s+/)
              .slice(1)
              .join(" ") || null,
            username,
            `https://www.linkedin.com/in/${encodeURIComponent(username)}`,
          ],
        )
      ).rows[0];
      if (inserted) {
        created = true;
        insertedNow = true;
      } else {
        id = (
          await client.query(
            "select id from public.candidates where linkedin_username=$1",
            [username],
          )
        ).rows[0]?.id;
        if (!id) throw Error("person_intake_identity_race");
      }
    }
    const before = await lockPerson(client, id);
    if (application.candidate_id && application.candidate_id !== id)
      throw Error("person_intake_application_identity_conflict");
    if (
      !created &&
      !(
        await client.query(
          "select 1 from public.candidate_profile_state where candidate_id=$1",
          [id],
        )
      ).rows.length
    )
      throw Error("person_intake_not_migrated");
    let audit = insertedNow
      ? undefined
      : await beginGuardedAuditOperationLocked(client, before, {
          writer: "application",
          receiptRef: `application:${args.applicationId}`,
        });
    let docs: PersonDoc[] = receipt?.documents;
    let applicationSnapshot: ApplicationSnapshot =
      receipt?.application_snapshot;
    if (!docs) {
      const contact = { ...(application.contact ?? {}) };
      if (!contact.phone && args.resumeContacts?.phone)
        contact.phone = args.resumeContacts.phone;
      const extras = [
        ...(contact.otherEmails ?? []),
        args.resumeContacts?.email,
        ...(args.resumeContacts?.emails ?? []),
      ].filter(Boolean);
      if (extras.length) contact.otherEmails = [...new Set(extras)];
      const app: ApplicationSnapshot & ApplicationRow = {
        ...application,
        // The same resolved name used by the seed INSERT must survive a retry,
        // including referral/future applications whose earlier name patch failed.
        name: application.name || args.name || username,
        contact,
        created_at: new Date(application.created_at).toISOString(),
        parsed_profile: args.parsed ?? application.parsed_profile ?? null,
        resume_text: args.resumeText ?? application.resume_text ?? null,
        harvest_profile: null,
      };
      docs = [
        fromApplication(app, created, id),
        applicationProfileDoc(app, id, app.parsed_profile),
      ];
      if (args.harvestLedgerId) {
        const ledger = (
          await client.query(
            `select * from public.candidate_enrichments where id=$1 and organization_id=$2 and provider='harvest' and status='ok' and cache_status='miss' and lower(linkedin_username)=$3 for share`,
            [args.harvestLedgerId, TT_ORG_ID, username],
          )
        ).rows[0];
        if (
          !ledger?.raw_payload ||
          (ledger.candidate_id && ledger.candidate_id !== id)
        )
          throw Error("person_intake_harvest_identity");
        app.harvest_profile = ledger.raw_payload;
        docs.push(
          fromHarvest(
            ledger.raw_payload,
            {
              ...ledger,
              created_at: new Date(ledger.created_at).toISOString(),
            },
            id,
          ),
        );
        await client.query(
          "update public.candidate_enrichments set candidate_id=$2 where id=$1 and candidate_id is null",
          [ledger.id, id],
        );
      }
      if (
        created &&
        Number.isInteger(args.parsed?.total_experience_years) &&
        (args.parsed!.total_experience_years ?? -1) >= 0
      )
        await client.query(
          "update public.candidates set total_experience_years=$2 where id=$1",
          [id, args.parsed!.total_experience_years],
        );
      applicationSnapshot = app;
      await client.query(
        "insert into public.person_application_receipts(application_id,candidate_id,created_person,documents,application_snapshot,harvest_ledger_id) values($1,$2,$3,$4,$5,$6)",
        [
          args.applicationId,
          id,
          created,
          JSON.stringify(docs),
          JSON.stringify(app),
          args.harvestLedgerId ?? null,
        ],
      );
    }
    audit ??= await createReceiptAuditAnchorLocked(client, before, {
      writer: "application",
      receiptRef: `application:${args.applicationId}`,
    });
    // A new candidate needs an initial compatibility profile even in shadow
    // mode. Shadow never republishes an existing candidate.
    // A receipt keeps the exact input stable even when a retry's resume parser
    // returns a different answer. Normalize all sources before one projection.
    const result = await savePersonLocked(
      client,
      docs,
      { mode: created && !receipt ? "live" : args.mode },
      before,
      audit,
    );
    // Resume text and workflow labels are not normalized profile projection fields.
    if (!receipt && applicationSnapshot.resume_text && !before.resume_text)
      await client.query(
        "update public.candidates set resume_text=$2 where id=$1",
        [id, applicationSnapshot.resume_text.slice(0, 50000)],
      );
    const canonical = (
      await client.query("select * from public.candidates where id=$1", [id])
    ).rows[0];
    if (args.mode === "live")
      await enqueuePersonDerivativesLocked(client, {
        organizationId: TT_ORG_ID,
        candidateId: id,
        receiptRef: `application:${args.applicationId}`,
      });
    if (
      !receipt &&
      (args.mode === "live" || created) &&
      args.matchingVector &&
      !before.matching_embedding &&
      applicationMatchingText(args.parsed, args.resumeText) ===
        applicationMatchingText(canonical, canonical.resume_text) &&
      applicationMatchingText(args.parsed, args.resumeText) ===
        applicationMatchingText(
          applicationSnapshot.parsed_profile,
          applicationSnapshot.resume_text,
        )
    ) {
      if (
        args.matchingVector.length !== 1536 ||
        args.matchingVector.some((v) => !Number.isFinite(v))
      )
        throw Error("person_intake_vector");
      await client.query(
        "update public.candidates set matching_embedding=$2,embedding_type='website_applicant' where id=$1 and matching_embedding is null",
        [id, JSON.stringify(args.matchingVector)],
      );
    }
    await attributeAuditMutation(
      client,
      audit,
      {
        scope: "application_finalize",
        table: "website_applications",
        rowId: args.applicationId,
      },
      () =>
        client.query(
          "update public.website_applications set candidate_id=$2,pool_created_person=$3,parsed_profile=$4,resume_text=$5 where id=$1 returning id",
          [
            args.applicationId,
            id,
            created,
            applicationSnapshot.parsed_profile,
            applicationSnapshot.resume_text,
          ],
        ),
    );
    await client.query("commit");
    return { ...result, created, applicationSnapshot };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
export async function saveApplicationPerson(args: ApplicationPersonInput) {
  return withPersonConnection((client) =>
    saveApplicationPersonOnConnection(client, args),
  );
}
