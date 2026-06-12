// Verification + password-reset email templates.
//
// Kept inline (not in a separate template engine) for two reasons:
//   * The email content is short and stable. A renderer would add
//     a runtime dependency and another piece to test.
//   * Auth emails go out before the user is verified, so they're
//     a high-stakes path where "this template failed to load"
//     would leave the user stuck. Keeping them in TS keeps the
//     deploy story simple.
//
// All copy here is brand-neutral so the same lib can serve both
// the cpap-fitter shop and the resupply staff dashboard. The
// product name is passed in by the caller.

import { stripTrailingSlashes } from "../string-utils";

export interface AuthEmailContext {
  /** Software/product name, e.g. "PennPaps" — appears in the subject
   *  line and body copy. */
  productName: string;
  /** Company name rendered as the closing signature, e.g.
   *  "Penn Home Medical Supply". Omitted → no signature block. */
  signatureName?: string;
  /** Where /verify-email and /reset-password live, no trailing slash. */
  publicBaseUrl: string;
  /**
   * Optional UI path prefix prepended to the verification + reset
   * URL paths. Use `"/admin"` when the link should land on the
   * admin SPA pages (`/admin/reset-password`, `/admin/verify-email`);
   * leave undefined for the customer-facing storefront pages
   * (`/reset-password`, `/verify-email`). Must start with `/` and
   * have no trailing slash.
   */
  uiPathPrefix?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeLink(
  base: string,
  prefix: string | undefined,
  path: string,
  token: string,
): string {
  const safePrefix = stripTrailingSlashes(prefix ?? "");
  return `${base}${safePrefix}${path}?token=${encodeURIComponent(token)}`;
}

// Strip CR/LF from any value used in an email subject line to prevent
// header injection (e.g. "PennFit\r\nBcc: attacker@evil.com").
function safeSubjectValue(s: string): string {
  return s.replace(/[\r\n]/g, "");
}

// Shared closing signature so every auth email signs off the same way
// (matching the "— Penn Home Medical Supply" convention used by the
// patient-facing reminder/renewal emails in resupply-api).
function signatureHtml(ctx: AuthEmailContext): string {
  return ctx.signatureName
    ? `\n<p style="margin:24px 0 0;color:#6b7280;font-size:12px;">${escapeHtml(ctx.signatureName)}</p>`
    : "";
}

function signatureText(ctx: AuthEmailContext): string {
  return ctx.signatureName ? `\n\n— ${ctx.signatureName}` : "";
}

/**
 * Render a token's TTL as the human-readable "this link expires in …"
 * phrase used in the auth emails.
 *
 * Derived from the SAME millisecond value the caller uses to set the
 * token's `expires_at`, so the copy can never drift from the real
 * expiry. (It used to be hardcoded — "1 hour" on the reset email — while
 * the actual reset-token TTL was the 24h `AUTH_EMAIL_TOKEN_TTL_HOURS`
 * default and the team-invite reuse of the same template ran on a 7-day
 * token; every recipient was told the wrong window.)
 *
 * Whole days only roll up at >= 48h (so a 24h token still reads
 * "24 hours", matching the historical verify-email copy, while a 7-day
 * invite doesn't become an absurd "168 hours"); otherwise whole hours,
 * falling back to minutes for sub-hour or non-round values.
 */
export function formatTokenExpiry(ttlMs: number): string {
  const totalMinutes = Math.round(ttlMs / 60_000);
  const MIN_PER_HOUR = 60;
  const MIN_PER_DAY = 60 * 24;
  if (totalMinutes >= 2 * MIN_PER_DAY && totalMinutes % MIN_PER_DAY === 0) {
    const days = totalMinutes / MIN_PER_DAY;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (totalMinutes >= MIN_PER_HOUR && totalMinutes % MIN_PER_HOUR === 0) {
    const hours = totalMinutes / MIN_PER_HOUR;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, totalMinutes);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function renderVerifyEmail(
  ctx: AuthEmailContext,
  rawToken: string,
  ttlMs: number,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/verify-email",
    rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  const expiry = formatTokenExpiry(ttlMs);
  return {
    subject: `Verify your email — ${safeSubjectValue(ctx.productName)}`,
    html: `<p>Welcome to ${safeName}.</p>
<p>Click the link below to verify your email address:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This link expires in ${expiry}. If you didn't create this account, you can ignore this email.</p>${signatureHtml(ctx)}`,
    text: `Welcome to ${ctx.productName}.

Verify your email address by visiting:
${link}

This link expires in ${expiry}. If you didn't create this account, you can ignore this email.${signatureText(ctx)}`,
  };
}

export interface PatientPortalInviteEmailArgs {
  /** Raw set-password token embedded in the invite link. */
  rawToken: string;
  /** Invite-token TTL — drives the "expires in …" copy. */
  ttlMs: number;
  /** Patient's first name for the greeting; null → "Hello,". */
  patientFirstName?: string | null;
  /** Filenames of the getting-started guides attached to this email,
   *  listed in the body so the patient knows to look for them.
   *  Empty/absent omits the attachments section. */
  attachmentFilenames?: ReadonlyArray<string>;
}

export function renderPatientPortalInviteEmail(
  ctx: AuthEmailContext,
  args: PatientPortalInviteEmailArgs,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/reset-password",
    args.rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  const expiry = formatTokenExpiry(args.ttlMs);
  const firstName = args.patientFirstName?.trim().split(/\s+/)[0] || null;
  const greetingText = firstName ? `Hi ${firstName},` : "Hello,";
  const greetingHtml = firstName ? `Hi ${escapeHtml(firstName)},` : "Hello,";
  const files = args.attachmentFilenames ?? [];
  const guideNoun = files.length === 1 ? "guide" : "guides";
  const attachmentsHtml =
    files.length > 0
      ? `<p>We've attached a quick getting-started ${guideNoun} to this email:</p>
<ul>
${files.map((f) => `<li>${escapeHtml(f)}</li>`).join("\n")}
</ul>
`
      : "";
  const attachmentsText =
    files.length > 0
      ? `We've attached a quick getting-started ${guideNoun} to this email:
${files.map((f) => `  * ${f}`).join("\n")}

`
      : "";
  return {
    subject: `Set up your ${safeSubjectValue(ctx.productName)} patient portal`,
    html: `<p>${greetingHtml}</p>
<p>Your care team has invited you to set up your <strong>${safeName}</strong> patient portal, where you can manage your CPAP supplies, view your orders, and upload insurance documents.</p>
<p>Click the link below to create your password and get started:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This link expires in ${expiry}.</p>
${attachmentsHtml}<p>If you weren't expecting this invitation, you can safely ignore this email.</p>${signatureHtml(ctx)}`,
    text: `${greetingText}

Your care team has invited you to set up your ${ctx.productName} patient portal, where you can manage your CPAP supplies, view your orders, and upload insurance documents.

Create your password and get started by visiting:
${link}

This link expires in ${expiry}.

${attachmentsText}If you weren't expecting this invitation, you can safely ignore this email.${signatureText(ctx)}`,
  };
}

export interface TeamInviteEmailArgs {
  /** Raw set-password token embedded in the invite link. */
  rawToken: string;
  /** Invite-token TTL — drives the "expires in …" copy. */
  ttlMs: number;
  /** The new member's sign-in email; doubles as their username. */
  email: string;
  /** Display name for the greeting; null falls back to "Hello,". */
  displayName?: string | null;
  /** Human-readable role label for the account-details block
   *  (e.g. "Customer service rep"). Null omits the Role line. */
  roleLabel?: string | null;
  /** Filenames of the getting-started guides attached to this email,
   *  listed in the body so the recipient knows to look for them.
   *  Empty/absent omits the attachments section. */
  attachmentFilenames?: ReadonlyArray<string>;
}

/**
 * Staff invite — a welcome email, NOT a password reset. New team
 * members have never had a password, so "we received a request to
 * reset your password" copy is wrong and confusing for them. This
 * template welcomes them, explains what the app is, spells out their
 * account details (username = sign-in email, role, sign-in page),
 * links the set-password step, and points at the attached
 * getting-started guides for their role.
 */
export function renderTeamInviteEmail(
  ctx: AuthEmailContext,
  args: TeamInviteEmailArgs,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/reset-password",
    args.rawToken,
  );
  const safePrefix = stripTrailingSlashes(ctx.uiPathPrefix ?? "");
  const signInUrl = `${ctx.publicBaseUrl}${safePrefix}/sign-in`;
  const safeLink = escapeHtml(link);
  const safeSignIn = escapeHtml(signInUrl);
  const safeName = escapeHtml(ctx.productName);
  const expiry = formatTokenExpiry(args.ttlMs);
  const firstName = args.displayName?.trim().split(/\s+/)[0] || null;
  const greetingText = firstName ? `Hi ${firstName},` : "Hello,";
  const greetingHtml = firstName ? `Hi ${escapeHtml(firstName)},` : "Hello,";
  const files = args.attachmentFilenames ?? [];
  const guideNoun = files.length === 1 ? "guide" : "guides";

  const detailsHtml = [
    `<li>Username (your sign-in email): <strong>${escapeHtml(args.email)}</strong></li>`,
    ...(args.roleLabel
      ? [`<li>Role: <strong>${escapeHtml(args.roleLabel)}</strong></li>`]
      : []),
    `<li>Sign-in page: <a href="${safeSignIn}">${safeSignIn}</a></li>`,
  ].join("\n");
  const detailsText = [
    `  * Username (your sign-in email): ${args.email}`,
    ...(args.roleLabel ? [`  * Role: ${args.roleLabel}`] : []),
    `  * Sign-in page: ${signInUrl}`,
  ].join("\n");

  const attachmentsHtml =
    files.length > 0
      ? `<p>We've attached the getting-started ${guideNoun} for your role to this email:</p>
<ul>
${files.map((f) => `<li>${escapeHtml(f)}</li>`).join("\n")}
</ul>
`
      : "";
  const attachmentsText =
    files.length > 0
      ? `We've attached the getting-started ${guideNoun} for your role to this email:
${files.map((f) => `  * ${f}`).join("\n")}

`
      : "";

  return {
    subject: `Welcome to the ${safeSubjectValue(ctx.productName)} team — set up your account`,
    html: `<p>${greetingHtml}</p>
<p>You've been invited to join the <strong>${safeName}</strong> team. ${safeName} is where our team manages CPAP resupply day to day — patient records, orders and shipments, supply reminders, and the schedules behind them.</p>
<p>Your account details:</p>
<ul>
${detailsHtml}
</ul>
<p>To get started, click the link below to set your password and activate your account:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This invitation link expires in ${expiry}. If it expires before you set your password, an administrator can send you a fresh one.</p>
${attachmentsHtml}<p>If you weren't expecting this invitation, you can safely ignore this email.</p>${signatureHtml(ctx)}`,
    text: `${greetingText}

You've been invited to join the ${ctx.productName} team. ${ctx.productName} is where our team manages CPAP resupply day to day — patient records, orders and shipments, supply reminders, and the schedules behind them.

Your account details:
${detailsText}

To get started, set your password and activate your account by visiting:
${link}

This invitation link expires in ${expiry}. If it expires before you set your password, an administrator can send you a fresh one.

${attachmentsText}If you weren't expecting this invitation, you can safely ignore this email.${signatureText(ctx)}`,
  };
}

export interface ProviderPortalInviteEmailArgs {
  /** Raw set-password token embedded in the invite link. */
  rawToken: string;
  /** Invite-token TTL — drives the "expires in …" copy. */
  ttlMs: number;
  /** The provider's sign-in email; doubles as their username. */
  email: string;
  /** Provider's name for the greeting (person or practice legal
   *  name — used whole, not first-word-split). Null → "Hello,". */
  providerName?: string | null;
  /** Name of the practice extending the invitation, e.g.
   *  "Penn Home Medical Supply". Null omits the mention. */
  practiceName?: string | null;
  /** SPA path of the portal itself (e.g. "/provider"). When set, the
   *  email adds a "sign in any time at …" line pointing there. */
  portalPath?: string;
  /** Filenames of guides attached to this email; listed in the body. */
  attachmentFilenames?: ReadonlyArray<string>;
}

/**
 * Provider e-signature portal invite — a welcome email for ordering
 * physicians/NPs, NOT a password reset (the provider has never had a
 * password). Explains what the portal is for (reviewing and e-signing
 * their patients' documents), gives them their username, and links
 * the set-password step. `ctx.productName` should be the portal's
 * display name (e.g. "PennPaps Provider Portal") — it is rendered
 * after "the", as in "invited to the PennPaps Provider Portal".
 */
export function renderProviderPortalInviteEmail(
  ctx: AuthEmailContext,
  args: ProviderPortalInviteEmailArgs,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/reset-password",
    args.rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  const expiry = formatTokenExpiry(args.ttlMs);
  const name = args.providerName?.trim() || null;
  const greetingText = name ? `Hello ${name},` : "Hello,";
  const greetingHtml = name ? `Hello ${escapeHtml(name)},` : "Hello,";
  const practice = args.practiceName?.trim() || null;
  const invitedByText = practice
    ? `${practice} has invited you`
    : `You've been invited`;
  const invitedByHtml = practice
    ? `${escapeHtml(practice)} has invited you`
    : `You've been invited`;
  const portalUrl = args.portalPath
    ? `${ctx.publicBaseUrl}${stripTrailingSlashes(args.portalPath)}`
    : null;
  const files = args.attachmentFilenames ?? [];
  const guideNoun = files.length === 1 ? "guide" : "guides";
  const attachmentsHtml =
    files.length > 0
      ? `<p>We've attached a quick ${guideNoun} to this email:</p>
<ul>
${files.map((f) => `<li>${escapeHtml(f)}</li>`).join("\n")}
</ul>
`
      : "";
  const attachmentsText =
    files.length > 0
      ? `We've attached a quick ${guideNoun} to this email:
${files.map((f) => `  * ${f}`).join("\n")}

`
      : "";

  return {
    subject: `You're invited to the ${safeSubjectValue(ctx.productName)}`,
    html: `<p>${greetingHtml}</p>
<p>${invitedByHtml} to the <strong>${safeName}</strong>, a secure portal where you can review and electronically sign documents for your patients — prescriptions, orders, and certificates of medical necessity — from any browser.</p>
<p>Your username is your email address: <strong>${escapeHtml(args.email)}</strong></p>
<p>Click the link below to set your password and activate your account:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This invitation link expires in ${expiry}. If it expires before you set your password, the practice can send you a fresh one.</p>
${portalUrl ? `<p>After your password is set, you can sign in any time at <a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl)}</a>.</p>\n` : ""}${attachmentsHtml}<p>If you weren't expecting this invitation, you can safely ignore this email.</p>${signatureHtml(ctx)}`,
    text: `${greetingText}

${invitedByText} to the ${ctx.productName}, a secure portal where you can review and electronically sign documents for your patients — prescriptions, orders, and certificates of medical necessity — from any browser.

Your username is your email address: ${args.email}

Set your password and activate your account by visiting:
${link}

This invitation link expires in ${expiry}. If it expires before you set your password, the practice can send you a fresh one.

${portalUrl ? `After your password is set, you can sign in any time at ${portalUrl}.\n\n` : ""}${attachmentsText}If you weren't expecting this invitation, you can safely ignore this email.${signatureText(ctx)}`,
  };
}

export function renderPasswordResetEmail(
  ctx: AuthEmailContext,
  rawToken: string,
  ttlMs: number,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/reset-password",
    rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  const expiry = formatTokenExpiry(ttlMs);
  return {
    subject: `Reset your ${safeSubjectValue(ctx.productName)} password`,
    html: `<p>We received a request to reset your ${safeName} password.</p>
<p>Click the link below to choose a new one:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This link expires in ${expiry}. If you didn't request a password reset, you can ignore this email — your current password will keep working.</p>${signatureHtml(ctx)}`,
    text: `We received a request to reset your ${ctx.productName} password.

Choose a new one by visiting:
${link}

This link expires in ${expiry}. If you didn't request a password reset, you can ignore this email — your current password will keep working.${signatureText(ctx)}`,
  };
}
