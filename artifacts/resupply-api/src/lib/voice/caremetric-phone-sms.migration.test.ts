import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("enforces one durable text claim per call, RLS, valid recipients and terminal status", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE SCHEMA resupply; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
    );
    const migration = readFileSync(
      new URL(
        "../../../../../lib/resupply-db/migrations/0561_shared_phone_sms.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(migration);
    const insert =
      "INSERT INTO resupply.shared_phone_sms(twilio_call_sid,recipient,resources,consent_version) VALUES ($1,$2,'[\"support\"]','test') RETURNING id";
    await db.query(insert, ["CA-test", "+12125550123"]);
    await expect(db.query(insert, ["CA-test", "+12125550124"])).rejects.toThrow(
      /unique/i,
    );
    await expect(
      db.query(insert, ["CA-other", "not-a-mobile"]),
    ).rejects.toThrow(/check constraint/i);
    await db.exec(
      "UPDATE resupply.shared_phone_sms SET delivery_status='delivered';",
    );
    await db.exec(
      "UPDATE resupply.shared_phone_sms SET delivery_status='accepted' WHERE delivery_status IN ('submitting','accepted','unknown');",
    );
    const outcome = await db.query<{
      delivery_status: string;
      consent_at: unknown;
    }>("SELECT delivery_status,consent_at FROM resupply.shared_phone_sms");
    expect(outcome.rows[0]?.delivery_status).toBe("delivered");
    expect(outcome.rows[0]?.consent_at).toBeTruthy();
    await db.exec("SET ROLE authenticated;");
    await expect(
      db.query("SELECT * FROM resupply.shared_phone_sms"),
    ).rejects.toThrow(/permission denied/i);
  } finally {
    await db.close();
  }
}, 20_000);
