#!/usr/bin/env tsx
//
// resupply-cutover — assess, enable and roll back the two resupply
// lifecycle flags, one tenant at a time, from a terminal.
//
// WHY A CLI AS WELL AS THE ADMIN ROUTE
// -----------------------------------
// The admin route is the operator's path and carries the same gate. This
// exists for the two things it cannot do:
//
//   * A full-book assessment. The route scans under a row budget so an
//     HTTP request cannot run for minutes; a large tenant comes back
//     `truncated`, which BLOCKS. Here there is no budget, so a big
//     tenant can actually be assessed.
//   * Assessing every tenant at once, to plan a cutover order.
//
// It writes the same `resupply_cutover_records` rows, so an assessment
// run here authorises an enable clicked there, and vice versa.
//
//   pnpm --filter @workspace/scripts resupply:cutover -- --all-orgs --assess
//   pnpm --filter @workspace/scripts resupply:cutover -- --org=<uuid> --assess
//   pnpm --filter @workspace/scripts resupply:cutover -- --org=<uuid> \
//     --enable=resupply.due_at_authoritative --confirm=ENABLE --evidence=OPS-1234
//   pnpm --filter @workspace/scripts resupply:cutover -- --org=<uuid> \
//     --rollback=resupply.due_at_authoritative --confirm=ROLLBACK \
//     --reason="reminders firing early for override patients"
//
// SAFETY
// ------
// `--assess` is read-only and is the default: running with no action
// flag never changes anything. `--enable` requires the literal
// confirmation `ENABLE` and an evidence identifier, and re-runs the
// assessment itself — a stored pass is not enough. `--rollback` requires
// `ROLLBACK` and a reason, and is deliberately NOT gated on readiness: a
// data-quality check must never stand between an operator and the stop
// button.
//
// PHI: prints counts, day-deltas and capped internal UUIDs. No names,
// contact details, payer, address or clinical values.

import {
  CUTOVER_FLAG_KEYS,
  assessReadiness,
  readCutoverFlagState,
  readLatestCutoverRecord,
  resolveReadinessState,
  writeCutoverRecord,
  type CutoverFlagKey,
  type ReadinessReport,
} from "@workspace/resupply-cutover";
import {
  getOrgScopedClient,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

interface Args {
  orgIds: string[];
  allOrgs: boolean;
  enable: CutoverFlagKey | null;
  rollback: CutoverFlagKey | null;
  confirm: string | null;
  evidence: string | null;
  reason: string | null;
  json: boolean;
}

function isCutoverFlag(value: string): value is CutoverFlagKey {
  return (CUTOVER_FLAG_KEYS as readonly string[]).includes(value);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    orgIds: [],
    allOrgs: false,
    enable: null,
    rollback: null,
    confirm: null,
    evidence: null,
    reason: null,
    json: false,
  };
  for (const raw of argv) {
    if (raw === "--all-orgs") args.allOrgs = true;
    else if (raw === "--json") args.json = true;
    else if (raw === "--assess")
      continue; // the default; accepted for clarity
    else if (raw.startsWith("--org=")) args.orgIds.push(raw.slice(6));
    else if (raw.startsWith("--enable=")) {
      const key = raw.slice(9);
      if (!isCutoverFlag(key)) fail(`unknown flag: ${key}`);
      args.enable = key;
    } else if (raw.startsWith("--rollback=")) {
      const key = raw.slice(11);
      if (!isCutoverFlag(key)) fail(`unknown flag: ${key}`);
      args.rollback = key;
    } else if (raw.startsWith("--confirm=")) args.confirm = raw.slice(10);
    else if (raw.startsWith("--evidence=")) args.evidence = raw.slice(11);
    else if (raw.startsWith("--reason=")) args.reason = raw.slice(9);
  }
  return args;
}

function fail(message: string): never {
  console.error(`resupply:cutover — ${message}`);
  process.exit(2);
}

async function listOrgIds(): Promise<string[]> {
  const raw = getSupabaseServiceRoleClient();
  const { data, error } = await raw
    .schema("resupply")
    .from("organizations")
    .select("id")
    .order("id", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((o) => o.id);
}

/** Flip a flag row directly. Mirrors the admin route's `setFlag`. */
async function setFlag(
  orgId: string,
  key: CutoverFlagKey,
  enabled: boolean,
  actorEmail: string,
): Promise<boolean | null> {
  const supabase = getOrgScopedClient(orgId).raw();
  const { data: prior, error: priorErr } = await supabase
    .schema("resupply")
    .from("feature_flags")
    .select("enabled")
    .eq("org_id", orgId)
    .eq("key", key)
    .maybeSingle();
  if (priorErr) throw priorErr;
  if (!prior) return null;
  const previous = Boolean((prior as { enabled: boolean }).enabled);
  if (previous === enabled) return previous;
  const { error } = await supabase
    .schema("resupply")
    .from("feature_flags")
    .update({
      enabled,
      updated_by_email: actorEmail,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("key", key);
  if (error) throw error;
  return previous;
}

function printReport(orgId: string, report: ReadinessReport): void {
  const verdict = report.status === "ready" ? "READY" : "BLOCKED";
  console.log(`  ${report.flagKey}: ${verdict}`);
  for (const [name, value] of Object.entries(report.metrics)) {
    if (typeof value === "number") {
      console.log(`      ${name.padEnd(34)} ${value}`);
    } else if (value && typeof value === "object") {
      const rendered = Object.entries(value as Record<string, number>)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      if (rendered) console.log(`      ${name.padEnd(34)} ${rendered}`);
    }
  }
  if (report.truncated) {
    console.log("      !! result truncated — verdict covers part of the book");
  }
  for (const blocker of report.blockers) {
    console.log(`      BLOCKER ${blocker.code}: ${blocker.detail}`);
    if (blocker.sampleIds?.length) {
      console.log(
        `              ids: ${blocker.sampleIds.slice(0, 5).join(", ")}`,
      );
    }
  }
  for (const warning of report.warnings) {
    console.log(`      warn: ${warning}`);
  }
  void orgId;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.orgIds.length === 0 && !args.allOrgs) {
    console.error(
      "Usage:\n" +
        "  resupply:cutover -- --org=<uuid> [--assess]\n" +
        "  resupply:cutover -- --all-orgs [--assess]\n" +
        "  resupply:cutover -- --org=<uuid> --enable=<flag> --confirm=ENABLE --evidence=<ticket>\n" +
        "  resupply:cutover -- --org=<uuid> --rollback=<flag> --confirm=ROLLBACK --reason=<why>\n\n" +
        `Flags: ${CUTOVER_FLAG_KEYS.join(", ")}\n`,
    );
    process.exit(2);
  }
  if (args.enable && args.rollback) {
    fail("--enable and --rollback are mutually exclusive");
  }
  if ((args.enable || args.rollback) && args.allOrgs) {
    // A cutover is per tenant, deliberately. Enabling across every
    // tenant at once is exactly the deploy-day surprise the flags exist
    // to prevent.
    fail(
      "--enable / --rollback require a single --org=<uuid>, never --all-orgs",
    );
  }

  const orgIds = args.allOrgs ? await listOrgIds() : args.orgIds;
  const actorEmail = process.env.CUTOVER_ACTOR_EMAIL ?? "cli";

  // ── enable ─────────────────────────────────────────────────────────
  if (args.enable) {
    const orgId = orgIds[0] as string;
    const key = args.enable;
    if (args.confirm !== "ENABLE") {
      fail(
        "enabling changes when live patients are contacted. Re-run with --confirm=ENABLE",
      );
    }
    if (!args.evidence || args.evidence.trim().length === 0) {
      fail("--evidence=<ticket-or-change-id> is required for an enable");
    }

    const report = await assessReadiness(orgId, key);
    printReport(orgId, report);
    if (report.status !== "ready") {
      await writeCutoverRecord({
        orgId,
        flagKey: key,
        action: "evaluate",
        previousValue: null,
        newValue: null,
        readinessStatus: report.status,
        report: report as unknown as Record<string, unknown>,
        evidenceId: args.evidence,
        actorEmail,
      });
      console.error(
        `\nREFUSED: ${key} is not ready for org ${orgId}. Nothing was changed.`,
      );
      process.exit(1);
    }

    const previous = await setFlag(orgId, key, true, actorEmail);
    if (previous === null) {
      fail(`org ${orgId} has no ${key} flag row — was it onboarded?`);
    }
    const record = await writeCutoverRecord({
      orgId,
      flagKey: key,
      action: "enable",
      previousValue: previous,
      newValue: true,
      readinessStatus: "ready",
      report: report as unknown as Record<string, unknown>,
      evidenceId: args.evidence,
      actorEmail,
    });
    console.log(`\nENABLED ${key} for org ${orgId} (record ${record.id}).`);
    process.exit(0);
  }

  // ── rollback ───────────────────────────────────────────────────────
  if (args.rollback) {
    const orgId = orgIds[0] as string;
    const key = args.rollback;
    if (args.confirm !== "ROLLBACK") {
      fail("re-run with --confirm=ROLLBACK");
    }
    if (!args.reason || args.reason.trim().length < 10) {
      fail(
        "--reason=<why, at least 10 characters> is required. A rollback " +
          "without a reason is indistinguishable from a flag never turned on.",
      );
    }
    const previous = await setFlag(orgId, key, false, actorEmail);
    if (previous === null) fail(`org ${orgId} has no ${key} flag row`);
    const record = await writeCutoverRecord({
      orgId,
      flagKey: key,
      action: "rollback",
      previousValue: previous,
      newValue: false,
      readinessStatus: "blocked",
      report: { rolledBackFrom: previous },
      evidenceId: args.evidence,
      rollbackReason: args.reason,
      actorEmail,
    });
    console.log(`ROLLED BACK ${key} for org ${orgId} (record ${record.id}).`);
    process.exit(0);
  }

  // ── assess (default, read-only) ────────────────────────────────────
  console.log(
    "Readiness assessment — read-only. Nothing is enabled by this run.\n",
  );
  const summary: Array<Record<string, unknown>> = [];
  let anyBlocked = false;

  for (const orgId of orgIds) {
    console.log(`org ${orgId}`);
    for (const key of CUTOVER_FLAG_KEYS) {
      try {
        const [enabled, report] = await Promise.all([
          readCutoverFlagState(orgId, key),
          // No row budget: the whole point of running from a terminal.
          assessReadiness(orgId, key, { maxEpisodes: 500_000 }),
        ]);
        printReport(orgId, report);
        const record = await writeCutoverRecord({
          orgId,
          flagKey: key,
          action: "evaluate",
          previousValue: enabled,
          newValue: null,
          readinessStatus: report.status,
          report: report as unknown as Record<string, unknown>,
          evidenceId: args.evidence,
          actorEmail,
        });
        const latest = await readLatestCutoverRecord(orgId, key);
        const { state } = resolveReadinessState(latest);
        summary.push({
          orgId,
          flagKey: key,
          currentlyEnabled: enabled,
          verdict: report.status,
          state,
          recordId: record.id,
        });
        if (report.status !== "ready") anyBlocked = true;
      } catch (err) {
        anyBlocked = true;
        console.error(
          `  ${key}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.push({ orgId, flagKey: key, verdict: "error" });
      }
    }
    console.log("");
  }

  if (args.json) console.log(JSON.stringify({ summary }, null, 2));
  console.log(
    anyBlocked
      ? "At least one tenant/flag is BLOCKED. Nothing was changed."
      : "Every tenant/flag assessed is READY. Enable one at a time, with --confirm=ENABLE.",
  );
  process.exit(anyBlocked ? 1 : 0);
}

void main();
