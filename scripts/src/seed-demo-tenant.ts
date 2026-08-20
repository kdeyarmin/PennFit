// demo:seed — stand up a REAL, fully-operational demo tenant that can be
// used to run live sales demos and to train new staff.
//
// This is deliberately NOT the same thing as the public marketing demo.
// There are two distinct "demos" in this product and conflating them is
// the mistake this header exists to prevent:
//
//   * `artifacts/cpap-fitter/src/demo/` — the PUBLIC, signed-out sandbox
//     linked from the marketing site. A `window.fetch` interceptor answers
//     every API call from in-browser fixtures. Nothing is persisted, no
//     backend is involved, and nothing can actually be sent. Anyone may
//     use it; it is a brochure that clicks.
//
//   * THIS script — a genuine tenant in the real database, behind a real
//     password. Every feature is switched on and every action does what it
//     would do for a paying customer: rows persist, worklists advance,
//     the assistants answer, the fitter writes reports. It is the tenant
//     you screen-share to a prospect, and the tenant you let a new hire
//     make mistakes in.
//
// Run with:
//   ALLOW_DEMO_SEED=1 \
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @workspace/scripts demo:seed
//
// Flags:
//   --dry-run          Print what would be written; touch nothing.
//   --clean            Remove every demo row (and the org), then exit.
//   --email=...        Demo login (default: demo@cmbreathe.com).
//   --password=...     Demo password (default: Demo123).
//   --org-slug=...     Tenant slug (default: demo).
//   --org-name=...     Tenant display name.
//   --plan=...         Billing plan code to assign (default: none).
//   --flags=all|preset|copy
//                      Feature-flag posture (default: all — a demo should
//                      show the whole product).
//   --emit-sql         Print the INSERT … ON CONFLICT statements instead of
//                      writing. Needs no database connection and no
//                      service-role key; pair with --org-id= to fill in the
//                      tenant, or substitute the :ORG_ID placeholder.
//   --force            Bypass the ALLOW_DEMO_SEED guard.
//
// ── Why the login is an email address ────────────────────────────────
// There is no username column and no username sign-in path. `sign-in`
// runs the submitted identifier through `normalizeEmail()`
// (lib/resupply-auth/src/email.ts), which THROWS on anything without an
// `@`; the handler folds that throw into the generic "invalid email or
// password". So a bare `demo` cannot authenticate no matter what is in
// the database. `demo@cmbreathe.com` is the platform-domain spelling of
// the same thing — the operator types "demo" and the domain is the
// constant part.
//
// ── Why the password bypasses the policy gate ────────────────────────
// `PASSWORD_MIN_LENGTH` is 12 and the default here (`Demo123`) is 7. The
// policy is enforced on sign-UP / reset / change — never on sign-IN,
// which only verifies the argon2id hash. Hashing directly therefore
// produces an account that signs in normally and forever. The one
// consequence: the reset-password flow will refuse to set this same
// value again, so rotate to a 12+ character password if you ever use it.
// Pass --password= to choose a compliant one instead.
//
// ── Why this cannot spam real people ─────────────────────────────────
// The recurring reminder worker sweeps EVERY active org, so a demo
// tenant is swept too. Three independent guards keep that harmless:
//   1. Every phone number is in the +1 (XXX) 555-01XX range reserved for
//      fiction, and every address is on `example.com` (RFC 2606). Neither
//      can reach a real person.
//   2. Reminder eligibility is `daysBetween(lastFulfilled ?? rxCreated,
//      now) >= cadenceDays` (worker/jobs/reminders.ts). Every seeded
//      patient gets a RECENT `fulfillments` row, so the baseline is fresh
//      and nobody is due.
//   3. Only two patients sit in a live funnel status at all
//      (`outreach_pending` / `awaiting_response`); the rest are terminal
//      (`confirmed` / `fulfilled`) and are excluded from the scan.
// The console still shows a full, busy-looking book of business.
//
// Idempotent: every row has a fixed UUID under the `0dec0de0` prefix, so
// a re-run updates in place. `--clean` removes exactly those rows.

import {
  getSupabaseServiceRoleClient,
  SEED_ORG_SLUG,
} from "@workspace/resupply-db";
import {
  hashPassword,
  normalizeEmail,
  supabaseAuthRepository,
} from "@workspace/resupply-auth";

import {
  DEMO_UUID_PREFIX,
  id,
  PATIENTS,
  PROVIDERS,
  THREADS,
} from "./demo-tenant-data";

const TAG = "[demo:seed]";
function out(msg: string): void {
  process.stdout.write(`${TAG} ${msg}\n`);
}
function fail(msg: string): never {
  process.stderr.write(`${TAG} ${msg}\n`);
  process.exit(1);
}

// ── Args ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dryRun = flag("dry-run");
const clean = flag("clean");
const emitSql = flag("emit-sql");
const force = flag("force");
const demoEmail = opt("email", "demo@cmbreathe.com");
const demoPassword = opt("password", "Demo123");
const orgSlug = opt("org-slug", "demo");
const orgName = opt("org-name", "CareMetric Demo DME");
const storefrontName = opt("storefront-name", "CareMetric Demo");
const planCode = opt("plan", "");
const flagsMode = opt("flags", "all");

if (!["all", "preset", "copy"].includes(flagsMode)) {
  fail("--flags must be one of: all, preset, copy");
}
// Mirrors the DB CHECK on organizations.slug (0331_organizations_tenant).
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(orgSlug)) {
  fail(`--org-slug must be a URL-safe lowercase label (got '${orgSlug}').`);
}

// Same posture as seed:sample — writing a whole fake tenant is never
// something that should happen because a command was pasted twice.
if (!dryRun && !emitSql && !force && process.env.ALLOW_DEMO_SEED !== "1") {
  fail(
    "refusing to write without ALLOW_DEMO_SEED=1 (or --force). " +
      "Re-run with ALLOW_DEMO_SEED=1 once you've confirmed the target " +
      "database. (--dry-run and --emit-sql write nothing and need no " +
      "opt-in.)",
  );
}

// ── Time helpers ─────────────────────────────────────────────────────

const nowIso = new Date().toISOString();
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}
function dateAgo(n: number): string {
  return daysAgo(n).slice(0, 10);
}
function dateFromNow(n: number): string {
  return daysFromNow(n).slice(0, 10);
}

// ── DB plumbing ──────────────────────────────────────────────────────

// Lazily constructed so --dry-run works with no SUPABASE_* env set
// (getSupabaseServiceRoleClient validates eagerly).
let _supabase: ReturnType<typeof getSupabaseServiceRoleClient> | null = null;
function db(): ReturnType<typeof getSupabaseServiceRoleClient> {
  if (!_supabase) _supabase = getSupabaseServiceRoleClient();
  return _supabase;
}
function rs() {
  return db().schema("resupply");
}

function check(label: string, error: unknown): void {
  if (error) {
    fail(
      `${label} failed: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );
  }
}

// ── Tenant provisioning ──────────────────────────────────────────────

/** Create the demo organization, or reuse it when the slug already exists. */
async function ensureOrg(): Promise<{ orgId: string; action: string }> {
  const { data: existing, error: findErr } = await rs()
    .from("organizations")
    .select("id, name, status")
    .eq("slug", orgSlug)
    .maybeSingle();
  check("find organization", findErr);

  if (existing) {
    // Re-assert the display fields so a re-run repairs a hand-edited org,
    // but never touch `status` — suspending a tenant is an operator
    // decision this script has no business reversing.
    const { error } = await rs()
      .from("organizations")
      .update({
        name: orgName,
        storefront_name: storefrontName,
        tagline: "Sleep therapy resupply, handled.",
        updated_at: nowIso,
      })
      .eq("id", existing.id);
    check("update organization", error);
    return { orgId: existing.id, action: "existing" };
  }

  const { data: created, error } = await rs()
    .from("organizations")
    .insert({
      slug: orgSlug,
      name: orgName,
      status: "active",
      storefront_name: storefrontName,
      tagline: "Sleep therapy resupply, handled.",
    })
    .select("id")
    .single();
  check("insert organization", error);
  return { orgId: created!.id, action: "created" };
}

/**
 * Give the tenant its own feature-flag rows. `feature_flags` is keyed
 * (org_id, key) since migration 0350, so a new org has NO flags at all
 * until they are copied — and an admin console with no flag rows renders
 * an empty sidebar.
 *
 * Default posture is `all`: a demo tenant exists to show the whole
 * product, so every flag in the catalog is switched on. `copy` mirrors
 * the seed tenant's live state instead, and `preset` leaves whatever a
 * plan preset already established.
 */
async function provisionFeatureFlags(
  orgId: string,
): Promise<{ provisioned: number; enabled: number }> {
  const { data: seedOrg, error: seedErr } = await rs()
    .from("organizations")
    .select("id")
    .eq("slug", SEED_ORG_SLUG)
    .maybeSingle();
  check("find seed org", seedErr);
  if (!seedOrg || seedOrg.id === orgId) return { provisioned: 0, enabled: 0 };

  const { data: seedFlags, error: flagsErr } = await rs()
    .from("feature_flags")
    .select("key, enabled, description, category")
    .eq("org_id", seedOrg.id);
  check("read seed feature flags", flagsErr);
  if (!seedFlags || seedFlags.length === 0)
    return { provisioned: 0, enabled: 0 };

  const rows = seedFlags.map((f) => ({
    org_id: orgId,
    key: f.key,
    enabled: flagsMode === "all" ? true : f.enabled,
    description: f.description,
    category: f.category,
  }));
  // Upsert rather than ignoreDuplicates: a re-run with --flags=all must be
  // able to switch a flag back on after someone toggled it off mid-demo.
  const { error } = await rs()
    .from("feature_flags")
    .upsert(rows, { onConflict: "org_id,key" });
  check("upsert feature flags", error);
  return {
    provisioned: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
  };
}

/**
 * Every tenant needs its own default mask formulary — without one the
 * fitting engine falls back to an implicit open formulary with a null id,
 * and every fit report cites provenance the operator cannot open.
 */
async function provisionFormulary(orgId: string): Promise<boolean> {
  const { data: existing, error: readErr } = await rs()
    .from("formularies")
    .select("id")
    .eq("org_id", orgId)
    .limit(1)
    .maybeSingle();
  check("read formularies", readErr);
  if (existing) return false;

  const { error } = await rs().from("formularies").insert({
    org_id: orgId,
    name: "Default formulary",
    status: "active",
    default_posture: "open",
    version: 1,
    notes:
      "Created by demo:seed. Open posture — every catalog mask is dispensable.",
  });
  check("insert formulary", error);
  return true;
}

/** Optional billing plan, mirroring tenant:onboard's posture. */
async function provisionBillingPlan(orgId: string): Promise<string> {
  if (!planCode) return "none (tenant has no subscription row)";

  const { data: plan, error: planErr } = await rs()
    .from("billing_plans")
    .select("id, name")
    .eq("code", planCode)
    .maybeSingle();
  check("read billing plan", planErr);
  if (!plan) return `FAILED — no billing plan with code '${planCode}'`;

  const { data: existing, error: existErr } = await rs()
    .from("tenant_billing_subscriptions")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ["active", "trialing", "past_due"])
    .limit(1)
    .maybeSingle();
  check("read tenant subscription", existErr);
  if (existing) return `existing subscription left unchanged`;

  const { error } = await rs().from("tenant_billing_subscriptions").insert({
    org_id: orgId,
    plan_id: plan.id,
    status: "active",
    notes: "Seeded by demo:seed",
    updated_by_email: "demo:seed",
  });
  check("insert tenant subscription", error);
  return `${plan.name} (assigned)`;
}

// ── Row building ─────────────────────────────────────────────────────
//
// Every row this script writes is produced HERE, once, as plain data.
// Two sinks consume the result: `applyWrites()` upserts through the
// Supabase service-role client, and `sqlForWrites()` renders the same
// rows as INSERT … ON CONFLICT DO UPDATE statements for `--emit-sql`.
//
// Keeping a single builder is the whole point. An operator who reviews
// the emitted SQL, or applies it through the Supabase SQL editor because
// they don't have the service-role key to hand, must get byte-identical
// data to whoever runs the script directly — two hand-maintained write
// paths would drift the first time a column was added.

interface TableWrite {
  schema: "resupply" | "resupply_auth";
  table: string;
  /** Column(s) forming the conflict target for the upsert. */
  conflict: string;
  /**
   * Columns that must survive a conflict untouched. Needed whenever the
   * conflict target is a UNIQUE column rather than the primary key:
   * `resupply_auth.users` is keyed by id but matched on email_lower, and
   * rewriting the id of an account that already exists would orphan every
   * row pointing at it (password_credentials.user_id,
   * admin_users.auth_user_id, shop_customers.auth_user_id).
   */
  neverUpdate?: string[];
  rows: Array<Record<string, unknown>>;
}

// The demo login's auth id. Fixed so a re-run is idempotent, and shaped
// like the other demo ids so it is recognizable in the users table.
// `resupply_auth.users.id` is a text column, so a literal is fine.
const DEMO_AUTH_USER_ID = `${DEMO_UUID_PREFIX}-000f-4000-8000-000000000001`;

function buildProviderRows(): TableWrite {
  return {
    schema: "resupply",
    table: "providers",
    conflict: "id",
    rows: PROVIDERS.map((p) => ({
      id: id("provider", p.n),
      npi: p.npi,
      legal_name: p.legalName,
      practice_name: p.practiceName,
      taxonomy_code: p.taxonomyCode,
      phone_e164: p.phone,
      fax_e164: p.fax,
      email: p.email,
      practice_address: {
        line1: p.line1,
        city: p.city,
        state: p.state,
        postal_code: p.postal,
        country: "US",
      },
      source: "csr_entry",
      verified_at: daysAgo(30),
      notes: "Demo directory entry seeded by demo:seed. Not a real provider.",
      updated_at: nowIso,
    })),
  };
}

function buildPatientWrites(orgId: string): TableWrite[] {
  const authorEmail = normalizeEmail(demoEmail);
  return [
    {
      schema: "resupply",
      table: "patients",
      conflict: "id",
      rows: PATIENTS.map((p) => ({
        id: id("patient", p.n),
        org_id: orgId,
        legal_first_name: p.first,
        legal_last_name: p.last,
        date_of_birth: p.dob,
        phone_e164: p.phone,
        email: p.email,
        address: {
          line1: p.line1,
          city: p.city,
          state: p.state,
          postal_code: p.postal,
          country: "US",
        },
        status: "active",
        insurance_payer: p.payer,
        channel_preference: p.channelPreference,
        timezone: p.timezone,
        statement_delivery_method:
          p.channelPreference === "email" ? "email" : "mail",
        phone_line_type:
          p.channelPreference === "voice" ? "landline" : "mobile",
        phone_line_type_source: "manual",
        pacware_id: `DEMO-${String(p.n).padStart(5, "0")}`,
        created_at: daysAgo(400 - p.n * 7),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "prescriptions",
      conflict: "id",
      // `created_at` is deliberately recent and paired with a recent
      // fulfillment below: reminder eligibility is measured from
      // (lastFulfilled ?? rxCreated), so backdating this a year without a
      // recent shipment would make the patient instantly due and the next
      // worker tick would try to message them.
      rows: PATIENTS.map((p) => ({
        id: id("rx", p.n),
        org_id: orgId,
        patient_id: id("patient", p.n),
        provider_id: id("provider", p.providerN),
        item_sku: p.itemSku,
        hcpcs_code: p.hcpcs,
        cadence_days: p.cadenceDays,
        valid_from: dateAgo(365),
        valid_until: dateFromNow(365),
        status: "active",
        details: {
          diagnosis: "G47.33 Obstructive sleep apnea",
          prescriber: PROVIDERS.find((x) => x.n === p.providerN)!.legalName,
          note: "Demo prescription seeded by demo:seed.",
        },
        created_at: daysAgo(p.lastFulfilledDaysAgo + 5),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "episodes",
      conflict: "id",
      rows: PATIENTS.map((p) => ({
        id: id("episode", p.n),
        org_id: orgId,
        patient_id: id("patient", p.n),
        prescription_id: id("rx", p.n),
        status: p.episodeStatus,
        due_at: daysFromNow(p.episodeDueInDays),
        metadata: { seeded_by: "demo:seed" },
        created_at: daysAgo(p.lastFulfilledDaysAgo),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "fulfillments",
      conflict: "id",
      rows: PATIENTS.map((p) => ({
        id: id("fulfillment", p.n),
        org_id: orgId,
        patient_id: id("patient", p.n),
        episode_id: id("episode", p.n),
        item_sku: p.itemSku,
        quantity: 1,
        status: "delivered",
        pacware_order_ref: `DEMO-ORD-${String(1000 + p.n)}`,
        shipment_metadata: {
          carrier: "UPS",
          tracking: `DEMO1Z99944${String(p.n).padStart(2, "0")}`,
        },
        submitted_at: daysAgo(p.lastFulfilledDaysAgo + 2),
        shipped_at: daysAgo(p.lastFulfilledDaysAgo + 1),
        delivered_at: daysAgo(p.lastFulfilledDaysAgo),
        created_at: daysAgo(p.lastFulfilledDaysAgo + 2),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "insurance_coverages",
      conflict: "id",
      rows: PATIENTS.map((p) => ({
        id: id("coverage", p.n),
        org_id: orgId,
        patient_id: id("patient", p.n),
        rank: "primary",
        payer_name: p.payer,
        plan_name: p.planName,
        member_id: p.memberId,
        group_number: p.groupNumber,
        policyholder_name: `${p.first} ${p.last}`,
        policyholder_relationship: "self",
        effective_date: dateAgo(400),
        in_network: true,
        deductible_cents: p.deductibleCents,
        deductible_met_cents: p.deductibleMetCents,
        oop_max_cents: p.deductibleCents * 3,
        copay_cents: p.copayCents,
        capped_rental_status: "not_applicable",
        verified_at: daysAgo(20),
        notes: "Demo coverage seeded by demo:seed.",
        created_at: daysAgo(390),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "equipment_assets",
      conflict: "id",
      rows: PATIENTS.map((p) => ({
        id: id("equipment", p.n),
        org_id: orgId,
        patient_id: id("patient", p.n),
        prescription_id: id("rx", p.n),
        device_class: p.device.deviceClass,
        manufacturer: p.device.manufacturer,
        model: p.device.model,
        serial_number: p.device.serial,
        pressure_setting: p.device.pressure,
        humidifier_setting: p.device.humidifier,
        status: "active",
        dispensed_at: dateAgo(360),
        dispensing_note: "Demo device seeded by demo:seed.",
        created_at: daysAgo(360),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "patient_notes",
      conflict: "id",
      rows: PATIENTS.filter((p) => p.note).map((p) => ({
        id: id("note", p.n),
        org_id: orgId,
        patient_id: id("patient", p.n),
        author_email: authorEmail,
        body: p.note!,
        created_at: daysAgo(p.lastFulfilledDaysAgo),
      })),
    },
  ];
}

function buildThreadWrites(orgId: string): TableWrite[] {
  return [
    {
      schema: "resupply",
      table: "conversations",
      conflict: "id",
      // `conversations_subject_xor_check` requires a patient thread to
      // carry BOTH patient_id and episode_id and NO customer_id.
      rows: THREADS.map((t) => ({
        id: id("conversation", t.n),
        org_id: orgId,
        patient_id: id("patient", t.patientN),
        episode_id: id("episode", t.patientN),
        customer_id: null,
        channel: t.channel,
        status: t.status,
        priority: t.priority,
        required_skills: [],
        tags: ["demo"],
        last_message_at: daysAgo(t.lastMessageDaysAgo),
        created_at: daysAgo(Math.max(...t.messages.map((m) => m.daysAgo))),
        updated_at: nowIso,
      })),
    },
    {
      schema: "resupply",
      table: "messages",
      conflict: "id",
      rows: THREADS.flatMap((t) =>
        t.messages.map((m) => ({
          // Pack the thread number into the id so thread 2's message 1
          // cannot collide with thread 1's message 1.
          id: id("message", t.n * 100 + m.n),
          org_id: orgId,
          conversation_id: id("conversation", t.n),
          direction: m.direction,
          sender_role: m.senderRole,
          body: m.body,
          delivery_status: m.direction === "outbound" ? "delivered" : null,
          vendor_metadata: {},
          sent_at: daysAgo(m.daysAgo),
          delivered_at: m.direction === "outbound" ? daysAgo(m.daysAgo) : null,
          created_at: daysAgo(m.daysAgo),
        })),
      ),
    },
  ];
}

/**
 * The three rows that have to agree before `requireAdmin` lets the demo
 * account into the console:
 *
 *   * `resupply_auth.users`   — coarse role 'admin', status 'active', and
 *                               a non-null `email_verified_at` (sign-in
 *                               refuses unverified accounts, and nobody is
 *                               going to click a verification link for a
 *                               shared demo login).
 *   * `password_credentials`  — `must_change` false and `set_by_admin_at`
 *                               NULL, exactly what `writeUserChosenPassword`
 *                               produces. The operator-typed alternative
 *                               (`writeAdminSetPassword`) stamps that
 *                               column, which would both force a reset on
 *                               first sign-in and expire the credential
 *                               after 7 unused days — fatal for an account
 *                               that sits idle between demos.
 *   * `resupply.admin_users`  — role 'admin' (→ effective super_admin via
 *                               toEffectiveRole) carrying the org_id that
 *                               scopes the whole console.
 */
function buildAuthWrites(
  orgId: string,
  userId: string,
  passwordHash: string,
): TableWrite[] {
  const emailLower = normalizeEmail(demoEmail);
  const displayName = "Demo Administrator";
  return [
    {
      schema: "resupply_auth",
      table: "users",
      conflict: "email_lower",
      neverUpdate: ["id"],
      rows: [
        {
          id: userId,
          email_lower: emailLower,
          display_name: displayName,
          role: "admin",
          status: "active",
          email_verified_at: nowIso,
          updated_at: nowIso,
        },
      ],
    },
    {
      schema: "resupply_auth",
      table: "password_credentials",
      conflict: "user_id",
      rows: [
        {
          user_id: userId,
          password_hash: passwordHash,
          algo: "argon2id-v1",
          must_change: false,
          set_by_admin_at: null,
          updated_at: nowIso,
        },
      ],
    },
    {
      schema: "resupply",
      table: "admin_users",
      conflict: "email_lower",
      rows: [
        {
          email_lower: emailLower,
          role: "admin",
          status: "active",
          auth_user_id: userId,
          org_id: orgId,
          display_name: displayName,
          revoked_at: null,
          revoked_by: null,
          accepted_at: nowIso,
          updated_at: nowIso,
        },
      ],
    },
  ];
}

// ── Sinks ────────────────────────────────────────────────────────────

/**
 * Sink 1: upsert through the Supabase service-role client.
 *
 * PostgREST cannot express a partial DO UPDATE set, so `neverUpdate` is
 * not enforceable here the way it is in the SQL sink. It does not need to
 * be: the only column it protects is `resupply_auth.users.id`, and the
 * live path resolves that id from the existing account before building
 * the row, so the value sent is always the one already stored.
 */
async function applyWrites(writes: TableWrite[]): Promise<void> {
  for (const w of writes) {
    if (w.rows.length === 0) continue;
    const { error } = await db()
      .schema(w.schema)
      .from(w.table)
      .upsert(w.rows, { onConflict: w.conflict });
    check(`upsert ${w.schema}.${w.table}`, error);
    out(`  ${w.schema}.${w.table}: ${w.rows.length}`);
  }
}

/** Render a JS value as a Postgres literal. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Postgres doubles a single quote to escape it. Everything here is
  // repo-authored constant data, but quoting correctly is not optional —
  // "O'Sullivan" is in the dataset.
  const escaped = text.replace(/'/g, "''");
  return typeof v === "object" ? `'${escaped}'::jsonb` : `'${escaped}'`;
}

/**
 * Sink 2: the same rows as SQL. Emitted for `--emit-sql` so an operator
 * can review exactly what will land, or apply it through the Supabase SQL
 * editor when the service-role key isn't to hand.
 */
function sqlForWrites(writes: TableWrite[]): string {
  const chunks: string[] = [];
  for (const w of writes) {
    if (w.rows.length === 0) continue;
    const cols = Object.keys(w.rows[0]!);
    const conflictCols = w.conflict.split(",").map((c) => c.trim());
    const frozen = new Set([...conflictCols, ...(w.neverUpdate ?? [])]);
    const updates = cols
      .filter((c) => !frozen.has(c))
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(",\n    ");
    const values = w.rows
      .map((r) => `  (${cols.map((c) => sqlLiteral(r[c])).join(", ")})`)
      .join(",\n");
    chunks.push(
      `INSERT INTO "${w.schema}"."${w.table}" (${cols
        .map((c) => `"${c}"`)
        .join(", ")})\nVALUES\n${values}\nON CONFLICT (${conflictCols
        .map((c) => `"${c}"`)
        .join(", ")}) DO UPDATE SET\n    ${updates};`,
    );
  }
  return chunks.join("\n\n");
}

// ── Clean ────────────────────────────────────────────────────────────

/**
 * Remove every row this script created. Deletion runs children-first:
 * several of these relationships are ON DELETE CASCADE, but relying on
 * that would make the outcome depend on which migration a given database
 * has reached.
 *
 * Nothing without the `0dec0de0` id prefix is ever touched, so a clean
 * pointed at the wrong org still cannot take real rows with it.
 */
async function runClean(): Promise<void> {
  out(`cleaning demo tenant '${orgSlug}'…`);

  const { data: org, error: orgErr } = await rs()
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  check("find organization", orgErr);
  if (!org) {
    out(`no organization with slug '${orgSlug}' — nothing to clean.`);
    return;
  }
  const orgId = org.id;

  const steps: Array<[string, string[]]> = [
    [
      "messages",
      THREADS.flatMap((t) =>
        t.messages.map((m) => id("message", t.n * 100 + m.n)),
      ),
    ],
    ["conversations", THREADS.map((t) => id("conversation", t.n))],
    ["patient_notes", PATIENTS.map((p) => id("note", p.n))],
    ["equipment_assets", PATIENTS.map((p) => id("equipment", p.n))],
    ["insurance_coverages", PATIENTS.map((p) => id("coverage", p.n))],
    ["fulfillments", PATIENTS.map((p) => id("fulfillment", p.n))],
    ["episodes", PATIENTS.map((p) => id("episode", p.n))],
    ["prescriptions", PATIENTS.map((p) => id("rx", p.n))],
    ["patients", PATIENTS.map((p) => id("patient", p.n))],
  ];
  for (const [table, ids] of steps) {
    if (ids.length === 0) continue;
    const { error } = await rs().from(table).delete().in("id", ids);
    check(`delete ${table}`, error);
    out(`  removed ${ids.length} ${table}`);
  }

  // providers is the GLOBAL directory (no org_id, migration 0342), so it
  // is keyed by the exact demo NPIs rather than by tenant.
  const { error: provErr } = await rs()
    .from("providers")
    .delete()
    .in(
      "npi",
      PROVIDERS.map((p) => p.npi),
    );
  check("delete providers", provErr);
  out(`  removed ${PROVIDERS.length} providers`);

  for (const table of [
    "feature_flags",
    "formularies",
    "tenant_billing_subscriptions",
  ]) {
    const { error } = await rs().from(table).delete().eq("org_id", orgId);
    check(`delete ${table}`, error);
  }
  out("  removed feature_flags / formularies / billing subscription");

  // The admin_users link, then the org. The auth user is left in place:
  // deleting identity rows is out of scope for a seeder, and a login with
  // no admin_users row cannot reach the console.
  const emailLower = normalizeEmail(demoEmail);
  const { error: auErr } = await rs()
    .from("admin_users")
    .delete()
    .eq("email_lower", emailLower)
    .eq("org_id", orgId);
  check("delete admin_users", auErr);

  const { error: orgDelErr } = await rs()
    .from("organizations")
    .delete()
    .eq("id", orgId);
  check("delete organization", orgDelErr);
  out(`  removed organization '${orgSlug}'`);
  out(
    `auth user ${emailLower} left in place — without an admin_users row it ` +
      "can no longer reach the console.",
  );
}

// ── Main ─────────────────────────────────────────────────────────────

function summary(orgId: string): string {
  return (
    `\n${TAG} Demo tenant ready.\n` +
    `  Sign in at   /admin/sign-in\n` +
    `  Email        ${normalizeEmail(demoEmail)}\n` +
    `  Password     ${demoPassword}\n` +
    `  Tenant       ${orgName} (slug '${orgSlug}', org_id=${orgId})\n\n` +
    `  Every number is +1 (215) 555-01XX and every address is on\n` +
    `  example.com, so nothing seeded here can reach a real person.\n` +
    `  Re-run any time to reset; '--clean' removes the tenant entirely.\n`
  );
}

async function main(): Promise<void> {
  if (clean) {
    if (dryRun) {
      out("--dry-run --clean: would remove the demo tenant and all its rows.");
      return;
    }
    await runClean();
    out("clean complete.");
    return;
  }

  const messageCount = THREADS.reduce((n, t) => n + t.messages.length, 0);

  if (dryRun) {
    out("--dry-run: the following would be written (no DB writes):");
    out(`  organization      '${orgSlug}' (${orgName})`);
    out(`  login             ${demoEmail} / ${demoPassword} (role=admin)`);
    out(`  feature flags     posture=${flagsMode}`);
    out(`  providers         ${PROVIDERS.length}`);
    out(`  patients          ${PATIENTS.length} (+ rx, episode, fulfillment,`);
    out(`                    coverage, device and note for each)`);
    out(`  conversations     ${THREADS.length} (${messageCount} messages)`);
    return;
  }

  // --emit-sql needs no database connection at all: it renders the same
  // rows the live path would upsert. The org id is a placeholder the
  // operator substitutes, unless one is supplied with --org-id=.
  if (emitSql) {
    const orgId = opt("org-id", ":ORG_ID");
    const passwordHash = await hashPassword(demoPassword);
    const writes = [
      ...buildAuthWrites(orgId, DEMO_AUTH_USER_ID, passwordHash),
      buildProviderRows(),
      ...buildPatientWrites(orgId),
      ...buildThreadWrites(orgId),
    ];
    process.stdout.write(
      `-- demo:seed — generated ${nowIso}\n` +
        `-- Tenant '${orgSlug}'. Substitute ${orgId} if it is still a placeholder.\n` +
        `-- The password hash below is argon2id over the configured password.\n\n` +
        sqlForWrites(writes) +
        "\n",
    );
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const { orgId, action: orgAction } = await ensureOrg();
  out(`organization '${orgSlug}' ${orgAction} — org_id=${orgId}`);

  const flags = await provisionFeatureFlags(orgId);
  out(
    flags.provisioned === 0
      ? "feature flags: none provisioned (no seed tenant to copy from)"
      : `feature flags: ${flags.provisioned} rows, ${flags.enabled} enabled`,
  );

  out(
    `formulary: ${(await provisionFormulary(orgId)) ? "created" : "present"}`,
  );
  out(`billing plan: ${await provisionBillingPlan(orgId)}`);

  // Reuse the existing auth id when the login already exists — the fixed
  // DEMO_AUTH_USER_ID is only for a first run. Upserting on email_lower
  // with a different id would collide with the UNIQUE constraint.
  const repo = supabaseAuthRepository(db());
  const existing = await repo.findUserByEmail(normalizeEmail(demoEmail));
  const userId = existing?.id ?? DEMO_AUTH_USER_ID;

  const { data: existingAdmin, error: adminErr } = await rs()
    .from("admin_users")
    .select("org_id")
    .eq("email_lower", normalizeEmail(demoEmail))
    .maybeSingle();
  check("find admin_users", adminErr);
  if (existingAdmin?.org_id && existingAdmin.org_id !== orgId && !force) {
    fail(
      `${normalizeEmail(demoEmail)} already belongs to a different ` +
        `organization (org_id=${existingAdmin.org_id}). Re-run with --force ` +
        `to move it to '${orgSlug}'.`,
    );
  }

  const passwordHash = await hashPassword(demoPassword);
  out("writing rows…");
  await applyWrites([
    ...buildAuthWrites(orgId, userId, passwordHash),
    buildProviderRows(),
    ...buildPatientWrites(orgId),
    ...buildThreadWrites(orgId),
  ]);

  process.stdout.write(summary(orgId));
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
