import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { admin, buildQuery } = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  buildQuery: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () => makeRequireAdminMock(admin));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: async () => true,
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getOrgScopedClient: (orgId: string) =>
      actual.getOrgScopedClient(orgId, {
        schema: () => ({ from: buildQuery }),
      } as unknown as Parameters<typeof actual.getOrgScopedClient>[1]),
  };
});

import router from "./resupply-calendar";

const patientId = "11111111-1111-4111-8111-111111111111";
const rxId = "22222222-2222-4222-8222-222222222222";
const episodeId = (n: number) =>
  `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
let database: PGlite;
let episodeReads = 0;

// Execute the route's fluent filters against real PostgreSQL. In particular,
// OFFSET and a cursor must observe the same row disappearing between pages.
class PgQuery {
  private readonly filters: string[] = [];
  private readonly values: unknown[] = [];
  private readonly ordering: string[] = [];
  private offset = 0;
  private count = 1000;
  constructor(private readonly table: string) {}
  select() {
    return this;
  }
  private where(column: string, operator: string, value: unknown) {
    this.values.push(value);
    this.filters.push(`"${column}" ${operator} $${this.values.length}`);
    return this;
  }
  eq(column: string, value: unknown) {
    return this.where(column, "=", value);
  }
  gt(column: string, value: unknown) {
    return this.where(column, ">", value);
  }
  gte(column: string, value: unknown) {
    return this.where(column, ">=", value);
  }
  lt(column: string, value: unknown) {
    return this.where(column, "<", value);
  }
  in(column: string, values: unknown[]) {
    const parameters = values.map((value) => {
      this.values.push(value);
      return `$${this.values.length}`;
    });
    this.filters.push(`"${column}" IN (${parameters.join(",")})`);
    return this;
  }
  or(expression: string) {
    const match = /^expires_at\.is\.null,expires_at\.gt\.(.+)$/.exec(
      expression,
    );
    if (!match) throw new Error("Unexpected test query disjunction");
    this.values.push(match[1]);
    this.filters.push(
      `(expires_at IS NULL OR expires_at > $${this.values.length})`,
    );
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.ordering.push(
      `"${column}" ${options?.ascending === false ? "DESC" : "ASC"}`,
    );
    return this;
  }
  range(from: number, to: number) {
    this.offset = from;
    this.count = to - from + 1;
    return this;
  }
  limit(count: number) {
    this.count = count;
    return this;
  }
  then<T>(
    resolve: (value: { data: unknown[]; error: null }) => T | PromiseLike<T>,
    reject?: (reason: unknown) => T | PromiseLike<T>,
  ) {
    return this.run().then(resolve, reject);
  }
  private async run() {
    if (this.table === "frequency_rules") return { data: [], error: null };
    if (!["episodes", "patients", "prescriptions"].includes(this.table))
      throw new Error("Unexpected test table");
    const result = await database.query(
      `SELECT * FROM ${this.table} WHERE ${this.filters.join(" AND ")}${
        this.ordering.length ? ` ORDER BY ${this.ordering.join(",")}` : ""
      } LIMIT ${this.count} OFFSET ${this.offset}`,
      this.values,
    );
    if (this.table === "episodes" && ++episodeReads === 1) {
      // A worker finishes an already-returned cycle while the CSR's calendar
      // continues loading. Its removal must not shift the final patient away.
      await database.query(
        "UPDATE episodes SET status = 'fulfilled' WHERE id = $1",
        [episodeId(1)],
      );
    }
    return {
      data: JSON.parse(JSON.stringify(result.rows)) as unknown[],
      error: null,
    };
  }
}

beforeAll(async () => {
  database = new PGlite();
  await database.waitReady;
  await database.exec(`
    CREATE TABLE episodes (id uuid PRIMARY KEY, org_id uuid, patient_id uuid,
      prescription_id uuid, status text, due_at timestamptz, expires_at timestamptz);
    CREATE TABLE patients (id uuid PRIMARY KEY, org_id uuid, legal_first_name text,
      legal_last_name text, status text, phone_e164 text, email text,
      channel_preference text, created_at timestamptz, insurance_payer text,
      cadence_override_days integer);
    CREATE TABLE prescriptions (id uuid PRIMARY KEY, org_id uuid, patient_id uuid,
      item_sku text, cadence_days integer, status text, valid_until date,
      created_at timestamptz);
  `);
  await database.query(
    "INSERT INTO patients (id, org_id, legal_first_name, legal_last_name, status) VALUES ($1, $2, 'Jane', 'Example', 'active')",
    [patientId, MOCK_ORG_ID],
  );
  await database.query(
    "INSERT INTO prescriptions (id, org_id, patient_id, item_sku, cadence_days, status) VALUES ($1, $2, $3, 'MASK', 30, 'active')",
    [rxId, MOCK_ORG_ID, patientId],
  );
  await database.query(
    `INSERT INTO episodes
    SELECT ('33333333-3333-4333-8333-' || lpad(n::text, 12, '0'))::uuid,
      $1::uuid, $2::uuid, $3::uuid, 'outreach_pending',
      '2026-09-10T12:00:00Z'::timestamptz, NULL
    FROM generate_series(1, 201) n`,
    [MOCK_ORG_ID, patientId, rxId],
  );
  buildQuery.mockImplementation((table: string) => new PgQuery(table));
  admin.current = { userId: "csr", email: "csr@example.test", role: "agent" };
}, 30_000);
afterAll(async () => {
  await database?.close();
});

it("does not skip the last cycle when an earlier page changes while loading", async () => {
  const result = await request(express().use(router)).get(
    "/admin/resupply-calendar?from=2026-09-01T04:00:00.000Z&to=2026-10-01T04:00:00.000Z",
  );
  expect(result.status).toBe(200);
  expect(result.body.items).toHaveLength(201);
  expect(
    result.body.items.some(
      (item: { id: string }) => item.id === episodeId(201),
    ),
  ).toBe(true);
  expect(
    new Set(result.body.items.map((item: { id: string }) => item.id)).size,
  ).toBe(201);
  expect(episodeReads).toBe(2);
});
