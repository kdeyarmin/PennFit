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
  /** "PennFit" / "Resupply" — appears in subject + signature. */
  productName: string;
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

export function renderVerifyEmail(
  ctx: AuthEmailContext,
  rawToken: string,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/verify-email",
    rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  return {
    subject: `Verify your email — ${safeSubjectValue(ctx.productName)}`,
    html: `<p>Welcome to ${safeName}.</p>
<p>Click the link below to verify your email address:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>`,
    text: `Welcome to ${ctx.productName}.

Verify your email address by visiting:
${link}

This link expires in 24 hours. If you didn't create this account, you can ignore this email.`,
  };
}

export function renderPatientPortalInviteEmail(
  ctx: AuthEmailContext,
  rawToken: string,
  patientFirstName: string | null,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/reset-password",
    rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  const greeting = patientFirstName
    ? `Hi ${escapeHtml(patientFirstName.split(/\s+/)[0] ?? patientFirstName)},`
    : "Hello,";
  return {
    subject: `Set up your ${safeSubjectValue(ctx.productName)} patient portal`,
    html: `<p>${greeting}</p>
<p>Your care team has invited you to set up your <strong>${safeName}</strong> patient portal, where you can manage your CPAP supplies, view your orders, and upload insurance documents.</p>
<p>Click the link below to create your password and get started:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This link expires in 7 days. If you weren't expecting this invitation, you can safely ignore this email.</p>`,
    text: `${greeting}

Your care team has invited you to set up your ${ctx.productName} patient portal, where you can manage your CPAP supplies, view your orders, and upload insurance documents.

Create your password and get started by visiting:
${link}

This link expires in 7 days. If you weren't expecting this invitation, you can safely ignore this email.`,
  };
}

export function renderPasswordResetEmail(
  ctx: AuthEmailContext,
  rawToken: string,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    "/reset-password",
    rawToken,
  );
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(ctx.productName);
  return {
    subject: `Reset your ${safeSubjectValue(ctx.productName)} password`,
    html: `<p>We received a request to reset your ${safeName} password.</p>
<p>Click the link below to choose a new one:</p>
<p><a href="${safeLink}">${safeLink}</a></p>
<p>This link expires in 1 hour. If you didn't request a password reset, you can ignore this email — your current password will keep working.</p>`,
    text: `We received a request to reset your ${ctx.productName} password.

Choose a new one by visiting:
${link}

This link expires in 1 hour. If you didn't request a password reset, you can ignore this email — your current password will keep working.`,
  };
}
