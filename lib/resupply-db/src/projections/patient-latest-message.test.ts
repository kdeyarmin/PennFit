import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { decrypt, encrypt, encryptJson } from "../encryption";
import { conversations } from "../schema/conversations";
import { episodes } from "../schema/episodes";
import { patientLatestMessage } from "../schema/patient-latest-message";
import { patients } from "../schema/patients";
import { prescriptions } from "../schema/prescriptions";
import {
  PREVIEW_MAX_CHARS,
  buildPreview,
  tryUpsertPatientLatestMessage,
  upsertPatientLatestMessage,
} from "./patient-latest-message";

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL;
const dataKey = process.env.RESUPPLY_DATA_KEY;
const canRun = Boolean(dbUrl && dataKey);
const describeIfDb = canRun ? describe : describe.skip;

describe("buildPreview", () => {
  it("returns short bodies as-is", () => {
    expect(buildPreview("Hello there")).toBe("Hello there");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(buildPreview("Hello\n\nthere   friend\t!")).toBe(
      "Hello there friend !",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(buildPreview("   spaced out   ")).toBe("spaced out");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(buildPreview("   \n  \t ")).toBe("");
  });

  it("truncates to exactly PREVIEW_MAX_CHARS chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = buildPreview(long);
    expect(out.length).toBe(PREVIEW_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, PREVIEW_MAX_CHARS - 1)).toBe(
      "x".repeat(PREVIEW_MAX_CHARS - 1),
    );
  });

  it("does not append an ellipsis when input is exactly the max", () => {
    const exact = "y".repeat(PREVIEW_MAX_CHARS);
    expect(buildPreview(exact)).toBe(exact);
  });
});

describeIfDb("upsertPatientLatestMessage (integration)", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;
  // Test fixtures created in beforeAll, cleaned in afterAll. Each
  // test reuses these — the projection table is upserted on
  // patientId so concurrent test runs against different patient ids
  // do not collide.
  let patientId: string;
  let prescriptionId: string;
  let episodeId: string;
  let conversationId: string;

  const seedPrefix = `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool);
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");

    const [patient] = await db
      .insert(patients)
      .values({
        pacwareId: `${seedPrefix}-pat`,
        legalFirstName: encrypt("Latest"),
        legalLastName: encrypt("Tester"),
        dateOfBirth: encrypt("1970-01-01"),
      })
      .returning({ id: patients.id });
    patientId = patient!.id;

    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId,
        itemSku: "test-mask",
        cadenceDays: 90,
        validFrom: "2020-01-01",
        details: encryptJson({ notes: "test" }),
      })
      .returning({ id: prescriptions.id });
    prescriptionId = rx!.id;

    const [ep] = await db
      .insert(episodes)
      .values({
        patientId,
        prescriptionId,
        status: "outreach_pending",
        dueAt: new Date(),
      })
      .returning({ id: episodes.id });
    episodeId = ep!.id;

    const [conv] = await db
      .insert(conversations)
      .values({
        patientId,
        episodeId,
        channel: "sms",
        status: "open",
      })
      .returning({ id: conversations.id });
    conversationId = conv!.id;
  });

  afterAll(async () => {
    // Cascading FKs on patient → prescriptions/episodes/conversations
    // and the explicit patient FK on patient_latest_message clean up
    // the projection row too.
    await db.delete(patients).where(eq(patients.id, patientId));
    await pool.end();
  });

  async function readProjection() {
    const rows = await db
      .select({
        patientId: patientLatestMessage.patientId,
        lastMessageAt: patientLatestMessage.lastMessageAt,
        lastMessageDirection: patientLatestMessage.lastMessageDirection,
        lastMessageConversationId:
          patientLatestMessage.lastMessageConversationId,
        preview: decrypt(patientLatestMessage.lastMessagePreview),
      })
      .from(patientLatestMessage)
      .where(eq(patientLatestMessage.patientId, patientId))
      .limit(1);
    return rows[0] ?? null;
  }

  it("inserts the projection row on first call", async () => {
    const at = new Date("2026-04-01T12:00:00Z");
    const wrote = await upsertPatientLatestMessage(db, {
      conversationId,
      body: "Hi from inbound",
      direction: "inbound",
      messageAt: at,
    });
    expect(wrote).toBe(true);

    const row = await readProjection();
    expect(row).not.toBeNull();
    expect(row!.lastMessageDirection).toBe("inbound");
    expect(row!.preview).toBe("Hi from inbound");
    expect(row!.lastMessageConversationId).toBe(conversationId);
    expect(row!.lastMessageAt?.toISOString()).toBe(at.toISOString());
  });

  it("updates when the incoming message is newer", async () => {
    const at = new Date("2026-04-02T12:00:00Z");
    const wrote = await upsertPatientLatestMessage(db, {
      conversationId,
      body: "Newer outbound reply",
      direction: "outbound",
      messageAt: at,
    });
    expect(wrote).toBe(true);

    const row = await readProjection();
    expect(row!.lastMessageDirection).toBe("outbound");
    expect(row!.preview).toBe("Newer outbound reply");
    expect(row!.lastMessageAt?.toISOString()).toBe(at.toISOString());
  });

  it("ignores out-of-order older events", async () => {
    const stale = new Date("2026-03-01T12:00:00Z");
    const wrote = await upsertPatientLatestMessage(db, {
      conversationId,
      body: "STALE EVENT — do not surface",
      direction: "inbound",
      messageAt: stale,
    });
    expect(wrote).toBe(false);

    const row = await readProjection();
    // Newer outbound from the previous test must still win.
    expect(row!.lastMessageDirection).toBe("outbound");
    expect(row!.preview).toBe("Newer outbound reply");
  });

  it("treats equal-timestamp redelivery as a no-op", async () => {
    // Replay the previous test's exact timestamp with a different
    // body. With the strict `<` guard this must not overwrite the
    // existing row — webhook redelivery commonly arrives with the
    // same vendor timestamp and we deliberately don't churn the
    // projection (which would also widen audit-style logging on
    // every retry).
    const sameTs = new Date("2026-04-02T12:00:00Z");
    const wrote = await upsertPatientLatestMessage(db, {
      conversationId,
      body: "REDELIVERED — should not overwrite",
      direction: "inbound",
      messageAt: sameTs,
    });
    expect(wrote).toBe(false);

    const row = await readProjection();
    expect(row!.lastMessageDirection).toBe("outbound");
    expect(row!.preview).toBe("Newer outbound reply");
  });

  it("returns false when the conversation does not exist", async () => {
    // Random uuid that won't match any conversation row.
    const wrote = await upsertPatientLatestMessage(db, {
      conversationId: "00000000-0000-0000-0000-000000000000",
      body: "ghost",
      direction: "inbound",
      messageAt: new Date(),
    });
    expect(wrote).toBe(false);
  });

  it("truncates long bodies before encrypting", async () => {
    const longBody = "z".repeat(500);
    const at = new Date("2026-04-04T12:00:00Z");
    await upsertPatientLatestMessage(db, {
      conversationId,
      body: longBody,
      direction: "inbound",
      messageAt: at,
    });
    const row = await readProjection();
    expect(row!.preview!.length).toBe(PREVIEW_MAX_CHARS);
    expect(row!.preview!.endsWith("…")).toBe(true);
  });

  it("tryUpsert swallows errors and logs", async () => {
    const calls: Array<{ obj: unknown; msg?: string }> = [];
    const logger = {
      warn(obj: Record<string, unknown>, msg?: string) {
        calls.push({ obj, msg });
      },
    };
    // Force an error path by passing a non-uuid conversationId; the
    // pg driver will reject the SELECT with an invalid input syntax
    // for type uuid.
    const wrote = await tryUpsertPatientLatestMessage(
      db,
      {
        conversationId: "not-a-uuid",
        body: "boom",
        direction: "inbound",
        messageAt: new Date(),
      },
      logger,
    );
    expect(wrote).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]!.msg).toContain("patient_latest_message");
  });
});
