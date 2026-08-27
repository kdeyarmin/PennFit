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

import { renderBrandedEmail } from "@workspace/resupply-email/layout";

import { stripTrailingSlashes } from "../string-utils";

export interface AuthEmailContext {
  /** Software/product name, e.g. "Penn Home Medical Supply" — appears in the subject
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

// Muted "if the button doesn't work" fallback line. Keeps the raw link
// present as selectable text for clients that strip buttons, and for
// recipients who'd rather copy/paste. `safeLink` must already be escaped.
function fallbackLinkHtml(safeLink: string): string {
  return `<p style="margin:20px 0 0;color:#6b7280;font-size:13px;line-height:1.5;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${safeLink}" style="color:#2f6fe6;word-break:break-all;">${safeLink}</a></p>`;
}

// Wrap auth-email body copy in the shared CareMetric Breathe layout. The
// header wordmark shows the caller's product name (the TENANT's brand for
// tenant-facing mail), not the platform name — the design system is
// shared, the brand stays correct (see CLAUDE.md brand architecture).
function wrapAuthHtml(
  ctx: AuthEmailContext,
  opts: {
    heading: string;
    preheader: string;
    bodyHtml: string;
    button?: { label: string; url: string };
  },
): string {
  return renderBrandedEmail({
    brandName: ctx.productName,
    heading: opts.heading,
    preheader: opts.preheader,
    contentHtml: opts.bodyHtml,
    button: opts.button,
    footerLines: ctx.signatureName ? [ctx.signatureName] : [],
    copyrightName: ctx.signatureName || ctx.productName,
  });
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

/** "a" or "an" for a role label, so the invite doesn't greet its
 *  reader with "As a Owner". Vowel-initial is the whole rule the role
 *  catalog needs (Owner, Admin, Biller, Customer service rep,
 *  Respiratory therapist). */
function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/** Lowercase the first character so a second-person sentence can be
 *  spliced after a clause ("As a Biller, you own the revenue cycle…").
 *  Leaves acronyms alone — only a lone leading capital is folded. */
function lowerFirst(s: string): string {
  if (!s) return s;
  if (/^[A-Z][A-Z]/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// Strip CR/LF from any value used in an email subject line to prevent
// header injection (e.g. "PennFit\r\nBcc: attacker@evil.com").
function safeSubjectValue(s: string): string {
  return s.replace(/[\r\n]/g, "");
}

// Shared closing signature for the plain-text bodies (matching the
// "— Penn Home Medical Supply" convention used by the patient-facing
// reminder/renewal emails in resupply-api). The HTML bodies render the
// signature in the branded footer instead (see `wrapAuthHtml`).
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
    html: wrapAuthHtml(ctx, {
      heading: "Confirm your email address",
      preheader: `Verify your email to finish setting up your ${ctx.productName} account.`,
      button: { label: "Verify email address", url: link },
      bodyHtml: `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">Welcome to <strong>${safeName}</strong>. You're one step away — confirm your email address to activate your account.</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">This link expires in ${expiry}. If you didn't create this account, you can safely ignore this email.</p>
${fallbackLinkHtml(safeLink)}`,
    }),
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
    html: wrapAuthHtml(ctx, {
      heading: "Set up your patient portal",
      preheader: `Your care team invited you to your ${ctx.productName} patient portal.`,
      button: { label: "Create your password", url: link },
      bodyHtml: `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">${greetingHtml}</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">Your care team has invited you to set up your <strong>${safeName}</strong> patient portal, where you can manage your CPAP supplies, track shipments, and upload insurance documents.</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">This link expires in ${expiry}.</p>
${attachmentsHtml}<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">If you weren't expecting this invitation, you can safely ignore this email.</p>
${fallbackLinkHtml(safeLink)}`,
    }),
    text: `${greetingText}

Your care team has invited you to set up your ${ctx.productName} patient portal, where you can manage your CPAP supplies, track shipments, and upload insurance documents.

Create your password and get started by visiting:
${link}

This link expires in ${expiry}.

${attachmentsText}If you weren't expecting this invitation, you can safely ignore this email.${signatureText(ctx)}`,
  };
}

/** One document attached to a staff invite, with the one line that
 *  tells the recipient what it is. A bare filename leaves a new hire
 *  guessing which of three PDFs to open first. */
export interface TeamInviteAttachment {
  filename: string;
  /** What this document is, in one line. Optional — omitted renders
   *  the filename alone. */
  description?: string;
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
  /** One sentence describing what the role is responsible for. Renders
   *  the "Your role" section; absent omits it. */
  roleSummary?: string | null;
  /** What the new member will actually do day to day. Rendered as
   *  bullets under the role summary. */
  roleHighlights?: ReadonlyArray<string>;
  /** Name of the person who sent the invitation, so the recipient can
   *  see who to ask. Null renders the neutral "You've been invited". */
  invitedByName?: string | null;
  /** Documents attached to this email, listed in the body so the
   *  recipient knows to look for them and which is which.
   *  Empty/absent omits the attachments section. */
  attachments?: ReadonlyArray<TeamInviteAttachment>;
}

/**
 * Staff invite — a welcome email, NOT a password reset. New team
 * members have never had a password, so "we received a request to
 * reset your password" copy is wrong and confusing for them.
 *
 * This is a new hire's first contact with the software, and it is
 * expected to stand on its own: it welcomes them by name, says who
 * invited them, explains what the product is, spells out their account
 * details (username = sign-in email, role, sign-in page), describes
 * what their ROLE is responsible for, walks the numbered steps from
 * "set a password" through "turn on multi-factor authentication" to
 * "here is where the documentation lives", names each attached
 * document and what it is for, and tells them who to ask. Everything
 * role-specific is passed in by the caller — this package stays
 * brand-neutral and knows nothing about the product's role catalog.
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

  const P = `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">`;
  const SUBHEAD = `<p style="margin:0 0 8px;color:#334155;font-size:16px;line-height:1.6;">`;
  const UL = `<ul style="margin:0 0 16px;padding-left:20px;color:#334155;font-size:16px;line-height:1.7;">`;
  const OL = `<ol style="margin:0 0 16px;padding-left:20px;color:#334155;font-size:16px;line-height:1.7;">`;

  // ── Who invited them ──
  const inviter = args.invitedByName?.trim() || null;
  const invitedByHtml = inviter
    ? `${escapeHtml(inviter)} has invited you to join the <strong>${safeName}</strong> team.`
    : `You've been invited to join the <strong>${safeName}</strong> team.`;
  const invitedByText = inviter
    ? `${inviter} has invited you to join the ${ctx.productName} team.`
    : `You've been invited to join the ${ctx.productName} team.`;

  // ── Account details ──
  const detailsHtml = [
    `<li>Username (your sign-in email): <strong>${escapeHtml(args.email)}</strong></li>`,
    ...(args.roleLabel
      ? [`<li>Role: <strong>${escapeHtml(args.roleLabel)}</strong></li>`]
      : []),
    `<li>Sign-in page: <a href="${safeSignIn}" style="color:#2f6fe6;">${safeSignIn}</a></li>`,
  ].join("\n");
  const detailsText = [
    `  * Username (your sign-in email): ${args.email}`,
    ...(args.roleLabel ? [`  * Role: ${args.roleLabel}`] : []),
    `  * Sign-in page: ${signInUrl}`,
  ].join("\n");

  // ── What their role covers ──
  const highlights = args.roleHighlights ?? [];
  const summary = args.roleSummary?.trim() || null;
  const article = args.roleLabel ? indefiniteArticle(args.roleLabel) : "a";
  const roleIntroHtml = args.roleLabel
    ? `As ${article} <strong>${escapeHtml(args.roleLabel)}</strong>, ${summary ? lowerFirst(escapeHtml(summary)) : ""}`
    : escapeHtml(summary ?? "");
  const roleIntroText = args.roleLabel
    ? `As ${article} ${args.roleLabel}, ${summary ? lowerFirst(summary) : ""}`
    : (summary ?? "");
  const roleHtml =
    summary || highlights.length > 0
      ? `${SUBHEAD}<strong>Your role</strong></p>
${summary ? `${P}${roleIntroHtml}</p>\n` : ""}${
          highlights.length > 0
            ? `${UL}
${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("\n")}
</ul>
`
            : ""
        }`
      : "";
  const roleText =
    summary || highlights.length > 0
      ? `Your role
${summary ? `${roleIntroText}\n` : ""}${
          highlights.length > 0
            ? `${highlights.map((h) => `  * ${h}`).join("\n")}\n`
            : ""
        }
`
      : "";

  // ── Numbered getting-started steps ──
  const steps = [
    {
      html: `Choose your password using the button below. This invitation link expires in ${expiry} — if it lapses first, an administrator can send you a fresh one.`,
      text: `Choose your password: ${link}\n     This invitation link expires in ${expiry} — if it lapses first, an administrator can send you a fresh one.`,
    },
    {
      html: `Sign in at <a href="${safeSignIn}" style="color:#2f6fe6;">${safeSignIn}</a> using your email address as your username. Worth bookmarking.`,
      text: `Sign in at ${signInUrl} using your email address as your username. Worth bookmarking.`,
    },
    {
      html: `Turn on multi-factor authentication in your account settings. Patient records are protected health information, and this is the single most effective safeguard on your account.`,
      text: `Turn on multi-factor authentication in your account settings. Patient records are protected health information, and this is the single most effective safeguard on your account.`,
    },
    {
      html: `Open <strong>Support</strong> in the console to download the full User Manual — it is organised by role, so you can go straight to your own chapters. The in-app assistant on every page answers "how do I…" and "where is…" in plain English.`,
      text: `Open Support in the console to download the full User Manual — it is organised by role, so you can go straight to your own chapters. The in-app assistant on every page answers "how do I..." and "where is..." in plain English.`,
    },
  ];
  const stepsHtml = `${SUBHEAD}<strong>Getting started</strong></p>
${OL}
${steps.map((s) => `<li style="margin-bottom:8px;">${s.html}</li>`).join("\n")}
</ol>
`;
  const stepsText = `Getting started
${steps.map((s, i) => `  ${i + 1}. ${s.text}`).join("\n")}
`;

  // ── Attachments ──
  const files = args.attachments ?? [];
  const docNoun = files.length === 1 ? "document" : "documents";
  const attachmentsHtml =
    files.length > 0
      ? `${P}We've attached the ${docNoun} for your role to this email:</p>
${UL}
${files
  .map(
    (f) =>
      `<li><strong>${escapeHtml(f.filename)}</strong>${f.description ? ` — ${escapeHtml(f.description)}` : ""}</li>`,
  )
  .join("\n")}
</ul>
`
      : "";
  const attachmentsText =
    files.length > 0
      ? `We've attached the ${docNoun} for your role to this email:
${files
  .map((f) => `  * ${f.filename}${f.description ? ` — ${f.description}` : ""}`)
  .join("\n")}

`
      : "";

  const helpHtml = `${P}If anything is unclear — a workflow, a screen you expected to see, or access you think you need — ask ${inviter ? escapeHtml(inviter) : "the administrator who invited you"} or your supervisor. Nobody expects you to know it all on day one.</p>`;
  const helpText = `If anything is unclear — a workflow, a screen you expected to see, or access you think you need — ask ${inviter ?? "the administrator who invited you"} or your supervisor. Nobody expects you to know it all on day one.`;

  return {
    subject: `Welcome to the ${safeSubjectValue(ctx.productName)} team — set up your account`,
    html: wrapAuthHtml(ctx, {
      heading: "Welcome to the team",
      preheader: `${invitedByText} Set up your account to get started.`,
      button: { label: "Set your password", url: link },
      bodyHtml: `${P}${greetingHtml}</p>
${P}${invitedByHtml} ${safeName} is where our team manages CPAP resupply day to day — patient records, insurance and claims, orders and shipments, supply reminders, and the schedules behind them. It runs in any modern browser, so there is nothing to install.</p>
${SUBHEAD}<strong>Your account details</strong></p>
${UL}
${detailsHtml}
</ul>
${roleHtml}${stepsHtml}${attachmentsHtml}${helpHtml}
${P}If you weren't expecting this invitation, you can safely ignore this email — no account is active until a password is set.</p>
${fallbackLinkHtml(safeLink)}`,
    }),
    text: `${greetingText}

${invitedByText} ${ctx.productName} is where our team manages CPAP resupply day to day — patient records, insurance and claims, orders and shipments, supply reminders, and the schedules behind them. It runs in any modern browser, so there is nothing to install.

Your account details
${detailsText}

${roleText}${stepsText}
${attachmentsText}${helpText}

If you weren't expecting this invitation, you can safely ignore this email — no account is active until a password is set.${signatureText(ctx)}`,
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
 * display name (e.g. "Penn Home Medical Supply Provider Portal") — it is rendered
 * after "the", as in "invited to the Penn Home Medical Supply Provider Portal".
 */
export function renderProviderPortalInviteEmail(
  ctx: AuthEmailContext,
  args: ProviderPortalInviteEmailArgs,
): RenderedEmail {
  const link = makeLink(
    ctx.publicBaseUrl,
    ctx.uiPathPrefix,
    // Provider portal chrome (not the patient storefront reset page).
    "/provider/reset-password",
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
    html: wrapAuthHtml(ctx, {
      heading: "Activate your provider portal",
      preheader: `${invitedByText} to the ${ctx.productName} — review and e-sign your patients' documents.`,
      button: { label: "Set your password", url: link },
      bodyHtml: `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">${greetingHtml}</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">${invitedByHtml} to the <strong>${safeName}</strong>, a secure portal where you can review and electronically sign documents for your patients — prescriptions, orders, and certificates of medical necessity — from any browser.</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">Your username is your email address: <strong>${escapeHtml(args.email)}</strong></p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">This invitation link expires in ${expiry}. If it expires before you set your password, the practice can send you a fresh one.</p>
${portalUrl ? `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">After your password is set, you can sign in any time at <a href="${escapeHtml(portalUrl)}" style="color:#2f6fe6;">${escapeHtml(portalUrl)}</a>.</p>\n` : ""}${attachmentsHtml}<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">If you weren't expecting this invitation, you can safely ignore this email.</p>
${fallbackLinkHtml(safeLink)}`,
    }),
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
    html: wrapAuthHtml(ctx, {
      heading: "Reset your password",
      preheader: `Choose a new ${ctx.productName} password.`,
      button: { label: "Choose a new password", url: link },
      bodyHtml: `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">We received a request to reset your <strong>${safeName}</strong> password. Click the button below to choose a new one.</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">This link expires in ${expiry}. If you didn't request a password reset, you can ignore this email — your current password will keep working.</p>
${fallbackLinkHtml(safeLink)}`,
    }),
    text: `We received a request to reset your ${ctx.productName} password.

Choose a new one by visiting:
${link}

This link expires in ${expiry}. If you didn't request a password reset, you can ignore this email — your current password will keep working.${signatureText(ctx)}`,
  };
}
