import { test as base, expect } from "@playwright/test";

type FixtureDb = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: { id: string }[] }>;
};

async function fixtureDatabase(baseURL: string | undefined) {
  const connectionString = process.env["DATABASE_URL"];
  if (!process.env["E2E_ADMIN"] || !connectionString || !baseURL)
    throw new Error("Admin browser fixtures require the local E2E stack.");
  const database = new URL(connectionString);
  const app = new URL(baseURL);
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    !loopback.has(app.hostname) ||
    !loopback.has(database.hostname) ||
    !/(?:^|_)(?:ci|test|e2e|review)(?:_|$)/.test(database.pathname.slice(1))
  )
    throw new Error(
      "Admin fixtures may only use a loopback app and a test/CI/review database.",
    );
  // E2E runs from the repo root; reuse the workspace's existing pg dependency.
  const { createRequire } = await import("node:module");
  const requireDb = createRequire(
    `${process.cwd()}/lib/resupply-db/package.json`,
  );
  const { Client } = requireDb("pg") as {
    Client: new (options: { connectionString: string }) => FixtureDb;
  };
  return new Client({ connectionString });
}

export const test = base.extend<{
  fixtureDb: FixtureDb;
  _onboardedOrganization: void;
}>({
  fixtureDb: async ({ baseURL }, runFixture) => {
    const db = await fixtureDatabase(baseURL);
    await db.connect();
    try {
      await runFixture(db);
    } finally {
      await db.end();
    }
  },
  _onboardedOrganization: [
    async ({ fixtureDb: db, page }, runFixture) => {
      const marker = `admin-e2e-${crypto.randomUUID()}`;
      const ids: string[] = [];
      // Keep parallel workers from deleting agreement fixtures still in use.
      await db.query(
        "SELECT pg_advisory_lock(hashtext('pennfit:admin-e2e:agreements'))",
      );
      try {
        const response = await page.request.get(
          "/resupply-api/admin/agreements",
        );
        expect(response.ok()).toBeTruthy();
        const { agreements } = (await response.json()) as {
          agreements: { type: string; version: string }[];
        };
        const { rows } = await db.query(
          "SELECT id FROM resupply.organizations WHERE slug = 'penn-home-medical'",
        );
        expect(rows).toHaveLength(1);
        for (const agreement of agreements) {
          const inserted = await db.query(
            `INSERT INTO resupply.organization_agreements (org_id, agreement_type, version, signatory_name)
           VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, agreement_type, version) DO NOTHING RETURNING id`,
            [rows[0]!.id, agreement.type, agreement.version, marker],
          );
          ids.push(...inserted.rows.map((row) => row.id));
        }
        // The API caches pending agreement state for ten seconds.
        await expect
          .poll(
            async () =>
              (
                await page.request.get("/resupply-api/patients?limit=1")
              ).status(),
            { timeout: 15_000 },
          )
          .toBe(200);
        await runFixture();
      } finally {
        try {
          await db.query(
            "DELETE FROM resupply.organization_agreements WHERE id = ANY($1::uuid[]) AND signatory_name = $2",
            [ids, marker],
          );
        } finally {
          await db.query(
            "SELECT pg_advisory_unlock(hashtext('pennfit:admin-e2e:agreements'))",
          );
        }
      }
    },
    { auto: true, timeout: 120_000 },
  ],
});

export { expect };
