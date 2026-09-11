#!/usr/bin/env node
// Check a disposable Supabase branch; optionally provision its runtime grants.
// Never resets schemas, runs migrations, or stamps the application ledger.
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  evaluateMigrationGuard,
  evaluateRuntimeDataPathGuard,
  fingerprintDatabaseUrl,
} from "../../lib/resupply-db/scripts/deploy-environment.mjs";

export const PRODUCTION_PROJECT_REF = "uppdjphagdildcgkvdsz";
const PROJECT_REF = /^[a-z]{20}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MIGRATION_LOCK = "7427398427542000001";
const execFileAsync = promisify(execFile);
const REQUIRED_TABLES = [
  "resupply.patients",
  "resupply.organizations",
  "resupply.episodes",
  "resupply.fulfillments",
  "resupply.patient_packets",
  "resupply_auth.users",
  "public.orders",
];

export class PreviewSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreviewSetupError";
    this.code = code;
  }
}
function requireCondition(condition, code, message) {
  if (!condition) throw new PreviewSetupError(code, message);
}
function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new PreviewSetupError(
      "INVALID_TARGET",
      `${label} is not a valid URL.`,
    );
  }
}

/** Verify metadata before any database connection. Never return credentials. */
export async function assertPreviewIdentity(
  {
    env,
    projectRef,
    branchId,
    parentProjectRef = PRODUCTION_PROJECT_REF,
    confirmDisposableProject,
    apply = false,
  },
  { fetchImpl = globalThis.fetch, execFileImpl = execFileAsync } = {},
) {
  requireCondition(
    PROJECT_REF.test(projectRef ?? "") &&
      PROJECT_REF.test(parentProjectRef ?? "") &&
      UUID.test(branchId ?? ""),
    "INVALID_IDENTITY",
    "Provide explicit preview project, branch, and parent project identifiers.",
  );
  requireCondition(
    projectRef !== PRODUCTION_PROJECT_REF && projectRef !== parentProjectRef,
    "PRODUCTION_TARGET",
    "The production or parent project cannot be initialized as a preview.",
  );
  requireCondition(
    !apply || confirmDisposableProject === projectRef,
    "CONFIRMATION_REQUIRED",
    "Grant changes require --confirm-disposable-project matching the preview project.",
  );
  const database = parseUrl(env.DATABASE_URL, "DATABASE_URL");
  const runtime = parseUrl(env.SUPABASE_URL, "SUPABASE_URL");
  const direct =
    database.hostname === `db.${projectRef}.supabase.co` &&
    database.username === "postgres";
  const pooler =
    /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(database.hostname) &&
    decodeURIComponent(database.username) === `postgres.${projectRef}`;
  requireCondition(
    ["postgres:", "postgresql:"].includes(database.protocol) &&
      (direct || pooler) &&
      ["", "5432"].includes(database.port) &&
      database.pathname === "/postgres" &&
      !database.hash &&
      !database.searchParams.has("host") &&
      !database.searchParams.has("hostaddr") &&
      !database.searchParams.has("dbname") &&
      !database.searchParams.has("user") &&
      !database.searchParams.has("port"),
    "DATABASE_TARGET_MISMATCH",
    "DATABASE_URL must identify the preview database on direct/session port 5432, without target overrides. Transaction pooler port 6543 is not supported.",
  );
  requireCondition(
    runtime.protocol === "https:" &&
      runtime.hostname === `${projectRef}.supabase.co` &&
      !runtime.port &&
      !runtime.username &&
      !runtime.password &&
      ["", "/"].includes(runtime.pathname) &&
      !runtime.search &&
      !runtime.hash,
    "RUNTIME_TARGET_MISMATCH",
    "SUPABASE_URL must identify the same selected preview project.",
  );
  requireCondition(
    env.DEPLOY_ENV === "preview" &&
      env.DATABASE_ENV === "preview" &&
      [
        env.PRODUCTION_DATABASE_FINGERPRINT,
        env.PRODUCTION_SUPABASE_FINGERPRINT,
      ].every(
        (pin) =>
          typeof pin === "string" &&
          /^[a-f0-9]{12}(\s*,\s*[a-f0-9]{12})*$/.test(pin),
      ) &&
      !env.DANGEROUSLY_ALLOW_PRODUCTION_DB_MIGRATION_FROM_NONPRODUCTION &&
      !env.MIGRATION_BREAK_GLASS_REASON &&
      !env.MIGRATIONS_BASELINE_THROUGH &&
      !env.MIGRATIONS_BASELINE_EXCEPT,
    "UNSAFE_ENVIRONMENT",
    "Use preview labels and verified production pins, with no break-glass or baseline settings.",
  );
  const migrationGuard = evaluateMigrationGuard(env);
  const runtimeGuard = evaluateRuntimeDataPathGuard(env);
  requireCondition(
    migrationGuard.allowed &&
      runtimeGuard.safe &&
      runtimeGuard.deploymentTier === "preview",
    "ENVIRONMENT_GUARD_REFUSED",
    "The existing migration/runtime guards refused this preview target.",
  );
  let payload;
  if (env.SUPABASE_ACCESS_TOKEN?.trim()) {
    let response;
    try {
      response = await fetchImpl(
        `https://api.supabase.com/v1/projects/${parentProjectRef}/branches`,
        {
          headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        },
      );
    } catch {
      throw new PreviewSetupError(
        "IDENTITY_UNAVAILABLE",
        "Could not verify Supabase branch identity.",
      );
    }
    requireCondition(
      response.ok,
      "IDENTITY_UNAVAILABLE",
      "Supabase did not authorize the branch identity check.",
    );
    try {
      payload = await response.json();
    } catch {
      throw new PreviewSetupError(
        "IDENTITY_UNAVAILABLE",
        "Supabase branch metadata was not valid JSON.",
      );
    }
  } else {
    // Reuse CLI login without reading/exporting its stored access token.
    // Exclude target/API overrides and unrelated provider/DB secrets.
    const cliEnvironment = Object.fromEntries(
      Object.entries(env).filter(([name]) =>
        /^(path|systemroot|windir|temp|tmp|userprofile|home|homedrive|homepath|appdata|localappdata|xdg_config_home)$/i.test(
          name,
        ),
      ),
    );
    try {
      const { stdout } = await execFileImpl(
        process.platform === "win32" ? "supabase.exe" : "supabase",
        [
          "branches",
          "list",
          "--project-ref",
          parentProjectRef,
          "--output",
          "json",
          "--agent",
          "no",
        ],
        {
          env: cliEnvironment,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      payload = JSON.parse(stdout);
    } catch {
      throw new PreviewSetupError(
        "AUTH_REQUIRED",
        "Authenticate with supabase login or provide SUPABASE_ACCESS_TOKEN through a protected environment; branch metadata could not be verified.",
      );
    }
  }
  const branches = Array.isArray(payload) ? payload : payload?.branches;
  const branch = Array.isArray(branches)
    ? branches.find((candidate) => candidate.id === branchId)
    : undefined;
  requireCondition(
    branch?.project_ref === projectRef &&
      branch.parent_project_ref === parentProjectRef &&
      branch.is_default === false &&
      branch.with_data === false,
    "NOT_DISPOSABLE_PREVIEW",
    "The selected target must be a non-default branch created without production data.",
  );
  return {
    projectRef,
    branchId,
    parentProjectRef,
    branchName: branch.name,
    databaseFingerprint: fingerprintDatabaseUrl(env.DATABASE_URL).fingerprint,
    supabaseFingerprint: fingerprintDatabaseUrl(env.SUPABASE_URL).fingerprint,
  };
}

const OBJECTS_SQL = `
  SELECT n.nspname AS schema_name, c.relname AS name, c.relkind::text AS kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('resupply', 'resupply_auth', 'public', 'migrations', 'drizzle')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
      AND d.objid = c.oid AND d.deptype = 'e')
  UNION ALL
  SELECT n.nspname, p.proname, 'function'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('resupply', 'resupply_auth', 'public')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT n.nspname, t.typname, 'type'
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname IN ('resupply', 'resupply_auth', 'public') AND t.typtype IN ('e', 'd', 'r')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
      AND d.objid = t.oid AND d.deptype = 'e')`;

export async function inspectPreviewDatabase(client, migrations) {
  const objects = (await client.query(OBJECTS_SQL)).rows;
  const ledgerSchema = ["migrations", "drizzle"].find((schema) =>
    objects.some(
      (object) =>
        object.schema_name === schema &&
        object.name === "resupply_migrations" &&
        object.kind === "r",
    ),
  );
  const hashes = ledgerSchema
    ? (
        await client.query(
          `SELECT hash FROM "${ledgerSchema}".resupply_migrations`,
        )
      ).rows.map((row) => row.hash)
    : [];
  const applied = new Set(hashes);
  const expected = new Set(migrations.map((migration) => migration.hash));
  const missingMigrations = migrations
    .filter((migration) => !applied.has(migration.hash))
    .map((migration) => migration.tag);
  const unknownHashes = [...applied].filter(
    (hash) => !expected.has(hash),
  ).length;
  const appObjects = objects.filter(
    (object) =>
      !(
        ["migrations", "drizzle"].includes(object.schema_name) &&
        ["resupply_migrations", "resupply_migrations_id_seq"].includes(
          object.name,
        )
      ),
  );
  const missingTables = REQUIRED_TABLES.filter(
    (table) =>
      !objects.some(
        (object) =>
          `${object.schema_name}.${object.name}` === table &&
          ["r", "p"].includes(object.kind),
      ),
  );
  let status;
  if (unknownHashes || (!applied.size && appObjects.length))
    status = "RESET_REQUIRED";
  else if (missingMigrations.length) status = "MIGRATIONS_REQUIRED";
  else if (missingTables.length) status = "SCHEMA_INCOMPLETE";
  else status = "READY";
  return {
    status,
    ledgerSchema: ledgerSchema ?? null,
    appliedMigrationHashes: applied.size,
    expectedMigrations: migrations.length,
    missingMigrations,
    unknownMigrationHashes: unknownHashes,
    applicationObjects: appObjects.length,
    missingTables,
  };
}

const GRANTS_SQL = `
  GRANT USAGE ON SCHEMA resupply, resupply_auth, public TO service_role;
  -- Managed extension objects can have a different owner. Only grant application objects.
  DO $preview_grants$
  DECLARE grant_statement text;
  BEGIN
    FOR grant_statement IN
      SELECT format('GRANT ALL ON %s %I.%I TO service_role',
        CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, n.nspname, c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('resupply', 'resupply_auth', 'public')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid AND d.deptype = 'e')
      UNION ALL
      SELECT format('GRANT ALL ON ROUTINE %I.%I(%s) TO service_role',
        n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('resupply', 'resupply_auth', 'public')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid AND d.deptype = 'e')
    LOOP
      EXECUTE grant_statement;
    END LOOP;
  END
  $preview_grants$;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA resupply, resupply_auth, public
    GRANT ALL ON TABLES TO service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA resupply, resupply_auth, public
    GRANT ALL ON SEQUENCES TO service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA resupply, resupply_auth, public
    GRANT ALL ON FUNCTIONS TO service_role;`;

export async function inspectRuntimeGrants(client) {
  const { rows } = await client.query(`
    SELECT
      has_schema_privilege('service_role', 'resupply', 'USAGE') AND
      has_schema_privilege('service_role', 'resupply_auth', 'USAGE') AND
      has_schema_privilege('service_role', 'public', 'USAGE') AS schemas,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('resupply', 'resupply_auth', 'public') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid AND d.deptype = 'e')
          AND NOT (has_table_privilege('service_role', c.oid, 'SELECT')
            AND has_table_privilege('service_role', c.oid, 'INSERT')
            AND has_table_privilege('service_role', c.oid, 'UPDATE')
            AND has_table_privilege('service_role', c.oid, 'DELETE'))) AS tables,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('resupply', 'resupply_auth', 'public') AND c.relkind = 'S'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid AND d.deptype = 'e')
          AND NOT (has_sequence_privilege('service_role', c.oid, 'USAGE')
            AND has_sequence_privilege('service_role', c.oid, 'SELECT')
            AND has_sequence_privilege('service_role', c.oid, 'UPDATE'))) AS sequences,
      NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('resupply', 'resupply_auth', 'public')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid AND d.deptype = 'e')
          AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) AS functions,
      (SELECT count(*) = 24 FROM pg_default_acl a
        JOIN pg_namespace n ON n.oid = a.defaclnamespace
        CROSS JOIN LATERAL aclexplode(a.defaclacl) acl
        WHERE n.nspname IN ('resupply', 'resupply_auth', 'public')
          AND a.defaclrole = 'postgres'::regrole
          AND a.defaclobjtype IN ('r', 'S', 'f')
          AND acl.grantee = 'service_role'::regrole
          AND acl.privilege_type = ANY (CASE a.defaclobjtype
            WHEN 'r' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
            WHEN 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
            ELSE ARRAY['EXECUTE'] END)) AS defaults`);
  return rows[0];
}

export async function runPreviewInitialization(options, dependencies = {}) {
  const identity = await assertPreviewIdentity(options, dependencies);
  const migrations = dependencies.readMigrations
    ? await dependencies.readMigrations()
    : (
        await import("../../lib/resupply-db/scripts/migrate.mjs")
      ).readMigrations(
        fileURLToPath(
          new URL("../../lib/resupply-db/migrations", import.meta.url),
        ),
      );
  requireCondition(
    migrations.length > 0,
    "NO_MIGRATIONS",
    "The authoritative migration chain is empty.",
  );
  const createClient =
    dependencies.createClient ??
    (() => {
      const require = createRequire(
        new URL("../../lib/resupply-db/package.json", import.meta.url),
      );
      const { Client } = require("pg");
      return new Client({
        connectionString: options.env.DATABASE_URL,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000,
        application_name: "pennfit-preview-init",
      });
    });
  const client = createClient();
  let transaction = false;
  try {
    await client.connect();
    await client.query(
      options.apply
        ? "BEGIN"
        : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transaction = true;
    if (options.apply) {
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    }
    const schema = await inspectPreviewDatabase(client, migrations);
    let grants = null;
    if (schema.status === "READY") {
      if (options.apply) await client.query(GRANTS_SQL);
      grants = await inspectRuntimeGrants(client);
      if (
        options.apply &&
        !Object.values(grants).every((value) => value === true)
      ) {
        throw new PreviewSetupError(
          "GRANTS_INCOMPLETE",
          "Preview grants failed verification; changes rolled back.",
        );
      }
    }
    await client.query("COMMIT");
    transaction = false;
    return {
      ...identity,
      ...schema,
      status:
        schema.status === "READY" &&
        !Object.values(grants ?? {}).every((value) => value === true)
          ? "GRANTS_REQUIRED"
          : schema.status,
      grants,
      grantsApplied: options.apply === true && schema.status === "READY",
    };
  } finally {
    if (transaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve the setup failure. */
      }
    }
    await client.end();
  }
}

export function parsePreviewArgs(args, env = process.env) {
  const values = new Map();
  const allowed = new Set([
    "project-ref",
    "branch-id",
    "parent-project-ref",
    "confirm-disposable-project",
  ]);
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--apply-grants") {
      apply = true;
      continue;
    }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    requireCondition(
      match && allowed.has(match[1]) && !values.has(match[1]),
      "INVALID_ARGUMENT",
      "Unknown or duplicate preview setup argument.",
    );
    const value = match[2] ?? args[++index];
    requireCondition(
      value && !value.startsWith("--"),
      "INVALID_ARGUMENT",
      "Preview setup argument is missing its value.",
    );
    values.set(match[1], value);
  }
  return {
    env,
    projectRef: values.get("project-ref"),
    branchId: values.get("branch-id"),
    parentProjectRef:
      values.get("parent-project-ref") ?? PRODUCTION_PROJECT_REF,
    confirmDisposableProject: values.get("confirm-disposable-project"),
    apply,
  };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: node scripts/preview/init.mjs --project-ref <preview-ref> --branch-id <branch-id> [--parent-project-ref <parent-ref>] [--apply-grants --confirm-disposable-project <preview-ref>]\nDefault: read-only checks. Requires protected DATABASE_URL (direct/session port 5432), SUPABASE_URL, CLI login or SUPABASE_ACCESS_TOKEN, preview labels and production fingerprint pins. Never resets or runs migrations.\n",
    );
  } else {
    try {
      const result = await runPreviewInitialization(
        parsePreviewArgs(process.argv.slice(2)),
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== "READY") process.exitCode = 2;
    } catch (error) {
      // DB/HTTP errors may contain connection strings or tokens. Never echo them.
      process.stderr.write(
        `${JSON.stringify({
          status:
            error instanceof PreviewSetupError ? error.code : "CHECK_FAILED",
          message:
            error instanceof PreviewSetupError
              ? error.message
              : "Preview setup failed; credentials and remote error details were suppressed.",
        })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
