// pg-boss job: daily "ready to sync to PacWare" digest.
//
// Why this exists
// ---------------
// When a patient confirms a resupply (SMS YES / email link / voice
// agent), the episode flips to `confirmed` and fulfillment rows queue —
// but PacWare is a legacy desktop billing system with NO API, so
// nothing ships until an operator exports the resupply-due CSV from
// /admin/pacware and imports it into PacWare. Before this job, the
// only nudge was the in-app "ready to sync" banner, which an operator
// has to remember to look at. Confirmed orders could sit for days —
// the single biggest gap between "patient said yes" and "supplies
// shipped".
//
// What this job does
// ------------------
// Once a day, when the operator has opted into auto-sync notices
// (the `pacware.auto_sync` app_config toggle — the SAME opt-in that
// drives the in-app banner), count the episodes sitting in
// `confirmed` and email a counts-only summary to the ops alerts
// mailbox with a pointer to /admin/pacware. Nothing is ever pushed
// to PacWare automatically — this is a reminder, not a sync.
//
// PHI policy
// ----------
// The email contains COUNTS ONLY. No patient names, no SKUs, no
// references — an operator gets everything else from /admin/pacware
// behind the admin gate. This keeps the digest safe for any ops
// mailbox (CLAUDE.md hard rule: treat every outbound surface as
// world-readable).

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

export const PACWARE_DIGEST_JOB = "pacware.ready-to-sync-digest";

/**
 * Daily at 13:10 UTC (≈ 9:10 AM US Eastern) — right after the
 * failed-order-emails digest so ops gets one morning sweep of
 * actionable email, while the workday is just starting.
 */
export const PACWARE_DIGEST_CRON = "10 13 * * *";

// Non-catalog app_config key. Must match AUTO_SYNC_KEY in
// routes/admin/pacware.ts — it is the operator's opt-in for
// "tell me when there's something to sync".
const AUTO_SYNC_KEY = "pacware.auto_sync";

export interface PacwareDigestResult {
  /** Episodes currently in `confirmed`, waiting on a PacWare export. */
  readyCount: number;
  /** `true` when we composed and sent a digest. */
  sent: boolean;
  /** When `sent: false`, the reason for ops triage. */
  skippedReason?: "auto_sync_off" | "nothing_ready" | "sendgrid_not_configured";
}

/** Aggregate tally for one fan-out tick across every active tenant. */
export interface PacwareDigestRunResult {
  /** Active tenants swept this tick. */
  total: number;
  /** Tenants that composed and sent a digest. */
  sentCount: number;
  /** Total confirmed episodes across the tenants that were emailed. */
  readyCount: number;
  /** Tenant ids whose per-tenant sweep threw (already logged + isolated). */
  failedOrgIds: string[];
  /** Set only when the run short-circuited before fanning out. */
  skippedReason?: "no_recipient";
}

function composeDigestEmail(opts: {
  recipient: string;
  readyCount: number;
  practiceName: string;
}): {
  to: string;
  subject: string;
  html: string;
  text: string;
} {
  const { recipient, readyCount, practiceName } = opts;
  const noun = readyCount === 1 ? "order is" : "orders are";
  const subject = `${practiceName}: ${readyCount} confirmed resupply ${noun} ready to sync to PacWare`;
  const body =
    `${readyCount} confirmed resupply ${noun} waiting on a PacWare export. ` +
    `Nothing ships until the CSV is imported into PacWare, so this is the ` +
    `gap between "patient said yes" and "supplies shipped".\n\n` +
    `Action: open /admin/pacware → Sync to PacWare → verify the preview → ` +
    `download the resupply-due CSV → import into PacWare.`;
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto;">
    <h2 style="color: #001f3f;">${readyCount} confirmed resupply ${noun} ready to sync to PacWare</h2>
    <p style="color: #444;">Nothing ships until the CSV is imported into PacWare, so this is the gap between &ldquo;patient said yes&rdquo; and &ldquo;supplies shipped&rdquo;.</p>
    <p style="color: #444;">Action: open <code>/admin/pacware</code> &rarr; Sync to PacWare &rarr; verify the preview &rarr; download the resupply-due CSV &rarr; import into PacWare.</p>
  </body>
</html>`;
  return { to: recipient, subject, html, text: body };
}

/**
 * Runs one digest scan + (optional) send for a SINGLE tenant. Side effects:
 * two org-scoped Supabase reads (this tenant's `pacware.auto_sync` opt-in
 * and its confirmed-episode count) and the SendGrid send. Extracted so the
 * cron can fan out across every active tenant — `app_config` and `episodes`
 * are tenant-scoped, so each tenant's opt-in and "ready to sync" count are
 * read on its own org-scoped client and one tenant's confirmed episodes can
 * never be counted into another's digest. Exported for tests.
 */
export async function pacwareDigestForOrg(
  orgId: string,
  opts: { recipient: string; practiceName: string },
): Promise<PacwareDigestResult> {
  const { recipient, practiceName } = opts;
  const supabase = getOrgScopedClient(orgId);

  // Operator opt-in. Fail-soft to "off" on any read error — a config
  // hiccup must not start emailing an operator who never opted in.
  const { data: cfg, error: cfgErr } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", AUTO_SYNC_KEY)
    .limit(1)
    .maybeSingle();
  if (cfgErr || (cfg as { value?: string } | null)?.value !== "true") {
    return { readyCount: 0, sent: false, skippedReason: "auto_sync_off" };
  }

  // Same definition as the in-app banner's "ready to sync" count
  // (routes/admin/pacware.ts getPendingCounts): confirmed episodes
  // with a prescription + patient attached.
  const { count, error: countErr } = await supabase
    .from("episodes")
    .select("id, prescriptions!inner(id), patients!inner(id)", {
      count: "exact",
      head: true,
    })
    .eq("status", "confirmed");
  if (countErr) throw countErr;
  const readyCount = count ?? 0;

  if (readyCount === 0) {
    return { readyCount: 0, sent: false, skippedReason: "nothing_ready" };
  }

  let sendgrid;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return {
        readyCount,
        sent: false,
        skippedReason: "sendgrid_not_configured",
      };
    }
    throw err;
  }

  const message = composeDigestEmail({ recipient, readyCount, practiceName });
  await sendgrid.sendEmail({
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    customArgs: { kind: "ops_pacware_ready_to_sync_digest_v1" },
  });

  return { readyCount, sent: true };
}

/**
 * Runs the "ready to sync" digest for EVERY active tenant. Resolves the ops
 * recipient + practice name once, then fans out across active tenants with
 * per-tenant failure isolation (forEachActiveOrg), aggregating the tally.
 * Each tenant's opt-in and confirmed-episode count are read on its own
 * org-scoped client, so a tenant that hasn't opted into PacWare auto-sync is
 * simply skipped and no tenant's counts bleed into another's digest.
 * Exported for tests; `opts.listOrgIds` is a test seam.
 */
export async function runPacwareReadyToSyncDigest(
  opts: { listOrgIds?: () => Promise<string[]> } = {},
): Promise<PacwareDigestRunResult> {
  const recipient = process.env.RESUPPLY_ADMIN_ALERTS_EMAIL?.trim();
  if (!recipient) {
    return {
      total: 0,
      sentCount: 0,
      readyCount: 0,
      failedOrgIds: [],
      skippedReason: "no_recipient",
    };
  }
  const practiceName =
    process.env.RESUPPLY_PRACTICE_NAME ?? "CareMetric Breathe";

  let sentCount = 0;
  let readyCount = 0;
  const fan = await forEachActiveOrg(
    async (orgId) => {
      const result = await pacwareDigestForOrg(orgId, {
        recipient,
        practiceName,
      });
      if (result.sent) {
        sentCount += 1;
        readyCount += result.readyCount;
      }
    },
    { jobName: PACWARE_DIGEST_JOB, listOrgIds: opts.listOrgIds },
  );

  return {
    total: fan.total,
    sentCount,
    readyCount,
    failedOrgIds: fan.failedOrgIds,
  };
}

export async function registerPacwareReadyToSyncDigestJob(
  boss: PgBoss,
): Promise<void> {
  if (!process.env.RESUPPLY_ADMIN_ALERTS_EMAIL?.trim()) {
    logger.info(
      { event: "pacware.ready-to-sync-digest.no_recipient" },
      "pacware.ready-to-sync-digest: RESUPPLY_ADMIN_ALERTS_EMAIL is empty; not registered",
    );
    // A previously persisted pg-boss schedule keeps enqueueing ticks
    // into this now-worker-less queue (and replays them in a burst on
    // re-enable). Clear it so unsetting the recipient actually stops
    // the cron (table-guard pattern).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(PACWARE_DIGEST_JOB).catch(() => undefined);
    }
    return;
  }
  await createQueueWithDlq(boss, PACWARE_DIGEST_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(PACWARE_DIGEST_JOB, async () => {
    try {
      // The runtime kill switch is the operator's own pacware.auto_sync
      // toggle, checked inside the run — no separate feature flag.
      const result = await runPacwareReadyToSyncDigest();
      logger.info(
        { event: "pacware.ready-to-sync-digest.completed", ...result },
        "pacware.ready-to-sync-digest: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "pacware.ready-to-sync-digest: failed",
      );
      throw err;
    }
  });
  await boss.schedule(PACWARE_DIGEST_JOB, PACWARE_DIGEST_CRON);
  logger.info(
    { cron: PACWARE_DIGEST_CRON },
    "pacware.ready-to-sync-digest scheduled",
  );
}
