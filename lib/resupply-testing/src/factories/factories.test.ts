import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import {
  auditLog,
  conversations,
  decrypt,
  decryptJson,
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
// Skipped automatically if either DATABASE_URL or RESUPPLY_DATA_KEY is
// missing — same skip pattern as encryption.test.ts so a clean checkout
// without DB credentials still passes `pnpm test`.
//
// What this test proves:
//   1. Each factory builds a payload that Drizzle accepts as an
//      `InsertXRow` for the matching table (compile-time + runtime).
//   2. PHI fields written by `makePatient`/`makeMessage`/etc. round-trip
//      cleanly through pgcrypto and come back equal under `decrypt()` /
//      `decryptJson()`. If a contributor adds a new PHI column to the
//      schema and forgets to wrap it in `encrypt(...)` inside the
//      factory, this test will fail at insert time (Drizzle's customType
//      throws on direct write).
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
const dataKey = process.env["RESUPPLY_DATA_KEY"];
const canRun = Boolean(dbUrl && dataKey);
const describeIfDb = canRun ? describe : describe.skip;

describeIfDb("resupply fixture factories — DB round-trip", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;
  const auditIdsToCleanup: string[] = [];
  const patientIdsToCleanup: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool);
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await pool.query("CREATE SCHEMA IF NOT EXISTS resupply");
  });

  afterAll(async () => {
    if (patientIdsToCleanup.length > 0) {
      for (const id of patientIdsToCleanup) {
        await db.delete(patients).where(eq(patients.id, id));
      }
    }
    if (auditIdsToCleanup.length > 0) {
      for (const id of auditIdsToCleanup) {
        await db.delete(auditLog).where(eq(auditLog.id, id));
      }
    }
    await pool.end();
  });

  it("inserts and decrypts the full patient -> message -> fulfillment tree", async () => {
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

    // 2. Prescription FK'd to the patient. `details` is PHI — pass an
    //    explicit object so we can decrypt + assert it round-trips.
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

    // 5. One outbound + one inbound message — outbound has the
    //    operator-attempted body, inbound is the patient's reply.
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

    // Round-trip the patient PHI back through pgcrypto.
    const decryptedPatient = await db
      .select({
        firstName: decrypt(patients.legalFirstName),
        lastName: decrypt(patients.legalLastName),
        dob: decrypt(patients.dateOfBirth),
        phone: decrypt(patients.phoneE164),
        email: decrypt(patients.email),
        address: decryptJson<{
          line1: string;
          city: string;
          state: string;
          postalCode: string;
          country: string;
        }>(patients.address),
      })
      .from(patients)
      .where(eq(patients.id, patientId));
    expect(decryptedPatient[0]?.firstName).toBe("Maya");
    expect(decryptedPatient[0]?.lastName).toBe("Chen");
    expect(decryptedPatient[0]?.dob).toBe("1958-11-02");
    expect(decryptedPatient[0]?.phone).toBe("+12155550181");
    expect(decryptedPatient[0]?.email).toBe("maya@example.com");
    expect(decryptedPatient[0]?.address?.city).toBe("Springfield");

    // Round-trip the encrypted prescription details (PHI per schema).
    const decryptedRx = await db
      .select({
        details: decryptJson<typeof rxDetails>(prescriptions.details),
      })
      .from(prescriptions)
      .where(eq(prescriptions.id, prescriptionId));
    expect(decryptedRx[0]?.details).toEqual(rxDetails);

    // Round-trip the encrypted message bodies.
    const decryptedMessages = await db
      .select({
        id: messages.id,
        direction: messages.direction,
        body: decrypt(messages.body),
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const byId = new Map(decryptedMessages.map((m) => [m.id, m]));
    expect(byId.get(insertedOutbound!.id)?.body).toBe(
      "Hi Maya, time to refill your CPAP supplies?",
    );
    expect(byId.get(insertedInbound!.id)?.body).toBe(
      "Yes please — same supplies as last time.",
    );
    expect(byId.get(insertedOutbound!.id)?.direction).toBe("outbound");
    expect(byId.get(insertedInbound!.id)?.direction).toBe("inbound");
  });

  it("inserts an audit-log row independently of any FK", async () => {
    const [inserted] = await db
      .insert(auditLog)
      .values(
        makeAuditLog({
          action: "patient.view",
          targetTable: "patients",
          targetId: null, // schema allows null; factory honours the override
          metadata: { requestId: "req-test", filters: {} },
        }),
      )
      .returning({ id: auditLog.id });
    expect(inserted).toBeDefined();
    auditIdsToCleanup.push(inserted!.id);

    const [row] = await db
      .select({
        action: auditLog.action,
        targetTable: auditLog.targetTable,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.id, inserted!.id));
    expect(row?.action).toBe("patient.view");
    expect(row?.targetTable).toBe("patients");
    expect(row?.targetId).toBeNull();
    expect(row?.metadata).toMatchObject({ requestId: "req-test" });
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

    const [decrypted] = await db
      .select({
        firstName: decrypt(patients.legalFirstName),
        email: decrypt(patients.email),
        phone: decrypt(patients.phoneE164),
        address: decryptJson<unknown>(patients.address),
      })
      .from(patients)
      .where(eq(patients.id, inserted!.id));
    expect(decrypted?.firstName).toBe("Null");
    expect(decrypted?.email).toBeNull();
    expect(decrypted?.phone).toBeNull();
    expect(decrypted?.address).toBeNull();
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

    const [decrypted] = await db
      .select({
        firstName: decrypt(patients.legalFirstName),
        dob: decrypt(patients.dateOfBirth),
      })
      .from(patients)
      .where(eq(patients.id, inserted!.id));
    expect(typeof decrypted?.firstName).toBe("string");
    expect(decrypted?.firstName?.length ?? 0).toBeGreaterThan(0);
    // YYYY-MM-DD shape sanity.
    expect(decrypted?.dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
