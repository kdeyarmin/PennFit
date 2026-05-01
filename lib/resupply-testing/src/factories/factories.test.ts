import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { faker } from "@faker-js/faker";
import pg from "pg";

import { logAudit } from "@workspace/resupply-audit";
import {
  __resetDbPoolForTests,
  conversations,
  episodes,
  fulfillments,
  messages,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import {
  makeAuditLog,
  makeConversation,
  makeEpisode,
  makeFulfillment,
  makeMessage,
  makePatient,
  makePrescription,
} from "./index";

const { Pool } = pg;

// Round-trip integration test for the resupply fixture factories.
//
// Skipped automatically if DATABASE_URL is missing, so a clean
// checkout without DB credentials still passes `pnpm test`.
//
// What this test proves:
//   1. Each factory builds a payload that Drizzle accepts as an
//      `InsertXRow` for the matching table (compile-time + runtime).
//   2. Patient/message/prescription columns round-trip cleanly. PHI
//      is stored as plaintext text/jsonb post-migration 0025; the
//      assertions are direct equality.
//   3. Foreign-key wiring works end-to-end: patient → prescription →
//      episode → conversation → message; patient + episode →
//      fulfillment.
//   4. The audit-log factory inserts cleanly (it has no FKs by design —
//      see the schema comment about outliving the rows it points to).
//
// The test cleans up after itself by deleting the patient row at the
// end; ON DELETE CASCADE walks the rest of the tree. Audit-log rows are
// deleted explicitly because the schema deliberately has no FK on them.

const dbUrl = process.env["DATABASE_URL"];
const canRun = Boolean(dbUrl);
const describeIfDb = canRun ? describe : describe.skip;

describeIfDb("resupply fixture factories — DB round-trip", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;
  // Tag every audit row this suite writes so cleanup is surgical and
  // we never DELETE a row some other parallel test (or a previous
  // crashed run) inserted. The tag is unique per process so two
  // concurrent CI runners against the same DB also don't collide.
  const auditCleanupTag = `factories-test-${faker.string.uuid()}`;
  const patientIdsToCleanup: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool);
    await pool.query("CREATE SCHEMA IF NOT EXISTS resupply");
  });

  afterAll(async () => {
    if (patientIdsToCleanup.length > 0) {
      for (const id of patientIdsToCleanup) {
        await db.delete(patients).where(eq(patients.id, id));
      }
    }
    // Surgical audit-log cleanup via the metadata tag rather than
    // tracked ids. logAudit() doesn't return an id (intentional —
    // most callers don't need one), so we tag the row at write time
    // and delete by tag here. SELECT/DELETE against audit_log are
    // explicitly allowed under architecture-check Rule 8; only
    // INSERT is restricted to the helper.
    await pool.query(
      "DELETE FROM resupply.audit_log WHERE metadata->>'_factoriesTag' = $1",
      [auditCleanupTag],
    );
    await pool.end();
    // logAudit() uses the shared singleton pool from
    // @workspace/resupply-db; end it too so vitest doesn't hang on
    // an open socket and so the next test file gets a fresh pool.
    const sharedPool = (await import("@workspace/resupply-db")).getDbPool();
    await sharedPool.end().catch(() => {
      // Best-effort teardown.
    });
    __resetDbPoolForTests();
  });

  it("inserts the full patient -> message -> fulfillment tree", async () => {
    // 1. Patient.
    const patientPayload = makePatient({
      legalFirstName: "Maya",
      legalLastName: "Chen",
      dateOfBirth: "1958-11-02",
      phoneE164: "+12155550181",
      email: "maya@example.com",
      address: {
        line1: "742 Evergreen Terrace",
        city: "Springfield",
        state: "OR",
        postalCode: "97477",
        country: "US",
      },
    });
    const [insertedPatient] = await db
      .insert(patients)
      .values(patientPayload)
      .returning({ id: patients.id });
    expect(insertedPatient).toBeDefined();
    const patientId = insertedPatient!.id;
    patientIdsToCleanup.push(patientId);

    // 2. Prescription FK'd to the patient.
    const rxDetails = {
      prescriberName: "Dr. Patel, MD",
      prescriberNpi: "1234567890",
      diagnosis: "G47.33",
      notes: "Round-trip fixture",
    };
    const [insertedRx] = await db
      .insert(prescriptions)
      .values(
        makePrescription({
          patientId,
          itemSku: "MASK-NASAL-MED",
          cadenceDays: 90,
          details: rxDetails,
        }),
      )
      .returning({ id: prescriptions.id });
    const prescriptionId = insertedRx!.id;

    // 3. Episode for that patient + prescription.
    const [insertedEpisode] = await db
      .insert(episodes)
      .values(
        makeEpisode({
          patientId,
          prescriptionId,
          status: "outreach_pending",
        }),
      )
      .returning({ id: episodes.id });
    const episodeId = insertedEpisode!.id;

    // 4. Conversation on that episode.
    const [insertedConvo] = await db
      .insert(conversations)
      .values(
        makeConversation({ patientId, episodeId, channel: "sms" }),
      )
      .returning({ id: conversations.id });
    const conversationId = insertedConvo!.id;

    // 5. One outbound + one inbound message.
    const [insertedOutbound] = await db
      .insert(messages)
      .values(
        makeMessage({
          conversationId,
          direction: "outbound",
          body: "Hi Maya, time to refill your CPAP supplies?",
        }),
      )
      .returning({ id: messages.id });
    const [insertedInbound] = await db
      .insert(messages)
      .values(
        makeMessage({
          conversationId,
          direction: "inbound",
          body: "Yes please — same supplies as last time.",
        }),
      )
      .returning({ id: messages.id });

    // 6. Fulfillment for the same patient + episode.
    const [insertedFulfillment] = await db
      .insert(fulfillments)
      .values(
        makeFulfillment({
          patientId,
          episodeId,
          itemSku: "MASK-NASAL-MED",
          quantity: "1",
          status: "queued",
        }),
      )
      .returning({ id: fulfillments.id });
    expect(insertedFulfillment).toBeDefined();

    // Read the patient row back; assert plaintext fields match.
    const fetchedPatient = await db
      .select({
        firstName: patients.legalFirstName,
        lastName: patients.legalLastName,
        dob: patients.dateOfBirth,
        phone: patients.phoneE164,
        email: patients.email,
        address: patients.address,
      })
      .from(patients)
      .where(eq(patients.id, patientId));
    expect(fetchedPatient[0]?.firstName).toBe("Maya");
    expect(fetchedPatient[0]?.lastName).toBe("Chen");
    expect(fetchedPatient[0]?.dob).toBe("1958-11-02");
    expect(fetchedPatient[0]?.phone).toBe("+12155550181");
    expect(fetchedPatient[0]?.email).toBe("maya@example.com");
    expect(fetchedPatient[0]?.address?.city).toBe("Springfield");

    // Read the prescription details back.
    const fetchedRx = await db
      .select({ details: prescriptions.details })
      .from(prescriptions)
      .where(eq(prescriptions.id, prescriptionId));
    expect(fetchedRx[0]?.details).toEqual(rxDetails);

    // Read the message bodies back.
    const fetchedMessages = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        body: messages.body,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const byId = new Map(fetchedMessages.map((m) => [m.id, m]));
    expect(byId.get(insertedOutbound!.id)?.body).toBe(
      "Hi Maya, time to refill your CPAP supplies?",
    );
    expect(byId.get(insertedInbound!.id)?.body).toBe(
      "Yes please — same supplies as last time.",
    );
    expect(byId.get(insertedOutbound!.id)?.direction).toBe("outbound");
    expect(byId.get(insertedInbound!.id)?.direction).toBe("inbound");
  });

  it("inserts an audit-log row via logAudit() independently of any FK", async () => {
    // Per architecture-check Rule 8, every audit_log INSERT — even
    // in tests — must flow through logAudit() so the metadata
    // sanitizer (PHI denylist + size + depth caps) cannot be
    // bypassed. The factory `makeAuditLog` returns the helper's
    // input shape (`AuditEvent`), which is what makes this idiom
    // ergonomic.
    const requestId = `req-test-${faker.string.uuid()}`;
    await logAudit(
      makeAuditLog({
        action: "patient.view",
        targetTable: "patients",
        targetId: null, // schema allows null; factory honours the override
        metadata: {
          _factoriesTag: auditCleanupTag,
          requestId,
          filters: {},
        },
      }),
    );

    const result = await pool.query(
      "SELECT action, target_table, target_id, metadata " +
        "FROM resupply.audit_log WHERE metadata->>'requestId' = $1",
      [requestId],
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.action).toBe("patient.view");
    expect(row.target_table).toBe("patients");
    expect(row.target_id).toBeNull();
    expect(row.metadata).toMatchObject({ requestId });
  });

  it("honours explicit null overrides on nullable PHI fields", async () => {
    // The undefined-vs-key-present pattern is a subtle factory contract:
    // omitting a key takes the faker default, but `email: null` writes
    // SQL NULL. If we ever regress that, "patients with no email" tests
    // start silently filling in a faker email.
    const payload = makePatient({
      legalFirstName: "Null",
      legalLastName: "Tester",
      email: null,
      phoneE164: null,
      address: null,
    });
    const [inserted] = await db
      .insert(patients)
      .values(payload)
      .returning({ id: patients.id });
    patientIdsToCleanup.push(inserted!.id);

    const [fetched] = await db
      .select({
        firstName: patients.legalFirstName,
        email: patients.email,
        phone: patients.phoneE164,
        address: patients.address,
      })
      .from(patients)
      .where(eq(patients.id, inserted!.id));
    expect(fetched?.firstName).toBe("Null");
    expect(fetched?.email).toBeNull();
    expect(fetched?.phone).toBeNull();
    expect(fetched?.address).toBeNull();
  });

  it("makePatient defaults produce inserts that round-trip", async () => {
    // No overrides — exercise every faker-default path.
    const payload = makePatient();
    const [inserted] = await db
      .insert(patients)
      .values(payload)
      .returning({ id: patients.id });
    expect(inserted).toBeDefined();
    patientIdsToCleanup.push(inserted!.id);

    const [fetched] = await db
      .select({
        firstName: patients.legalFirstName,
        dob: patients.dateOfBirth,
      })
      .from(patients)
      .where(eq(patients.id, inserted!.id));
    expect(typeof fetched?.firstName).toBe("string");
    expect(fetched?.firstName?.length ?? 0).toBeGreaterThan(0);
    // YYYY-MM-DD shape sanity.
    expect(fetched?.dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
