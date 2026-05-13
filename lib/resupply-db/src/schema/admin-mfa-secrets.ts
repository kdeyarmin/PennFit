import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { adminUsers } from "./admin-users";
import { resupplySchema } from "./_schema";

/**
 * admin_mfa_secrets — TOTP shared secrets for admin/CSR accounts.
 *
 * Why this table exists
 * ---------------------
 * Accreditation surveyors (ACHC, BOC, TJC) ask explicitly whether
 * admin sign-in is protected by something stronger than a password.
 * HIPAA Security Rule §164.312(d) requires Person or Entity
 * Authentication; while not a literal "must use MFA," every recent
 * OCR resolution agreement names MFA as the reasonable safeguard
 * for PHI-handling user accounts.
 *
 * Phase A (this sprint) is enrollment-only: an admin can enroll a
 * TOTP authenticator app and the table records the verified
 * secret. The sign-in handler is NOT changed yet — making MFA
 * mandatory at sign-in is Phase B, after the enrollment flow is
 * proven in production.
 *
 * Why TOTP (RFC 6238) vs WebAuthn / SMS
 * --------------------------------------
 *   * WebAuthn (passkeys / hardware keys) is stronger but requires
 *     a browser-side ceremony, fallback for users who don't carry
 *     a security key, and an attestation registry. Worth shipping
 *     later; not the minimum-viable HIPAA-binder posture.
 *   * SMS is what the OWASP top-10 explicitly recommends AGAINST
 *     for MFA — SIM-swap risk is well-documented and OCR
 *     enforcement has cited it adversely. We don't ship SMS-MFA
 *     even as an alternate option.
 *   * TOTP via Google Authenticator / Authy / 1Password is what
 *     every clinical SaaS uses for the same reason: it's
 *     well-understood, works offline, and the threat model is
 *     "phone in the user's pocket."
 *
 * Schema posture
 * --------------
 * One row per admin (UNIQUE staff_user_id) regardless of enrollment
 * status. A row with verified_at=NULL is an in-progress enrollment;
 * a row with verified_at set is an active enrollment. The
 * "Begin enroll" endpoint upserts (overwrite-if-unverified)
 * so re-attempting enrollment doesn't accrete unverified rows.
 *
 * `last_used_counter` is the canonical replay-prevention surface:
 * the verify endpoint refuses any code whose matched counter is
 * ≤ this value, so a 30-second-window replay is rejected. RFC
 * 6238 §5.2 recommends exactly this.
 *
 * PHI / secret posture
 * --------------------
 * `secret_base32` IS a secret — anyone with read access to this
 * row can generate valid TOTP codes for the account it belongs
 * to. We protect it with Postgres row-level access (the
 * service-role client is the only reader), same posture as
 * `auth.password_credentials.password_hash`. We do NOT add
 * column-level encryption: see CLAUDE.md, the project deliberately
 * removed pgcrypto column encryption (migration 0025) in favor of
 * boundary-level access control + DB encryption-at-rest.
 *
 * Audit envelopes record only enrollment events + the user id —
 * never the secret, never the codes the user typed.
 */
export const adminMfaSecrets = resupplySchema.table(
  "admin_mfa_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),

    secretBase32: text("secret_base32").notNull(),

    /** NULL until the admin types a valid code via the verify
     *  endpoint. NOT-NULL means "MFA is active on this admin." */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    /** Stamped on every successful verify (initial + sign-in). */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

    /** The TOTP counter (Math.floor(unix_seconds / 30)) that the
     *  most recent successful verify accepted. Used to reject
     *  replays of the same code within a 30-second window:
     *  next verify refuses any counter ≤ this value. */
    lastUsedCounter: bigint("last_used_counter", { mode: "number" }),

    /**
     * Per-device label, supplied at enrollment time so an admin
     * with multiple devices can tell their iPhone from their
     * desktop authenticator from a Yubikey backup. Optional —
     * defaults to "Device 1" / "Device 2" / … client-side when
     * the user didn't bother to name it. (Migration 0091 widened
     * the (staff_user_id) UNIQUE constraint to allow multiple
     * rows; this column is how the SPA disambiguates the list.)
     */
    deviceLabel: varchar("device_label", { length: 64 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    // Multi-device (migration 0091): the (staff_user_id) UNIQUE
    // constraint was dropped to let an admin enroll a phone +
    // hardware key. We still want fast per-user lookups during
    // sign-in verify, so the column is indexed (non-unique).
    staffUserIdx: index("admin_mfa_secrets_staff_user_idx").on(
      t.staffUserId,
    ),
    verifiedAtIdx: index("admin_mfa_secrets_verified_at_idx").on(
      t.verifiedAt,
    ),
  }),
);

export type AdminMfaSecretRow = typeof adminMfaSecrets.$inferSelect;
export type InsertAdminMfaSecretRow = typeof adminMfaSecrets.$inferInsert;
