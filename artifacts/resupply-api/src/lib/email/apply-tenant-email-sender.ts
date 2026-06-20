// Tenant-aware From override for the lib/resupply-reminders email helpers
// (G6 Phase 2).
//
// `sendReminderEmail` / `replyInConversation` live in lib/resupply-reminders
// and CANNOT import @workspace/resupply-api (monorepo layering — libs must
// not depend on the app). But they already accept the From identity via
// their `EmailSendConfig.sendgridFromEmail` / `sendgridFromName` fields. So
// instead of threading the tenant resolver INTO the lib, the app-side
// callers resolve the tenant sender here and OVERRIDE those two fields on
// the config they pass in.
//
// Fail-soft is inherited from `resolveTenantSender`: a NULL/blank tenant
// from_email (or any lookup error) leaves the platform default From in
// place — the config's existing `sendgridFromEmail` / `sendgridFromName`
// (which come from `SENDGRID_FROM_EMAIL` / `SENDGRID_FROM_NAME`) are
// preserved untouched.

import { resolveTenantSender } from "./tenant-sender";

/** The subset of EmailSendConfig this helper rewrites. */
interface EmailFromConfig {
  sendgridFromEmail: string;
  sendgridFromName: string;
}

/**
 * Return a copy of `cfg` with its From identity replaced by the tenant's
 * own (migration 0360 `organizations.from_email` / `from_name`) when the
 * tenant has one configured. When the tenant has no override (or on any
 * lookup error) the platform-default From already on `cfg` is preserved,
 * so single-tenant behavior is unchanged.
 */
export async function applyTenantEmailSender<T extends EmailFromConfig>(
  orgId: string | undefined,
  cfg: T,
): Promise<T> {
  const sender = await resolveTenantSender(orgId);
  if (!sender.fromEmail) return cfg;
  return {
    ...cfg,
    sendgridFromEmail: sender.fromEmail,
    // resolveTenantSender pins a (possibly empty) fromName whenever it
    // returns an address, so a non-Penn tenant never inherits the seed
    // tenant's "PennPaps" display name.
    sendgridFromName: sender.fromName ?? "",
  };
}
