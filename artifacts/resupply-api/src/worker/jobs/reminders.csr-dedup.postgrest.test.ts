// Opt in with the same local DB/PostgREST environment as the worker fan-out
// integration suites. This exercises the actual Supabase HTTP transport;
// no worker is registered and no sender or provider is called.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __resetDbPoolForTests,
  getDbPool,
  getOrgScopedClient,
} from "@workspace/resupply-db";
import { releaseReminderDedupKey, tryClaimReminderDedupKey } from "./reminders";

const configured = Boolean(
  process.env.DATABASE_URL &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
if (configured) {
  const database = new URL(process.env.DATABASE_URL!);
  const rest = new URL(process.env.SUPABASE_URL!);
  const loopback = (host: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (
    !loopback(database.hostname) ||
    !loopback(rest.hostname) ||
    !/(?:^|_)(?:ci|test|e2e|review)(?:_|$)/.test(database.pathname.slice(1))
  )
    throw new Error(
      "CSR claim integration tests require a loopback test database and PostgREST",
    );
}

describe.skipIf(!configured)("CSR claims through PostgREST", () => {
  const orgId = randomUUID();
  const patientId = randomUUID();
  const prescriptionId = randomUUID();
  const episodeId = randomUUID();
  let pool: ReturnType<typeof getDbPool> | undefined;
  const db = () => getOrgScopedClient(orgId);
  const claim = (channel: "sms" | "email" | "voice", csrRequested: boolean) =>
    tryClaimReminderDedupKey(
      db(),
      channel,
      patientId,
      episodeId,
      randomUUID(),
      { csrRequested },
    );
  const concurrently = async (requests: ReturnType<typeof claim>[]) => {
    // Drain every HTTP request even if one fails, so fixture cleanup cannot
    // race a claim that is still committing in another PostgREST transaction.
    const results = await Promise.allSettled(requests);
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  };
  const storedKeys = async () => {
    const { rows } = await pool!.query<{ key: string }>(
      "SELECT key FROM resupply.worker_dedup_keys WHERE key LIKE $1 ORDER BY key",
      [`%${patientId}%`],
    );
    return rows.map((row) => row.key);
  };
  const removeOwnClaims = () =>
    pool!.query("DELETE FROM resupply.worker_dedup_keys WHERE key LIKE $1", [
      `%${patientId}%`,
    ]);

  beforeAll(async () => {
    pool = getDbPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO resupply.organizations (id, slug, name, status) VALUES ($1, $2, 'CSR claim fixture', 'active')",
        [orgId, `csr-claim-test-${orgId}`],
      );
      await client.query(
        "INSERT INTO resupply.patients (id, org_id, legal_first_name, legal_last_name, date_of_birth, timezone, status) VALUES ($1, $2, 'Synthetic', 'Claim Fixture', '1970-01-01', 'Etc/UTC', 'active')",
        [patientId, orgId],
      );
      await client.query(
        "INSERT INTO resupply.prescriptions (id, org_id, patient_id, item_sku, cadence_days, valid_from, status) VALUES ($1, $2, $3, 'FIXTURE-SUPPLY', 90, '2020-01-01', 'active')",
        [prescriptionId, orgId, patientId],
      );
      await client.query(
        "INSERT INTO resupply.episodes (id, org_id, patient_id, prescription_id, status, due_at) VALUES ($1, $2, $3, $4, 'outreach_pending', now())",
        [episodeId, orgId, patientId, prescriptionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // A real scoped read also verifies this HTTP surface uses the DB seeded
    // above, rather than silently falling back after a missing patient read.
    const patient = await db()
      .from("patients")
      .select("id, timezone")
      .eq("id", patientId)
      .single();
    expect(patient.error).toBeNull();
    expect(patient.data).toEqual({ id: patientId, timezone: "Etc/UTC" });
  });
  afterEach(async () => {
    if (pool) await removeOwnClaims();
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      await removeOwnClaims();
      await pool.query("DELETE FROM resupply.episodes WHERE org_id = $1", [
        orgId,
      ]);
      await pool.query("DELETE FROM resupply.prescriptions WHERE org_id = $1", [
        orgId,
      ]);
      await pool.query("DELETE FROM resupply.patients WHERE org_id = $1", [
        orgId,
      ]);
      await pool.query("DELETE FROM resupply.organizations WHERE id = $1", [
        orgId,
      ]);
    } finally {
      await pool.end();
      __resetDbPoolForTests();
    }
  });

  it.each(["sms", "email", "voice"] as const)(
    "allows one concurrent scheduled/CSR %s claim for the same cycle",
    async (channel) => {
      const claims = await concurrently([
        claim(channel, false),
        claim(channel, true),
      ]);
      const winners = claims.filter((result) => result.proceed);
      expect(winners).toHaveLength(1);
      expect(claims.find((result) => !result.proceed)?.keys).toEqual([]);
      expect(await storedKeys()).toEqual([...winners[0]!.keys].sort());
    },
  );

  it("does not leave a CSR cooldown when the scheduled day key conflicts", async () => {
    const scheduled = await claim("sms", false);
    expect(scheduled.proceed).toBe(true);
    const csr = await claim("sms", true);
    expect(csr.proceed).toBe(false);
    expect(await storedKeys()).toEqual([...scheduled.keys].sort());
    // A failed batch must not block a different CSR channel. The separate
    // eligibility/recent-contact policy is intentionally outside this helper.
    expect((await claim("email", true)).proceed).toBe(true);
  });

  it("rolls back a new day key when the second key in the batch conflicts", async () => {
    const first = await claim("sms", true);
    expect(first.proceed).toBe(true);
    expect((await claim("email", true)).proceed).toBe(false);
    expect(await storedKeys()).toEqual([...first.keys].sort());
    await releaseReminderDedupKey(db(), first.keys, "fixture-release");
    expect((await claim("email", false)).proceed).toBe(true);
  });

  it("releases both owned keys so scheduled and CSR retries can claim again", async () => {
    const csr = await claim("voice", true);
    expect(csr.proceed).toBe(true);
    await releaseReminderDedupKey(db(), csr.keys, "fixture-release");
    expect(await storedKeys()).toEqual([]);
    const scheduled = await claim("voice", false);
    expect(scheduled.proceed).toBe(true);
    await releaseReminderDedupKey(db(), scheduled.keys, "fixture-release");
    expect((await claim("sms", true)).proceed).toBe(true);
  });

  it("claims one CSR channel and rolls back every losing batch", async () => {
    const claims = await concurrently(
      (["sms", "email", "voice"] as const).map((channel) =>
        claim(channel, true),
      ),
    );
    const winners = claims.filter((result) => result.proceed);
    expect(winners).toHaveLength(1);
    expect(await storedKeys()).toEqual([...winners[0]!.keys].sort());
    await releaseReminderDedupKey(db(), winners[0]!.keys, "fixture-release");
    for (const channel of ["sms", "email", "voice"] as const)
      expect((await claim(channel, false)).proceed).toBe(true);
  });
});
