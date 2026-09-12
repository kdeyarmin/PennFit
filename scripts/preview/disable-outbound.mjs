#!/usr/bin/env node
// Disable outbound behavior on a verified disposable preview, preserving modules
// and eligibility rules. Default is a read-only dry run. Example:
// node scripts/preview/disable-outbound.mjs --org-ids=<seed-uuid>,<synthetic-uuid>
// Add --apply --confirm-disposable-project=<ref> only after reviewing the plan.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PREVIEW_TARGET } from "./config.mjs";

export const OUTBOUND_FEATURE_KEYS = Object.freeze([
  "sms.reminders",
  "email.reminders",
  "email.auto_reply",
  "voice.agent",
  "voice.breathe_sales",
  "bulk_campaigns.send",
  "outreach_playbooks.dispatcher",
  "cart_abandonment.dispatcher",
  "smart_triggers.dispatcher",
  "patient_onboarding.dispatcher",
  "fitter_supply_campaign.dispatcher",
  "reminder_escalation.dispatcher",
  "reminder_escalation.voice",
  "alerts.auto_dispatch",
  "therapy_fleet.auto_outreach",
  "clinical_outreach.dispatcher",
  "eligibility.auto_reverify",
  "fitter_first_day_nudge.dispatcher",
  "fitter_reengage.dispatcher",
  "fitter.followup_nudges",
  "fitter.refit_campaign",
  "failed_email_digest.dispatcher",
  "patient_packets.autosend_on_delivery",
  "patient_packets.autoremind",
  "billing.auto_submit_claims",
  "billing.auto_submit_prior_auths",
  "billing.payment_plan_autocharge",
  "billing.patient_autopay",
  "billing.auto_secondary_claims",
  "billing.bill_hold_auto_remind",
  "collections.dunning",
  "referrals.adherence_report",
  "slack.notifications",
  "slack.interactivity",
  "slack.digests",
  "domains.tls_automation",
  "storefront.auto_reminder_enrollment",
]);

export function validateOrgIds(orgIds) {
  if (!Array.isArray(orgIds) || orgIds.length === 0 || orgIds.length > 100) {
    throw new Error(
      "Supply between 1 and 100 explicit preview organization IDs.",
    );
  }
  if (
    orgIds.some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  ) {
    throw new Error("Every preview organization ID must be a UUID.");
  }
  return [...new Set(orgIds.map((id) => id.toLowerCase()))];
}

// Explicitly parametric: neither org IDs nor feature names are interpolated SQL.
export function buildOutboundDisableQuery(orgIds) {
  return {
    text: `INSERT INTO resupply.feature_flags
      (org_id, key, enabled, description, category, updated_by_email, updated_at)
      SELECT org_id, key, false, 'Outbound activity disabled for synthetic preview',
        split_part(key, '.', 1), 'preview-setup', now()
      FROM unnest($1::uuid[]) AS orgs(org_id)
      CROSS JOIN unnest($2::text[]) AS features(key)
      ON CONFLICT (org_id, key) DO UPDATE
        SET enabled = false, updated_by_user_id = NULL,
          updated_by_email = EXCLUDED.updated_by_email, updated_at = EXCLUDED.updated_at`,
    values: [validateOrgIds(orgIds), [...OUTBOUND_FEATURE_KEYS]],
  };
}

function createPgClient(env) {
  // Reuse resupply-db's pinned driver; do not add a second pg dependency.
  const require = createRequire(
    new URL("../../lib/resupply-db/package.json", import.meta.url),
  );
  const { Client } = require("pg");
  return new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "pennfit-preview-disable-outbound",
  });
}

export async function disablePreviewOutbound(options, dependencies = {}) {
  const env = options.env ?? process.env;
  const orgIds = validateOrgIds(options.orgIds);
  const assertIdentity =
    dependencies.assertIdentity ??
    (await import("./init.mjs")).assertPreviewIdentity;
  // Identity validation completes BEFORE creating a client or opening a socket.
  const identity = await assertIdentity({ ...options, env });
  const client = (dependencies.createClient ?? createPgClient)(env);
  try {
    await client.connect();
    await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY");
    try {
      const { rows } = await client.query(
        `SELECT id, slug, status FROM resupply.organizations
         WHERE status = 'active' OR id = ANY($1::uuid[])
         ORDER BY id${options.apply ? " FOR UPDATE" : ""}`,
        [orgIds],
      );
      const found = new Set(rows.map((row) => row.id));
      if (orgIds.some((id) => !found.has(id)))
        throw new Error("A requested preview organization does not exist.");
      if (
        rows.some((row) => row.status === "active" && !orgIds.includes(row.id))
      ) {
        throw new Error(
          "Include every active preview organization, including the seed org, before disabling outbound activity.",
        );
      }
      if (
        !rows.some(
          (row) => row.slug === "penn-home-medical" && orgIds.includes(row.id),
        )
      ) {
        throw new Error(
          "The seed organization must be included because missing tenant flags fall back to it.",
        );
      }
      const statement = buildOutboundDisableQuery(orgIds);
      let affectedRows = 0;
      if (options.apply) {
        const result = await client.query(statement);
        affectedRows = result.rowCount;
        if (affectedRows !== orgIds.length * OUTBOUND_FEATURE_KEYS.length) {
          throw new Error(
            "Preview flag update did not affect the complete expected set.",
          );
        }
      }
      await client.query(options.apply ? "COMMIT" : "ROLLBACK");
      return {
        ...identity,
        applied: Boolean(options.apply),
        orgIds,
        featureKeys: [...OUTBOUND_FEATURE_KEYS],
        affectedRows,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function parseDisableArgs(argv) {
  const names = new Set([
    "org-ids",
    "project-ref",
    "branch-id",
    "confirm-disposable-project",
  ]);
  const values = {};
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply" && !apply) {
      apply = true;
      continue;
    }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !names.has(match[1]) || values[match[1]] !== undefined)
      throw new Error("Invalid or duplicate preview setup argument.");
    values[match[1]] = match[2];
  }
  return {
    orgIds: validateOrgIds(values["org-ids"]?.split(",")),
    projectRef: values["project-ref"] ?? PREVIEW_TARGET.supabaseProjectRef,
    branchId: values["branch-id"] ?? PREVIEW_TARGET.supabaseBranchId,
    parentProjectRef: PREVIEW_TARGET.supabaseParentProjectRef,
    confirmDisposableProject: values["confirm-disposable-project"],
    apply,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await disablePreviewOutbound(
      parseDisableArgs(process.argv.slice(2)),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch {
    // Driver/management errors can contain connection details. CLI output is
    // intentionally structural; exported helpers retain original errors in tests.
    process.stderr.write(
      "Preview outbound setup failed; verify identity, explicit org IDs, grants, and disposable-project confirmation. No credentials printed.\n",
    );
    process.exitCode = 1;
  }
}
