// tenant:offboard — wind down a tenant (DME company): set its status to
// suspended/archived and RELEASE its provisioned fax number back to Telnyx
// so the platform stops paying for the DID.
//
// This is the counterpart to tenant:onboard's fax provisioning step
// (migration 0368). Onboarding can auto-order a fax number; offboarding
// gives it back. The number's unique partial index means the freed DID is
// available to a future tenant.
//
// Usage:
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   [TELNYX_API_KEY=... TELNYX_FAX_CONNECTION_ID=...] \
//   pnpm --filter @workspace/scripts tenant:offboard \
//     --org-slug=acme-dme [--status=archived] [--keep-fax-number]
//
//   * --status            archived (default) | suspended. (Use `active`
//                         via tenant:onboard to bring a tenant back.)
//   * --keep-fax-number   do NOT release the fax number (e.g. a temporary
//                         suspension where you want to keep the DID).
//
// Fax release is the DEFAULT (the whole point of offboarding is to stop
// paying). It is fail-soft: a Telnyx error is reported but the DB columns
// are still cleared and the status change still applies — so a re-run after
// a partial failure is safe and the freed-up record can be reconciled.
//
// Scope: this script changes the tenant's STATUS and frees its fax number.
// It deliberately does NOT delete patient data or disable admin logins —
// data retention / access revocation are separate operator decisions.
//
// Exit codes:
//   0 — success
//   1 — invalid args / db error / org not found / unexpected
//   2 — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createTelnyxNumberClient,
  TelnyxConfigError,
} from "@workspace/resupply-telecom";

interface ParsedArgs {
  orgSlug: string;
  status: "suspended" | "archived";
  keepFaxNumber: boolean;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[tenant:offboard] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) flags.add(raw.slice(2));
    else args.set(raw.slice(2, eq), raw.slice(eq + 1));
  }

  const orgSlug = (args.get("org-slug") ?? "").trim().toLowerCase();
  if (!orgSlug) fail("--org-slug=<slug> is required.");

  const statusRaw = args.get("status") ?? "archived";
  if (statusRaw !== "suspended" && statusRaw !== "archived") {
    fail("--status must be 'suspended' or 'archived'.");
  }

  return {
    orgSlug,
    status: statusRaw,
    keepFaxNumber: flags.has("keep-fax-number"),
  };
}

/**
 * Release the tenant's fax number back to Telnyx and clear the columns.
 * Fail-soft: the Telnyx delete may fail (creds unset, transient API error)
 * but we ALWAYS clear the DB columns so the tenant no longer routes/sends
 * on a number we're trying to give up — the orphaned DID is then a billing
 * reconcile, not a routing bug. Returns a human-readable summary line.
 */
async function releaseTenantFax(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  orgId: string,
  faxNumber: string,
  telnyxOrderId: string | null,
): Promise<string> {
  let telnyxResult = "skipped (no Telnyx credentials)";
  if (process.env.TELNYX_API_KEY?.trim()) {
    try {
      const client = createTelnyxNumberClient();
      const { released, phoneNumberId } =
        await client.releaseFaxNumber(faxNumber);
      telnyxResult = released
        ? `released from Telnyx (id=${phoneNumberId})`
        : "not found on Telnyx account (already released)";
    } catch (err) {
      if (err instanceof TelnyxConfigError) {
        telnyxResult = "skipped (Telnyx not configured)";
      } else {
        telnyxResult = `FAILED to release from Telnyx: ${
          err instanceof Error ? err.message : "unknown"
        } — reconcile by hand`;
      }
    }
  }

  const { error } = await supabase
    .schema("resupply")
    .from("organizations")
    .update({
      fax_from_number: null,
      fax_telnyx_order_id: null,
      fax_provisioned_at: null,
    })
    .eq("id", orgId);
  if (error) throw error;

  const provenance = telnyxOrderId ? "Telnyx-provisioned" : "manually-set";
  return `${faxNumber} (${provenance}) — columns cleared; ${telnyxResult}`;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", 2);
  }

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  // ── 1. Look up the tenant by slug. ─────────────────────────────────
  const { data: org, error: findErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .select("id, name, status, fax_from_number, fax_telnyx_order_id")
    .eq("slug", a.orgSlug)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!org) fail(`No organization found with slug '${a.orgSlug}'.`);

  // ── 2. Set the tenant status. ──────────────────────────────────────
  const { error: statusErr } = await supabase
    .schema("resupply")
    .from("organizations")
    .update({ status: a.status, updated_at: nowIso })
    .eq("id", org.id);
  if (statusErr) throw statusErr;

  // ── 3. Release the fax number (default) unless --keep-fax-number. ───
  let faxResult: string;
  if (a.keepFaxNumber) {
    faxResult = org.fax_from_number
      ? `kept (${org.fax_from_number}) — --keep-fax-number`
      : "none";
  } else if (!org.fax_from_number) {
    faxResult = "none to release";
  } else {
    faxResult = await releaseTenantFax(
      supabase,
      org.id,
      org.fax_from_number,
      org.fax_telnyx_order_id,
    );
  }

  process.stdout.write(
    `\n[tenant:offboard] Tenant '${a.orgSlug}' offboarded.\n` +
      `  organization = ${org.name} org_id=${org.id}\n` +
      `  status       = ${org.status} → ${a.status}\n` +
      `  fax number   = ${faxResult}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[tenant:offboard] failed: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
