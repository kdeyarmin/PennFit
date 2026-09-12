import { createRequire } from "node:module";
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
  assertPreviewIdentity,
  inspectRuntimeGrants,
  parsePreviewArgs,
  PRODUCTION_PROJECT_REF,
  runPreviewInitialization,
} from "./init.mjs";

const require = createRequire(
  new URL("../../artifacts/resupply-api/package.json", import.meta.url),
);
const { PGlite } = require("@electric-sql/pglite");
const projectRef = "bbbbbbbbbbbbbbbbbbbb";
const branchId = "11111111-2222-4333-8444-555555555555";
const env = {
  DATABASE_URL: `postgresql://postgres:fixture-secret@db.${projectRef}.supabase.co:5432/postgres`,
  SUPABASE_URL: `https://${projectRef}.supabase.co`,
  SUPABASE_ACCESS_TOKEN: "fixture-access-token",
  DEPLOY_ENV: "preview",
  DATABASE_ENV: "preview",
  PRODUCTION_DATABASE_FINGERPRINT: "28616a064d1b",
  PRODUCTION_SUPABASE_FINGERPRINT: "111111111111",
};
const options = { projectRef, branchId, env };
const branch = {
  id: branchId,
  name: "fixture-pr-preview",
  project_ref: projectRef,
  parent_project_ref: PRODUCTION_PROJECT_REF,
  is_default: false,
  with_data: false,
};
const migrations = [
  { tag: "0000_fixture", hash: "a".repeat(64) },
  { tag: "0001_fixture", hash: "b".repeat(64) },
];
const fetchFor = (metadata = branch) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [metadata],
  });

describe("preview identity boundary", () => {
  it.each([
    { projectRef: PRODUCTION_PROJECT_REF },
    {
      env: {
        ...env,
        SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      },
    },
    {
      env: {
        ...env,
        DATABASE_URL: `postgresql://postgres:fixture@db.${PRODUCTION_PROJECT_REF}.supabase.co/postgres`,
      },
    },
    {
      env: {
        ...env,
        DATABASE_URL: `${env.DATABASE_URL}?host=db.${PRODUCTION_PROJECT_REF}.supabase.co`,
      },
    },
    { env: { ...env, DATABASE_ENV: "production" } },
    { env: { ...env, MIGRATIONS_BASELINE_THROUGH: "0187" } },
    {
      env: {
        ...env,
        DATABASE_URL: env.DATABASE_URL.replace(":5432/", ":6543/"),
      },
    },
    { apply: true },
  ])(
    "rejects unsafe input before any network or SQL access: %j",
    async (override) => {
      const fetchImpl = fetchFor();
      const createClient = vi.fn();
      await expect(
        runPreviewInitialization(
          { ...options, ...override },
          {
            fetchImpl,
            createClient,
            readMigrations: () => migrations,
          },
        ),
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    { is_default: true },
    { with_data: true },
    { with_data: undefined },
    { parent_project_ref: "cccccccccccccccccccc" },
    { project_ref: "cccccccccccccccccccc" },
    { id: "99999999-2222-4333-8444-555555555555" },
  ])(
    "requires live metadata to identify a disposable branch: %j",
    async (override) => {
      const createClient = vi.fn();
      await expect(
        runPreviewInitialization(options, {
          fetchImpl: fetchFor({ ...branch, ...override }),
          createClient,
          readMigrations: () => migrations,
        }),
      ).rejects.toMatchObject({ code: "NOT_DISPOSABLE_PREVIEW" });
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("accepts a pooler only when its username identifies this preview", async () => {
    const poolerEnv = {
      ...env,
      DATABASE_URL: `postgresql://postgres.${projectRef}:fixture@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
    };
    const result = await assertPreviewIdentity(
      { ...options, env: poolerEnv },
      { fetchImpl: fetchFor() },
    );
    expect(result.projectRef).toBe(projectRef);
    expect(JSON.stringify(result)).not.toContain("fixture-access-token");
    await expect(
      assertPreviewIdentity(
        {
          ...options,
          env: {
            ...poolerEnv,
            DATABASE_URL: poolerEnv.DATABASE_URL.replace(
              `postgres.${projectRef}`,
              `postgres.${PRODUCTION_PROJECT_REF}`,
            ),
          },
        },
        { fetchImpl: fetchFor() },
      ),
    ).rejects.toMatchObject({ code: "DATABASE_TARGET_MISMATCH" });
  });

  it("suppresses remote response/error details and refuses failed identity checks", async () => {
    await expect(
      assertPreviewIdentity(options, {
        fetchImpl: async () => {
          throw new Error(`leaked ${env.SUPABASE_ACCESS_TOKEN}`);
        },
      }),
    ).rejects.toThrow("Could not verify Supabase branch identity.");
    await expect(
      assertPreviewIdentity(options, {
        fetchImpl: async () => ({ ok: false }),
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_UNAVAILABLE" });
  });

  it("requires explicit CLI identity and a separate grant flag", () => {
    expect(
      parsePreviewArgs(
        ["--project-ref", projectRef, "--branch-id", branchId],
        env,
      ).apply,
    ).toBe(false);
    expect(() => parsePreviewArgs(["--reset"], env)).toThrow(
      "Unknown or duplicate",
    );
    expect(() =>
      parsePreviewArgs(
        ["--project-ref", projectRef, "--project-ref", projectRef],
        env,
      ),
    ).toThrow("Unknown or duplicate");
  });

  it("uses authenticated CLI metadata without exposing or exporting credentials", async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValue({ stdout: JSON.stringify([branch]) });
    const fetchImpl = vi.fn();
    const cliEnv = {
      ...env,
      SUPABASE_ACCESS_TOKEN: "",
      PATH: "fixture-bin",
      USERPROFILE: "fixture-profile",
      SUPABASE_API_URL: "https://untrusted.example.test",
    };
    expect(
      (
        await assertPreviewIdentity(
          { ...options, env: cliEnv },
          { execFileImpl, fetchImpl },
        )
      ).projectRef,
    ).toBe(projectRef);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl.mock.calls[0][1]).toEqual([
      "branches",
      "list",
      "--project-ref",
      PRODUCTION_PROJECT_REF,
      "--output",
      "json",
      "--agent",
      "no",
    ]);
    expect(execFileImpl.mock.calls[0][2].env).toEqual({
      PATH: "fixture-bin",
      USERPROFILE: "fixture-profile",
    });
    await expect(
      assertPreviewIdentity(
        { ...options, env: cliEnv },
        {
          execFileImpl: async () => {
            throw new Error("fixture-private-cli-error");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("preview schema and grants against PostgreSQL", () => {
  let database;
  let query;
  let dependencies;
  beforeAll(async () => {
    database = new PGlite();
    await database.exec(
      "CREATE ROLE service_role NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;",
    );
  });
  beforeEach(async () => {
    await database.exec(`
      DROP SCHEMA IF EXISTS resupply CASCADE;
      DROP SCHEMA IF EXISTS resupply_auth CASCADE;
      DROP SCHEMA IF EXISTS migrations CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public; CREATE SCHEMA resupply; CREATE SCHEMA resupply_auth;`);
    query = vi.fn((sql, values) =>
      values
        ? database.query(sql, values)
        : database.exec(sql).then((results) => results.at(-1)),
    );
    dependencies = {
      fetchImpl: fetchFor(),
      readMigrations: () => migrations,
      createClient: () => ({
        connect: async () => {},
        end: async () => {},
        query,
      }),
    };
  });
  afterAll(async () => {
    await database?.close();
  });

  async function readySchema(
    hashes = migrations.map((migration) => migration.hash),
  ) {
    await database.exec(`
      CREATE TABLE resupply.patients (id serial PRIMARY KEY);
      CREATE TABLE resupply.organizations (id serial PRIMARY KEY);
      CREATE TABLE resupply.episodes (id serial PRIMARY KEY);
      CREATE TABLE resupply.fulfillments (id serial PRIMARY KEY);
      CREATE TABLE resupply.patient_packets (id serial PRIMARY KEY);
      CREATE TABLE resupply_auth.users (id serial PRIMARY KEY);
      CREATE TABLE public.orders (id serial PRIMARY KEY);
      CREATE FUNCTION resupply.fixture_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE SCHEMA migrations;
      CREATE TABLE migrations.resupply_migrations (hash text NOT NULL);`);
    for (const hash of hashes)
      await database.query(
        "INSERT INTO migrations.resupply_migrations VALUES ($1)",
        [hash],
      );
  }
  const applyOptions = {
    ...options,
    apply: true,
    confirmDisposableProject: projectRef,
  };

  it("reports empty application schemas as requiring migrations without any writes", async () => {
    const result = await runPreviewInitialization(options, dependencies);
    expect(result).toMatchObject({
      status: "MIGRATIONS_REQUIRED",
      applicationObjects: 0,
      grantsApplied: false,
    });
    expect(result.missingMigrations).toEqual(["0000_fixture", "0001_fixture"]);
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
      /\b(GRANT|ALTER|CREATE|DROP)\b/,
    );
  });

  it("reports partial unledgered state and refuses grant writes even with --apply-grants", async () => {
    await database.exec("CREATE TABLE resupply.patients (id integer);");
    const result = await runPreviewInitialization(applyOptions, dependencies);
    expect(result).toMatchObject({
      status: "RESET_REQUIRED",
      grantsApplied: false,
    });
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
      /\b(GRANT|ALTER|DROP)\b/,
    );
  });

  it("compares authoritative hashes rather than trusting an equal row count", async () => {
    await readySchema([migrations[0].hash, "c".repeat(64)]);
    const result = await runPreviewInitialization(applyOptions, dependencies);
    expect(result).toMatchObject({
      status: "RESET_REQUIRED",
      unknownMigrationHashes: 1,
      grantsApplied: false,
    });
    expect(result.missingMigrations).toEqual(["0001_fixture"]);
  });

  it("does not treat a partial public enum-only schema as fresh", async () => {
    await database.exec(
      "CREATE TYPE public.fixture_partial AS ENUM ('fixture');",
    );
    const result = await runPreviewInitialization(options, dependencies);
    expect(result).toMatchObject({
      status: "RESET_REQUIRED",
      applicationObjects: 1,
    });
  });

  it("allows an interrupted known migration chain to resume without ledger stamping", async () => {
    await readySchema([migrations[0].hash]);
    const result = await runPreviewInitialization(applyOptions, dependencies);
    expect(result).toMatchObject({
      status: "MIGRATIONS_REQUIRED",
      grantsApplied: false,
    });
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toContain(
      "INSERT",
    );
  });

  it("rejects a complete ledger whose core schema is missing", async () => {
    await readySchema();
    await database.exec("DROP TABLE resupply.patient_packets;");
    const result = await runPreviewInitialization(applyOptions, dependencies);
    expect(result).toMatchObject({
      status: "SCHEMA_INCOMPLETE",
      missingTables: ["resupply.patient_packets"],
      grantsApplied: false,
    });
  });

  it("reports missing runtime grants during a read-only check", async () => {
    await readySchema();
    const result = await runPreviewInitialization(options, dependencies);
    expect(result).toMatchObject({
      status: "GRANTS_REQUIRED",
      grantsApplied: false,
    });
    expect(query.mock.calls[0][0]).toContain("READ ONLY");
  });

  it("requires the public storefront orders table even with a complete ledger", async () => {
    await readySchema();
    await database.exec("DROP TABLE public.orders;");
    expect(
      await runPreviewInitialization(applyOptions, dependencies),
    ).toMatchObject({
      status: "SCHEMA_INCOMPLETE",
      missingTables: ["public.orders"],
      grantsApplied: false,
    });
  });

  it("grants the existing server role access to current and future objects only", async () => {
    await readySchema();
    const result = await runPreviewInitialization(applyOptions, dependencies);
    expect(result).toMatchObject({ status: "READY", grantsApplied: true });
    expect(Object.values(result.grants)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    await database.exec(
      "CREATE TABLE resupply.future_table (id serial PRIMARY KEY); CREATE TABLE public.newsletter_subscribers (id serial PRIMARY KEY);",
    );
    const { rows } = await database.query(`SELECT
      has_table_privilege('service_role', 'resupply.future_table', 'INSERT') AS future_insert,
      has_sequence_privilege('service_role', 'resupply.future_table_id_seq', 'USAGE') AS future_sequence,
      has_table_privilege('service_role', 'public.newsletter_subscribers', 'INSERT') AS public_insert,
      has_sequence_privilege('service_role', 'public.newsletter_subscribers_id_seq', 'USAGE') AS public_sequence,
      has_table_privilege('anon', 'public.orders', 'SELECT') AS public_anon_access,
      has_table_privilege('anon', 'resupply.patients', 'SELECT') AS anon_access`);
    expect(rows[0]).toEqual({
      future_insert: true,
      future_sequence: true,
      public_insert: true,
      public_sequence: true,
      public_anon_access: false,
      anon_access: false,
    });
    expect((await runPreviewInitialization(options, dependencies)).status).toBe(
      "READY",
    );
  });

  it("checks every DML permission rather than treating SELECT as sufficient", async () => {
    await readySchema();
    await runPreviewInitialization(applyOptions, dependencies);
    await database.exec(
      "REVOKE INSERT ON resupply.patients FROM service_role;",
    );
    expect((await inspectRuntimeGrants({ query })).tables).toBe(false);
  });

  it("detects and repairs missing public-table permissions without changing RLS or anon grants", async () => {
    await readySchema();
    await runPreviewInitialization(applyOptions, dependencies);
    await database.exec(`
      ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.orders TO anon;
      REVOKE UPDATE ON public.orders FROM service_role;`);
    expect(await runPreviewInitialization(options, dependencies)).toMatchObject(
      {
        status: "GRANTS_REQUIRED",
        grants: { tables: false },
      },
    );
    expect(
      (await runPreviewInitialization(applyOptions, dependencies)).status,
    ).toBe("READY");
    const { rows } = await database.query(`SELECT
      has_table_privilege('service_role', 'public.orders', 'UPDATE') AS can_update,
      has_table_privilege('anon', 'public.orders', 'SELECT') AS anon_select,
      has_table_privilege('anon', 'public.orders', 'UPDATE') AS anon_update,
      relrowsecurity AS rls FROM pg_class WHERE oid = 'public.orders'::regclass`);
    expect(rows[0]).toEqual({
      can_update: true,
      anon_select: true,
      anon_update: false,
      rls: true,
    });
  });

  it("leaves extension-owned public objects outside runtime grants and checks", async () => {
    await readySchema();
    await database.exec(`
      CREATE TABLE public.fixture_extension_table (id serial PRIMARY KEY);
      CREATE FUNCTION public.fixture_extension_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      REVOKE ALL ON FUNCTION public.fixture_extension_fn() FROM PUBLIC;
      ALTER EXTENSION plpgsql ADD TABLE public.fixture_extension_table;
      ALTER EXTENSION plpgsql ADD SEQUENCE public.fixture_extension_table_id_seq;
      ALTER EXTENSION plpgsql ADD FUNCTION public.fixture_extension_fn();`);
    try {
      expect(
        (await runPreviewInitialization(applyOptions, dependencies)).status,
      ).toBe("READY");
      const { rows } = await database.query(`SELECT
        has_table_privilege('service_role', 'public.fixture_extension_table', 'SELECT') AS table_access,
        has_sequence_privilege('service_role', 'public.fixture_extension_table_id_seq', 'USAGE') AS sequence_access,
        has_function_privilege('service_role', 'public.fixture_extension_fn()', 'EXECUTE') AS function_access`);
      expect(rows[0]).toEqual({
        table_access: false,
        sequence_access: false,
        function_access: false,
      });
    } finally {
      await database.exec(`
        ALTER EXTENSION plpgsql DROP TABLE public.fixture_extension_table;
        ALTER EXTENSION plpgsql DROP SEQUENCE public.fixture_extension_table_id_seq;
        ALTER EXTENSION plpgsql DROP FUNCTION public.fixture_extension_fn();`);
    }
  });

  it("rolls back grants if verification fails", async () => {
    await readySchema();
    const actual = query.getMockImplementation();
    query.mockImplementation((sql, values) =>
      sql.includes("AS schemas")
        ? Promise.resolve({ rows: [{ schemas: false }] })
        : actual(sql, values),
    );
    await expect(
      runPreviewInitialization(applyOptions, dependencies),
    ).rejects.toMatchObject({ code: "GRANTS_INCOMPLETE" });
    const { rows } = await database.query(
      "SELECT has_schema_privilege('service_role', 'resupply', 'USAGE') AS access",
    );
    expect(rows[0].access).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });
});
