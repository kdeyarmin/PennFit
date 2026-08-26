// Tenant-aware From override for the lib/resupply-reminders email helpers
// (G6 Phase 2), plus patient click-link base URL (tenant custom domain).
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
//
// When `cfg` also carries `publicBaseUrl` (confirm/edit/stop click links),
// prefer the tenant's verified custom domain so Penn patients land on
// pennpaps.com rather than cmbreathe.com / Railway. Do NOT apply this to
// SMS configs — Twilio status-callback signatures must stay on the
// platform host.

import { resolveTenantLinkBaseUrl } from "../tenant-branding";
import {
  isPatientEmailClickBaseReady,
  platformPublicBaseUrl,
} from "../order-emails/link-base";
import { resolveTenantSender } from "./tenant-sender";

/** The subset of EmailSendConfig this helper rewrites. */
interface EmailFromConfig {
  sendgridFromEmail: string;
  sendgridFromName: string;
  /** Optional — patient email click links only. */
  publicBaseUrl?: string;
}

/**
 * Return a copy of `cfg` with its From identity replaced by the tenant's
 * own (migration 0360 `organizations.from_email` / `from_name`) when the
 * tenant has one configured. When the tenant has no override (or on any
 * lookup error) the platform-default From already on `cfg` is preserved,
 * so single-tenant behavior is unchanged.
 *
 * Also rewrites `publicBaseUrl` via `resolveTenantLinkBaseUrl` (seed may
 * use the platform host; non-seed without a verified domain gets an empty
 * string so callers refuse to mint platform click links).
 */
export async function applyTenantEmailSender<T extends EmailFromConfig>(
  orgId: string | undefined,
  cfg: T,
): Promise<T> {
  let next: T = cfg;
  const sender = await resolveTenantSender(orgId);
  if (sender.fromEmail) {
    next = {
      ...next,
      sendgridFromEmail: sender.fromEmail,
      // resolveTenantSender pins a (possibly empty) fromName whenever it
      // returns an address, so a non-Penn tenant never inherits the seed
      // tenant's "Penn Home Medical Supply" display name.
      sendgridFromName: sender.fromName ?? "",
    };
  }
  if (orgId && typeof next.publicBaseUrl === "string") {
    const linkBase = await resolveTenantLinkBaseUrl(
      orgId,
      platformPublicBaseUrl(next.publicBaseUrl),
    );
    next = {
      ...next,
      publicBaseUrl: linkBase ?? "",
    };
  }
  return next;
}

export { isPatientEmailClickBaseReady };
