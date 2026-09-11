import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  applyPendingMigrations,
  migrationExecutionSql,
  readMigrations,
} from "./migrate.mjs";

interface Migration {
  tag: string;
  hash: string;
  sql: string[];
  folderMillis: number;
  noTransaction: boolean;
}
interface FixtureDatabase {
  exec(sql: string): Promise<Array<{ rows: Record<string, unknown>[] }>>;
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
const require = createRequire(
  new URL("../../../artifacts/resupply-api/package.json", import.meta.url),
);
const { PGlite } = require("@electric-sql/pglite") as {
  PGlite: new () => FixtureDatabase;
};
const migrations = readMigrations(
  fileURLToPath(new URL("../migrations", import.meta.url)),
) as Migration[];
const legacy59 = migrations.find(
  (migration) => migration.tag === "0059_auth_admin_enum_constraints",
)!;
const legacy60 = migrations.find(
  (migration) => migration.tag === "0060_updated_at_triggers_phase4",
)!;
const ownedHelper = migrations.find(
  (migration) => migration.tag === "0546_auth_updated_at_owned_schema",
)!;

describe("managed auth schema migration compatibility", () => {
  let database: FixtureDatabase;
  const client = {
    query: (sql: string, values?: unknown[]) =>
      values
        ? database.query(sql, values)
        : database.exec(sql).then((results) => results.at(-1)),
  };
  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE fixture_migrator NOLOGIN NOSUPERUSER;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO fixture_migrator;`);
  });
  beforeEach(async () => {
    await database.exec(`
      RESET ROLE;
      DROP SCHEMA IF EXISTS resupply CASCADE;
      DROP SCHEMA IF EXISTS resupply_auth CASCADE;
      DROP SCHEMA IF EXISTS migrations CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP FUNCTION IF EXISTS auth.set_updated_at() CASCADE;
      CREATE SCHEMA resupply AUTHORIZATION fixture_migrator;
      CREATE SCHEMA resupply_auth AUTHORIZATION fixture_migrator;
      CREATE SCHEMA migrations AUTHORIZATION fixture_migrator;
      CREATE SCHEMA public AUTHORIZATION fixture_migrator;
      SET ROLE fixture_migrator;
      CREATE TABLE resupply.admin_users (id integer PRIMARY KEY, status text, role text);
      CREATE TABLE resupply_auth.users (
        id integer PRIMARY KEY, status text, role text, updated_at timestamptz DEFAULT '2000-01-01');
      CREATE TABLE resupply_auth.password_credentials (
        id integer PRIMARY KEY, updated_at timestamptz DEFAULT '2000-01-01');
      CREATE TABLE public.reminder_subscriptions (id integer PRIMARY KEY, updated_at timestamptz);
      CREATE TABLE resupply.insurance_leads (status text);
      CREATE FUNCTION resupply.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
      CREATE TABLE migrations.resupply_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
      INSERT INTO resupply_auth.users (id, status, role) VALUES (1, 'active', 'customer');
      INSERT INTO resupply_auth.password_credentials (id) VALUES (1);`);
  });
  afterAll(async () => {
    await database?.close();
  });

  async function triggerSchemas() {
    return (
      await database.query<{ table_name: string; function_schema: string }>(`
      SELECT c.relname AS table_name, n.nspname AS function_schema
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE t.tgname IN ('trg_auth_users_set_updated_at', 'trg_auth_password_credentials_set_updated_at')
      ORDER BY c.relname`)
    ).rows;
  }
  async function assertTimestampsUpdate() {
    const { rows } = await database.query<{
      users: boolean;
      credentials: boolean;
    }>(`
      WITH users AS (UPDATE resupply_auth.users SET status = 'active' WHERE id = 1 RETURNING updated_at),
        credentials AS (UPDATE resupply_auth.password_credentials SET id = 1 WHERE id = 1 RETURNING updated_at)
      SELECT (SELECT updated_at > '2000-01-02' FROM users) AS users,
        (SELECT updated_at > '2000-01-02' FROM credentials) AS credentials`);
    expect(rows[0]).toEqual({ users: true, credentials: true });
  }
  async function installLegacy(applied: Migration[]) {
    await database.exec("RESET ROLE;");
    for (const migration of applied)
      await database.exec(migration.sql.join("\n"));
    await database.exec("SET ROLE fixture_migrator;");
    for (const migration of applied) {
      await database.query(
        "INSERT INTO migrations.resupply_migrations (hash, created_at) VALUES ($1, $2)",
        [migration.hash, migration.folderMillis],
      );
    }
  }

  it("reproduces the original CREATE denial, then replays both migrations without auth CREATE", async () => {
    await database.exec("BEGIN;");
    await expect(database.exec(legacy59.sql.join("\n"))).rejects.toThrow(
      "permission denied for schema auth",
    );
    await database.exec("ROLLBACK;");
    const originalSql = JSON.stringify([legacy59.sql, legacy60.sql]);
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      expect(await applyPendingMigrations(client, [legacy59, legacy60])).toBe(
        2,
      );
      expect(output.mock.calls.map(([text]) => text).join("\n")).toContain(
        "historical ledger hash unchanged",
      );
    } finally {
      output.mockRestore();
    }
    expect(JSON.stringify([legacy59.sql, legacy60.sql])).toBe(originalSql);
    expect(
      (
        await database.query(
          "SELECT hash FROM migrations.resupply_migrations ORDER BY id",
        )
      ).rows,
    ).toEqual([{ hash: legacy59.hash }, { hash: legacy60.hash }]);
    expect(await triggerSchemas()).toEqual([
      { table_name: "password_credentials", function_schema: "resupply_auth" },
      { table_name: "users", function_schema: "resupply_auth" },
    ]);
    await assertTimestampsUpdate();
    expect(
      (
        await database.query(`SELECT
      has_schema_privilege('fixture_migrator', 'auth', 'CREATE') AS can_create,
      to_regprocedure('auth.set_updated_at()') IS NOT NULL AS managed_helper`)
      ).rows[0],
    ).toEqual({ can_create: false, managed_helper: false });
    expect(await applyPendingMigrations(client, [legacy59, legacy60])).toBe(0);
  });

  it.each([false, true])(
    "resumes 0060 alone when 0059 was recorded (legacy helper removed: %s)",
    async (removed) => {
      await installLegacy([legacy59]);
      if (removed) {
        await database.exec(
          "RESET ROLE; DROP FUNCTION auth.set_updated_at() CASCADE; SET ROLE fixture_migrator;",
        );
      }
      expect(
        await applyPendingMigrations(client, [legacy59, legacy60, ownedHelper]),
      ).toBe(2);
      expect(
        (await triggerSchemas()).map((trigger) => trigger.function_schema),
      ).toEqual(["resupply_auth", "resupply_auth"]);
      await assertTimestampsUpdate();
    },
  );

  it("converges already-applied deployments without replay or changing the legacy function", async () => {
    await installLegacy([legacy59, legacy60]);
    const legacyBefore = (
      await database.query(
        "SELECT pg_get_functiondef('auth.set_updated_at()'::regprocedure) AS definition",
      )
    ).rows;
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      expect(
        await applyPendingMigrations(client, [legacy59, legacy60, ownedHelper]),
      ).toBe(1);
      expect(output.mock.calls.map(([text]) => text).join("\n")).not.toContain(
        "compatibility",
      );
    } finally {
      output.mockRestore();
    }
    expect(
      (
        await database.query(
          "SELECT pg_get_functiondef('auth.set_updated_at()'::regprocedure) AS definition",
        )
      ).rows,
    ).toEqual(legacyBefore);
    expect(
      (await triggerSchemas()).map((trigger) => trigger.function_schema),
    ).toEqual(["resupply_auth", "resupply_auth"]);
    await assertTimestampsUpdate();
    expect(
      (
        await database.query(`SELECT
      has_function_privilege('service_role', 'resupply_auth.set_updated_at()', 'EXECUTE') AS server,
      has_function_privilege('anon', 'resupply_auth.set_updated_at()', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'resupply_auth.set_updated_at()', 'EXECUTE') AS authenticated`)
      ).rows[0],
    ).toEqual({ server: true, anon: false, authenticated: false });
    expect(
      await applyPendingMigrations(client, [legacy59, legacy60, ownedHelper]),
    ).toBe(0);
  });

  it.each(["hash", "sql"])(
    "refuses unreviewed %s changes before applying a historical migration",
    async (changed) => {
      const alteredSql = [...legacy59.sql, "-- unexpected edit"];
      const altered =
        changed === "hash"
          ? {
              ...legacy59,
              hash: createHash("sha256").update("changed").digest("hex"),
            }
          : { ...legacy59, sql: alteredSql };
      await expect(applyPendingMigrations(client, [altered])).rejects.toThrow(
        "compatibility refused changed migration",
      );
      expect(
        (
          await database.query(
            "SELECT hash FROM migrations.resupply_migrations",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.query(
            "SELECT to_regprocedure('resupply_auth.set_updated_at()') IS NULL AS absent",
          )
        ).rows[0],
      ).toEqual({ absent: true });
    },
  );

  it("does not adapt any other migration tag", () => {
    const other = { ...legacy59, tag: "0999_unrelated" };
    expect(migrationExecutionSql(other)).toBe(other.sql);
    expect(legacy59.hash).toBe(
      "97a6654864051f20a47f04eba5d5ac625f8db93f68e451133fe80d393a00095e",
    );
    expect(legacy60.hash).toBe(
      "999eba91d8d49924eac1c145b0e57348f8eefe8ff72ed6c43210535c7d438284",
    );
  });

  it("rolls back the compatibility helper and ledger entry if 0060 fails", async () => {
    await database.exec("DROP TABLE public.reminder_subscriptions;");
    await expect(applyPendingMigrations(client, [legacy60])).rejects.toThrow(
      "0060_updated_at_triggers_phase4",
    );
    expect(
      (
        await database.query(
          "SELECT to_regprocedure('resupply_auth.set_updated_at()') IS NULL AS absent",
        )
      ).rows[0],
    ).toEqual({ absent: true });
    expect(
      (await database.query("SELECT hash FROM migrations.resupply_migrations"))
        .rows,
    ).toEqual([]);
  });
});
