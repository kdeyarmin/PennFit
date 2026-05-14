// Tests for run-migrations-individually.mjs
//
// The script is a self-contained diagnostic executable — all logic runs at
// the top level using top-level await, and nothing is exported.  We drive it
// by mocking its two external dependencies (node:fs and pg) before each
// dynamic import, then inspect what the mocks were called with and what was
// written to stdout.
//
// vi.mock() calls are hoisted by vitest so they are in place before any
// import, but the factory only installs the stub; per-test behaviour is set
// through the module-level mock objects (mockClient, mockPool, mockFs).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Shared mock state — mutated before each test, read by the vi.mock factories
// ---------------------------------------------------------------------------

/** Accumulates every call made to client.query in order. */
const queryCalls: Array<{ sql: string }> = [];

/** Accumulates every call made to fs.readFileSync in order. */
const fsCalls: Array<{ filePath: string; encoding: string }> = [];

/** Map from absolute SQL file path → SQL text. */
const sqlFiles: Map<string, string> = new Map();

/** The journal JSON to return from the journal file readFileSync call. */
let journalPayload: object = { entries: [] };

// ---------------------------------------------------------------------------
// Mock: pg
// ---------------------------------------------------------------------------

const mockRelease = vi.fn();
const mockEnd = vi.fn();

// query is initialised as vi.fn() with no implementation; beforeEach installs
// the default behaviour (record calls, return {rows: []}) so each test starts
// clean — including tests that override the implementation for specific SQLs.
const mockClient = {
  query: vi.fn<[string], Promise<{ rows: unknown[] }>>(),
  release: mockRelease,
};

const mockPool = {
  connect: vi.fn().mockResolvedValue(mockClient),
  end: mockEnd,
};

vi.mock("pg", () => {
  return {
    default: {
      Pool: vi.fn(() => mockPool),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: node:fs
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => {
  return {
    default: {
      readFileSync: vi.fn((filePath: string, encoding: string) => {
        fsCalls.push({ filePath, encoding });

        // Journal file (ends with _journal.json)
        if (filePath.endsWith("_journal.json")) {
          return JSON.stringify(journalPayload);
        }

        // SQL migration file
        const result = sqlFiles.get(filePath);
        if (result !== undefined) return result;

        // Default: return an empty SQL string
        return "";
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(
  __dirname,
  "run-migrations-individually.mjs",
);

/** Build the absolute SQL file path the script would construct for a tag. */
function tagToFilePath(tag: string): string {
  // The script builds: path.join(drizzleDir, entry.tag + ".sql")
  // drizzleDir is hardcoded as /home/user/PennFit/lib/resupply-db/drizzle
  return path.join(
    "/home/user/PennFit/lib/resupply-db/drizzle",
    `${tag}.sql`,
  );
}

/** Dynamically import the script, triggering its top-level execution. */
async function runScript(): Promise<void> {
  vi.resetModules();
  await import(SCRIPT_PATH);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let consoleLogSpy: MockInstance;

beforeEach(() => {
  // Reset per-test state
  queryCalls.length = 0;
  fsCalls.length = 0;
  sqlFiles.clear();
  journalPayload = { entries: [] };

  // mockReset clears both recorded calls AND any mockImplementation installed
  // by the previous test, so each test starts with the default query behaviour.
  mockClient.query.mockReset();
  mockClient.query.mockImplementation(async (sql: string) => {
    queryCalls.push({ sql });
    return { rows: [] };
  });
  mockRelease.mockReset();
  mockEnd.mockReset().mockResolvedValue(undefined);
  mockPool.connect.mockReset().mockResolvedValue(mockClient);

  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run-migrations-individually.mjs", () => {
  it("pre-creates the auth schema before iterating migrations", async () => {
    journalPayload = { entries: [] };
    await runScript();

    const sqlTexts = queryCalls.map((c) => c.sql);
    expect(sqlTexts).toContain(`CREATE SCHEMA IF NOT EXISTS "auth"`);
  });

  it("pre-creates the drizzle schema before iterating migrations", async () => {
    journalPayload = { entries: [] };
    await runScript();

    const sqlTexts = queryCalls.map((c) => c.sql);
    expect(sqlTexts).toContain(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  });

  it("creates auth schema before drizzle schema", async () => {
    journalPayload = { entries: [] };
    await runScript();

    const sqlTexts = queryCalls.map((c) => c.sql);
    const authIdx = sqlTexts.indexOf(`CREATE SCHEMA IF NOT EXISTS "auth"`);
    const drizzleIdx = sqlTexts.indexOf(
      `CREATE SCHEMA IF NOT EXISTS "drizzle"`,
    );
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(drizzleIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(drizzleIdx);
  });

  it("reads the journal file and reads each migration SQL file", async () => {
    journalPayload = {
      entries: [
        { idx: 0, tag: "0000_initial" },
        { idx: 1, tag: "0001_add_patients" },
      ],
    };
    sqlFiles.set(tagToFilePath("0000_initial"), "CREATE TABLE foo (id int);");
    sqlFiles.set(
      tagToFilePath("0001_add_patients"),
      "ALTER TABLE foo ADD COLUMN name text;",
    );

    await runScript();

    // Each migration's SQL file must have been read.
    const readPaths = fsCalls
      .filter((c) => !c.filePath.endsWith("_journal.json"))
      .map((c) => c.filePath);
    expect(readPaths).toContain(tagToFilePath("0000_initial"));
    expect(readPaths).toContain(tagToFilePath("0001_add_patients"));
  });

  it("wraps each migration in a BEGIN / COMMIT transaction", async () => {
    journalPayload = {
      entries: [{ idx: 0, tag: "0000_initial" }],
    };
    sqlFiles.set(tagToFilePath("0000_initial"), "CREATE TABLE foo (id int);");

    await runScript();

    const sqlTexts = queryCalls.map((c) => c.sql);
    expect(sqlTexts).toContain("BEGIN");
    expect(sqlTexts).toContain("COMMIT");
    // BEGIN must precede COMMIT
    expect(sqlTexts.indexOf("BEGIN")).toBeLessThan(
      sqlTexts.indexOf("COMMIT"),
    );
  });

  it("runs the migration SQL between BEGIN and COMMIT", async () => {
    const migrationSql = "CREATE TABLE patients (id serial PRIMARY KEY);";
    journalPayload = {
      entries: [{ idx: 0, tag: "0000_initial" }],
    };
    sqlFiles.set(tagToFilePath("0000_initial"), migrationSql);

    await runScript();

    const sqlTexts = queryCalls.map((c) => c.sql);
    const beginIdx = sqlTexts.indexOf("BEGIN");
    const commitIdx = sqlTexts.indexOf("COMMIT");
    const sqlIdx = sqlTexts.indexOf(migrationSql);
    expect(sqlIdx).toBeGreaterThan(beginIdx);
    expect(sqlIdx).toBeLessThan(commitIdx);
  });

  it("reports zero failures when all migrations succeed", async () => {
    journalPayload = {
      entries: [
        { idx: 0, tag: "0000_initial" },
        { idx: 1, tag: "0001_add_patients" },
      ],
    };
    sqlFiles.set(tagToFilePath("0000_initial"), "SELECT 1;");
    sqlFiles.set(tagToFilePath("0001_add_patients"), "SELECT 2;");

    await runScript();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failures: 0"),
    );
  });

  it("rolls back on a migration SQL error and records the failure", async () => {
    const badSql = "THIS IS NOT VALID SQL;";
    journalPayload = {
      entries: [{ idx: 7, tag: "0007_broken" }],
    };
    sqlFiles.set(tagToFilePath("0007_broken"), badSql);

    // Make the bad SQL query throw
    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === badSql) throw new Error("syntax error at position 1");
      return { rows: [] };
    });

    await runScript();

    // ROLLBACK must have been issued
    const sqlTexts = queryCalls.map((c) => c.sql);
    expect(sqlTexts).toContain("ROLLBACK");

    // Failure must be reported
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failures: 1"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[7]"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("0007_broken"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("syntax error at position 1"),
    );
  });

  it("continues processing subsequent migrations after a failure", async () => {
    const badSql = "INVALID SQL;";
    const goodSql = "SELECT 1;";
    journalPayload = {
      entries: [
        { idx: 0, tag: "0000_bad" },
        { idx: 1, tag: "0001_good" },
      ],
    };
    sqlFiles.set(tagToFilePath("0000_bad"), badSql);
    sqlFiles.set(tagToFilePath("0001_good"), goodSql);

    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === badSql) throw new Error("relation does not exist");
      return { rows: [] };
    });

    await runScript();

    // Both migration SQL files must have been attempted.
    const sqlTexts = queryCalls.map((c) => c.sql);
    expect(sqlTexts).toContain(badSql);
    expect(sqlTexts).toContain(goodSql);

    // One failure, not two.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failures: 1"),
    );
  });

  it("accumulates multiple failures across several broken migrations", async () => {
    journalPayload = {
      entries: [
        { idx: 2, tag: "0002_bad_a" },
        { idx: 5, tag: "0005_bad_b" },
      ],
    };
    sqlFiles.set(tagToFilePath("0002_bad_a"), "BAD A;");
    sqlFiles.set(tagToFilePath("0005_bad_b"), "BAD B;");

    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === "BAD A;" || sql === "BAD B;")
        throw new Error(`error in ${sql}`);
      return { rows: [] };
    });

    await runScript();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failures: 2"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[2]"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[5]"),
    );
  });

  it("always releases the client even when a migration throws", async () => {
    journalPayload = {
      entries: [{ idx: 0, tag: "0000_bad" }],
    };
    sqlFiles.set(tagToFilePath("0000_bad"), "BOOM;");

    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === "BOOM;") throw new Error("kaboom");
      return { rows: [] };
    });

    await runScript();

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("always ends the pool even when a migration throws", async () => {
    journalPayload = {
      entries: [{ idx: 0, tag: "0000_bad" }],
    };
    sqlFiles.set(tagToFilePath("0000_bad"), "BOOM;");

    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === "BOOM;") throw new Error("kaboom");
      return { rows: [] };
    });

    await runScript();

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("silently swallows a ROLLBACK failure and still records the migration error", async () => {
    const badSql = "BREAK;";
    journalPayload = {
      entries: [{ idx: 3, tag: "0003_break" }],
    };
    sqlFiles.set(tagToFilePath("0003_break"), badSql);

    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === badSql) throw new Error("original error");
      // Make ROLLBACK itself fail too
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [] };
    });

    // The script should not throw — ROLLBACK error is caught with .catch(() => {})
    await expect(runScript()).resolves.toBeUndefined();

    // The original error must still be recorded in failures
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failures: 1"),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("original error"),
    );
  });

  it("logs failure details in [idx] tag: message format", async () => {
    journalPayload = {
      entries: [{ idx: 42, tag: "0042_specific" }],
    };
    sqlFiles.set(tagToFilePath("0042_specific"), "WRONG;");

    mockClient.query.mockImplementation(async (sql: string) => {
      queryCalls.push({ sql });
      if (sql === "WRONG;") throw new Error("column does not exist");
      return { rows: [] };
    });

    await runScript();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[42\].*0042_specific.*column does not exist/),
    );
  });

  it("handles an empty journal (no entries) without error", async () => {
    journalPayload = { entries: [] };

    await expect(runScript()).resolves.toBeUndefined();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failures: 0"),
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});
