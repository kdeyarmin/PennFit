// seed-sample-data — populate a NON-PRODUCTION database with clearly
// marked sample data so the team can exercise the storefront/account
// chatbot, the admin console (customers, orders, subscriptions, the CSR
// inbox), and the patients list end to end.
//
// Run with:
//   ALLOW_SAMPLE_SEED=1 \
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @workspace/scripts seed:sample
//
// Flags:
//   --dry-run        Print what would be written; touch nothing.
//   --clean          Remove previously-seeded sample rows, then exit.
//   --no-logins      Skip creating sign-in-able auth users (data only).
//   --password=...   Password for the sample customer logins
//                    (default: SampleTest123!).
//   --force          Bypass the production guard (use with care).
//
// What it creates (every value is fictional and marked "(test)" /
// "@example.com" so it can never be mistaken for real PHI):
//   * 3 shop customers — Alex (3 orders + active sub + a CSR thread),
//     Jordan (1 delivered order + a paused sub), Casey (brand-new,
//     nothing on file). Each gets a saved CPAP device where it makes
//     sense, so get_my_device / get_my_recent_orders / etc. return data.
//   * Matching shop_orders + shop_order_items + shop_subscriptions.
//   * One in-app conversation with a CSR reply (so the account
//     assistant's escalate_to_human lands somewhere visible and the
//     /account → Messages thread isn't empty).
//   * 2 sample patients for the admin patients list.
//   By default each customer also gets a real auth login (role
//   "customer", status active, email verified) so you can actually sign
//   in as them and chat with the account assistant.
//
// Idempotent: every row uses a fixed id / natural key and is upserted,
// so re-running updates in place rather than duplicating. `--clean`
// removes the data rows (auth users are left in place — harmless, and
// deleting auth rows is out of scope for a seeder).
//
// Production guard: refuses to run unless ALLOW_SAMPLE_SEED=1 (or
// --force) is set, so it can never silently scribble fake data into a
// real environment.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  hashPassword,
  normalizeEmail,
  supabaseAuthRepository,
  writeUserChosenPassword,
} from "@workspace/resupply-auth";

const TAG = "[seed:sample]";
function out(msg: string): void {
  process.stdout.write(`${TAG} ${msg}\n`);
}
function fail(msg: string): never {
  process.stderr.write(`${TAG} ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const clean = args.includes("--clean");
const withLogins = !args.includes("--no-logins");
const force = args.includes("--force");
const password =
  args.find((a) => a.startsWith("--password="))?.slice("--password=".length) ||
  "SampleTest123!";

// Production guard. Seeding fake data is never something we want to
// happen by accident against a real environment, so require an explicit
// opt-in. --dry-run is always allowed (it writes nothing).
if (!dryRun && !force && process.env.ALLOW_SAMPLE_SEED !== "1") {
  fail(
    "refusing to write sample data without ALLOW_SAMPLE_SEED=1 (or --force). " +
      "Re-run with ALLOW_SAMPLE_SEED=1 once you've confirmed this is a " +
      "dev/preview database. (--dry-run needs no opt-in.)",
  );
}

const nowIso = new Date().toISOString();
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

// ── Sample dataset (fixed ids → idempotent upserts) ─────────────────

interface SampleCustomer {
  customerId: string;
  // Set only after a login is successfully created (ensureLogin). Stays
  // null otherwise — shop_customers.auth_user_id is an FK to
  // resupply_auth.users(id), so a placeholder/dangling id would fail the
  // FK and abort the seed.
  authUserId: string | null;
  email: string;
  displayName: string;
  phoneE164: string;
  device: {
    manufacturer: string;
    model: string;
    pressureSetting: string;
  } | null;
  shipping: {
    name: string;
    line1: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
}

const CUSTOMERS: SampleCustomer[] = [
  {
    customerId: "sample-cust-alex",
    authUserId: null,
    email: "sample.alex@example.com",
    displayName: "Alex Sample (test)",
    phoneE164: "+18145550101",
    device: {
      manufacturer: "ResMed",
      model: "AirSense 11",
      pressureSetting: "9 cmH2O",
    },
    shipping: {
      name: "Alex Sample",
      line1: "100 Test Street",
      city: "Altoona",
      state: "PA",
      postal_code: "16601",
      country: "US",
    },
  },
  {
    customerId: "sample-cust-jordan",
    authUserId: null,
    email: "sample.jordan@example.com",
    displayName: "Jordan Sample (test)",
    phoneE164: "+18145550102",
    device: {
      manufacturer: "Philips",
      model: "DreamStation 2",
      pressureSetting: "11 cmH2O",
    },
    shipping: {
      name: "Jordan Sample",
      line1: "200 Example Ave",
      city: "State College",
      state: "PA",
      postal_code: "16801",
      country: "US",
    },
  },
  {
    customerId: "sample-cust-casey",
    authUserId: null,
    email: "sample.casey@example.com",
    displayName: "Casey Sample (test)",
    phoneE164: "+18145550103",
    device: null,
    shipping: {
      name: "Casey Sample",
      line1: "300 Sample Blvd",
      city: "Hollidaysburg",
      state: "PA",
      postal_code: "16648",
      country: "US",
    },
  },
];

interface SampleOrder {
  id: string;
  customerId: string;
  sessionId: string;
  status: string;
  amountTotalCents: number;
  paidAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  items: Array<{
    productId: string;
    quantity: number;
    unitAmountCents: number;
  }>;
}

const ORDERS: SampleOrder[] = [
  {
    id: "5a3b1e00-0a00-4000-8000-000000000101",
    customerId: "sample-cust-alex",
    sessionId: "cs_test_sample_alex_1",
    status: "paid",
    amountTotalCents: 4295,
    paidAt: daysAgo(40),
    shippedAt: daysAgo(39),
    deliveredAt: daysAgo(37),
    trackingCarrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    items: [
      { productId: "airfit-p10-cushion", quantity: 1, unitAmountCents: 1995 },
      {
        productId: "disposable-filters-2pk",
        quantity: 1,
        unitAmountCents: 2300,
      },
    ],
  },
  {
    id: "5a3b1e00-0a00-4000-8000-000000000102",
    customerId: "sample-cust-alex",
    sessionId: "cs_test_sample_alex_2",
    status: "paid",
    amountTotalCents: 3200,
    paidAt: daysAgo(8),
    shippedAt: daysAgo(7),
    deliveredAt: null,
    trackingCarrier: "USPS",
    trackingNumber: "9400111899223344556677",
    items: [
      { productId: "standard-tubing", quantity: 1, unitAmountCents: 3200 },
    ],
  },
  {
    id: "5a3b1e00-0a00-4000-8000-000000000103",
    customerId: "sample-cust-alex",
    sessionId: "cs_test_sample_alex_3",
    status: "paid",
    amountTotalCents: 1995,
    paidAt: daysAgo(1),
    shippedAt: null,
    deliveredAt: null,
    trackingCarrier: null,
    trackingNumber: null,
    items: [
      { productId: "airfit-p10-cushion", quantity: 1, unitAmountCents: 1995 },
    ],
  },
  {
    id: "5a3b1e00-0a00-4000-8000-000000000201",
    customerId: "sample-cust-jordan",
    sessionId: "cs_test_sample_jordan_1",
    status: "paid",
    amountTotalCents: 5400,
    paidAt: daysAgo(20),
    shippedAt: daysAgo(19),
    deliveredAt: daysAgo(16),
    trackingCarrier: "FedEx",
    trackingNumber: "770012345678",
    items: [
      { productId: "dreamwear-full-face", quantity: 1, unitAmountCents: 5400 },
    ],
  },
];

interface SampleSubscription {
  id: string;
  customerId: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  items: Array<{
    name: string;
    quantity: number;
    unitAmountCents: number;
    currency: string;
    intervalLabel: string;
  }>;
}

const SUBSCRIPTIONS: SampleSubscription[] = [
  {
    id: "5a3b1e00-0b00-4000-8000-000000000301",
    customerId: "sample-cust-alex",
    stripeSubscriptionId: "sub_sample_alex_1",
    status: "active",
    currentPeriodEnd: daysFromNow(50),
    cancelAtPeriodEnd: false,
    items: [
      {
        name: "AirFit P10 cushion",
        quantity: 1,
        unitAmountCents: 1995,
        currency: "usd",
        intervalLabel: "every 90 days",
      },
    ],
  },
  {
    id: "5a3b1e00-0b00-4000-8000-000000000302",
    customerId: "sample-cust-jordan",
    stripeSubscriptionId: "sub_sample_jordan_1",
    status: "paused",
    currentPeriodEnd: daysFromNow(12),
    cancelAtPeriodEnd: false,
    items: [
      {
        name: "DreamWear full-face cushion",
        quantity: 1,
        unitAmountCents: 2400,
        currency: "usd",
        intervalLabel: "every 90 days",
      },
    ],
  },
];

const CONVERSATION = {
  id: "5a3b1e00-0c00-4000-8000-000000000401",
  customerId: "sample-cust-alex",
  messages: [
    {
      id: "5a3b1e00-0d00-4000-8000-000000000501",
      direction: "inbound" as const,
      senderRole: "customer" as const,
      body: "Hi — my new cushion seems to leak around the bridge of my nose. Can you help?",
      createdAt: daysAgo(3),
    },
    {
      id: "5a3b1e00-0d00-4000-8000-000000000502",
      direction: "outbound" as const,
      senderRole: "admin" as const,
      body: "Happy to help! Let's try a smaller cushion size — I can send one under the comfort guarantee. Want me to ship it?",
      createdAt: daysAgo(2),
    },
  ],
};

interface SamplePatient {
  id: string;
  pacwareId: string;
  firstName: string;
  lastName: string;
  dob: string;
  phoneE164: string;
  email: string;
}

const PATIENTS: SamplePatient[] = [
  {
    id: "5a3b1e00-0e00-4000-8000-000000000601",
    pacwareId: "SAMPLE-PT-001",
    firstName: "Pat",
    lastName: "Testpatient",
    dob: "1955-04-12",
    phoneE164: "+18145550201",
    email: "sample.pat@example.com",
  },
  {
    id: "5a3b1e00-0e00-4000-8000-000000000602",
    pacwareId: "SAMPLE-PT-002",
    firstName: "Sam",
    lastName: "Exampleton",
    dob: "1968-09-30",
    phoneE164: "+18145550202",
    email: "sample.sam@example.com",
  },
];

// Lazily constructed so `--dry-run` works without SUPABASE_* env set
// (getSupabaseServiceRoleClient validates env eagerly). Only the clean
// and real-seed paths build the client.
let _supabase: ReturnType<typeof getSupabaseServiceRoleClient> | null = null;
function db(): ReturnType<typeof getSupabaseServiceRoleClient> {
  if (!_supabase) _supabase = getSupabaseServiceRoleClient();
  return _supabase;
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

// ── Clean ────────────────────────────────────────────────────────────

async function runClean(): Promise<void> {
  out("cleaning previously-seeded sample rows…");
  const messageIds = CONVERSATION.messages.map((m) => m.id);
  const orderIds = ORDERS.map((o) => o.id);
  const customerIds = CUSTOMERS.map((c) => c.customerId);
  const subIds = SUBSCRIPTIONS.map((s) => s.id);
  const patientIds = PATIENTS.map((p) => p.id);

  // Children first to respect FKs.
  check(
    "delete messages",
    (
      await db()
        .schema("resupply")
        .from("messages")
        .delete()
        .in("id", messageIds)
    ).error,
  );
  check(
    "delete conversations",
    (
      await db()
        .schema("resupply")
        .from("conversations")
        .delete()
        .eq("id", CONVERSATION.id)
    ).error,
  );
  check(
    "delete shop_order_items",
    (
      await db()
        .schema("resupply")
        .from("shop_order_items")
        .delete()
        .in("order_id", orderIds)
    ).error,
  );
  check(
    "delete shop_orders",
    (
      await db()
        .schema("resupply")
        .from("shop_orders")
        .delete()
        .in("id", orderIds)
    ).error,
  );
  check(
    "delete shop_subscriptions",
    (
      await db()
        .schema("resupply")
        .from("shop_subscriptions")
        .delete()
        .in("id", subIds)
    ).error,
  );
  check(
    "delete shop_customers",
    (
      await db()
        .schema("resupply")
        .from("shop_customers")
        .delete()
        .in("customer_id", customerIds)
    ).error,
  );
  check(
    "delete patients",
    (
      await db()
        .schema("resupply")
        .from("patients")
        .delete()
        .in("id", patientIds)
    ).error,
  );
  out(
    "clean complete. (Sample auth-user logins are left in place — delete them " +
      "from the admin team tools if you need to.)",
  );
}

// ── Seed ─────────────────────────────────────────────────────────────

async function ensureLogin(c: SampleCustomer): Promise<void> {
  const repo = supabaseAuthRepository(db());
  const emailLower = normalizeEmail(c.email);
  let userId: string;
  const existing = await repo.findUserByEmail(emailLower);
  if (existing) {
    userId = existing.id;
    if (existing.status !== "active") {
      await repo.updateUserStatus(userId, "active");
    }
  } else {
    const inserted = await repo.insertUser({
      emailLower,
      displayName: c.displayName,
      role: "customer",
      status: "active",
    });
    userId = inserted.id;
  }
  await repo.markEmailVerified(userId, new Date());
  const passwordHash = await hashPassword(password);
  // Seed it as a user-chosen password (mustChange=false, no
  // set_by_admin_at) so the sample login works immediately without a
  // forced reset on first sign-in. Routed through the shared helper per
  // the no-direct-upsertCredential lint rule.
  await writeUserChosenPassword(repo, { userId, passwordHash });
  // Bind the login to the shop customer so the customerIdResolver maps
  // this auth user → our stable customer_id at sign-in time.
  c.authUserId = userId;
}

async function runSeed(): Promise<void> {
  if (dryRun) {
    out("--dry-run: the following would be written (no DB writes):");
    out(
      `  ${CUSTOMERS.length} shop customers (logins: ${withLogins ? "yes" : "no"})`,
    );
    out(`  ${ORDERS.length} orders + items`);
    out(`  ${SUBSCRIPTIONS.length} subscriptions`);
    out(
      `  1 in-app conversation with ${CONVERSATION.messages.length} messages`,
    );
    out(`  ${PATIENTS.length} patients`);
    return;
  }

  // Logins first so we can bind auth_user_id onto the shop_customers row.
  if (withLogins) {
    for (const c of CUSTOMERS) {
      try {
        await ensureLogin(c);
      } catch (err) {
        // Login failed — make sure we don't leave a dangling auth_user_id
        // on the shop_customers upsert (it's an FK). Fall back to a
        // data-only customer (no sign-in) rather than aborting the seed.
        c.authUserId = null;
        process.stderr.write(
          `${TAG} WARN: could not create login for ${c.email}: ${
            err instanceof Error ? err.message : String(err)
          } (continuing with data-only for this customer)\n`,
        );
      }
    }
  }

  // shop_customers
  for (const c of CUSTOMERS) {
    const { error } = await db()
      .schema("resupply")
      .from("shop_customers")
      .upsert({
        customer_id: c.customerId,
        display_name: c.displayName,
        email_lower: normalizeEmail(c.email),
        phone_e164: c.phoneE164,
        shipping_address_json: c.shipping,
        cpap_device_json: c.device,
        // Non-null only when a login was successfully created above.
        auth_user_id: c.authUserId,
        created_at: daysAgo(120),
        updated_at: nowIso,
      });
    check(`upsert shop_customers ${c.customerId}`, error);
  }
  out(`✓ ${CUSTOMERS.length} shop customers`);

  // orders + items
  for (const o of ORDERS) {
    const { error: oErr } = await db()
      .schema("resupply")
      .from("shop_orders")
      .upsert({
        id: o.id,
        stripe_session_id: o.sessionId,
        status: o.status,
        amount_total_cents: o.amountTotalCents,
        amount_refunded_cents: 0,
        currency: "usd",
        customer_id: o.customerId,
        customer_email: normalizeEmail(
          CUSTOMERS.find((c) => c.customerId === o.customerId)?.email ?? "",
        ),
        tracking_carrier: o.trackingCarrier,
        tracking_number: o.trackingNumber,
        shipped_at: o.shippedAt,
        delivered_at: o.deliveredAt,
        shipping_address_json:
          CUSTOMERS.find((c) => c.customerId === o.customerId)?.shipping ??
          null,
        paid_at: o.paidAt,
        created_at: o.paidAt,
        updated_at: nowIso,
      });
    check(`upsert shop_orders ${o.id}`, oErr);

    let i = 0;
    for (const item of o.items) {
      // Keep the id UUID-shaped (the column is a uuid): reuse the order
      // id and overwrite its last two hex chars with the item index.
      const itemId = `${o.id.slice(0, -2)}${(10 + i).toString(16).padStart(2, "0")}`;
      const { error: iErr } = await db()
        .schema("resupply")
        .from("shop_order_items")
        .upsert({
          id: itemId,
          order_id: o.id,
          stripe_session_id: o.sessionId,
          customer_id: o.customerId,
          product_id: item.productId,
          price_id: `price_sample_${item.productId}`,
          quantity: item.quantity,
          unit_amount_cents: item.unitAmountCents,
          currency: "usd",
          paid_at: o.paidAt,
          created_at: o.paidAt,
        });
      check(`upsert shop_order_items ${itemId}`, iErr);
      i += 1;
    }
  }
  out(`✓ ${ORDERS.length} orders + items`);

  // subscriptions
  for (const s of SUBSCRIPTIONS) {
    const { error } = await db()
      .schema("resupply")
      .from("shop_subscriptions")
      .upsert({
        id: s.id,
        customer_id: s.customerId,
        stripe_subscription_id: s.stripeSubscriptionId,
        status: s.status,
        items: s.items,
        current_period_end: s.currentPeriodEnd,
        cancel_at_period_end: s.cancelAtPeriodEnd,
        created_at: daysAgo(60),
        updated_at: nowIso,
      });
    check(`upsert shop_subscriptions ${s.id}`, error);
  }
  out(`✓ ${SUBSCRIPTIONS.length} subscriptions`);

  // in-app conversation + messages
  const lastMsg = CONVERSATION.messages.at(-1)!;
  const { error: convErr } = await db()
    .schema("resupply")
    .from("conversations")
    .upsert({
      id: CONVERSATION.id,
      customer_id: CONVERSATION.customerId,
      channel: "in_app",
      status: "awaiting_patient",
      last_message_at: lastMsg.createdAt,
      created_at: CONVERSATION.messages[0].createdAt,
      updated_at: nowIso,
    });
  check("upsert conversations", convErr);
  for (const m of CONVERSATION.messages) {
    const { error } = await db().schema("resupply").from("messages").upsert({
      id: m.id,
      conversation_id: CONVERSATION.id,
      direction: m.direction,
      sender_role: m.senderRole,
      body: m.body,
      sent_at: m.createdAt,
      created_at: m.createdAt,
    });
    check(`upsert messages ${m.id}`, error);
  }
  out(`✓ 1 in-app conversation with ${CONVERSATION.messages.length} messages`);

  // patients
  for (const p of PATIENTS) {
    const { error } = await db()
      .schema("resupply")
      .from("patients")
      .upsert({
        id: p.id,
        pacware_id: p.pacwareId,
        legal_first_name: p.firstName,
        legal_last_name: p.lastName,
        date_of_birth: p.dob,
        phone_e164: p.phoneE164,
        email: p.email,
        status: "active",
        timezone: "America/New_York",
        created_at: daysAgo(200),
        updated_at: nowIso,
      });
    check(`upsert patients ${p.id}`, error);
  }
  out(`✓ ${PATIENTS.length} patients`);
}

// ── Main ─────────────────────────────────────────────────────────────

if (clean) {
  await runClean();
  process.exit(0);
}

await runSeed();

if (!dryRun) {
  out("done. Sample data is in place.");
  if (withLogins) {
    out("");
    out("Sign in as a sample customer to test the account assistant:");
    for (const c of CUSTOMERS) {
      out(`  ${c.email}  /  ${password}`);
    }
    out("");
    out(
      "Admin console: see /admin/customers, /admin/conversations, and " +
        "/admin/patients for the seeded rows.",
    );
  }
  out("Re-run with --clean to remove the sample data.");
}
