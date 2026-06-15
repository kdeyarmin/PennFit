import { describe, expect, it } from "vitest";

import {
  getOrgScopedClient,
  listActiveOrgIds,
  ORG_COLUMN,
} from "./org-scoped-client";
import type { ResupplySupabaseClient } from "./supabase-client";

// A recording fake of the slice of the Supabase client the facade
// touches: `client.schema("resupply").from(table).{select,insert,...}`.
// Each terminal builder records the call + any `.eq(...)` chained onto
// it, and `.eq` returns the same recorder so native chaining keeps
// working exactly as the real fluent builder does.
const ORG = "11111111-1111-1111-1111-111111111111";

interface EqCall {
  column: string;
  value: unknown;
}

class RecordingBuilder {
  eqCalls: EqCall[] = [];
  op: string | null = null;
  args: unknown[] = [];

  record(op: string, ...args: unknown[]) {
    this.op = op;
    this.args = args;
    return this;
  }
  select(columns?: string, options?: unknown) {
    return this.record("select", columns, options);
  }
  insert(values: unknown, options?: unknown) {
    return this.record("insert", values, options);
  }
  update(values: unknown, options?: unknown) {
    return this.record("update", values, options);
  }
  upsert(values: unknown, options?: unknown) {
    return this.record("upsert", values, options);
  }
  delete(options?: unknown) {
    return this.record("delete", options);
  }
  eq(column: string, value: unknown) {
    this.eqCalls.push({ column, value });
    return this;
  }
}

interface Captured {
  schema: string | null;
  table: string | null;
  builder: RecordingBuilder;
}

function makeFakeClient(): {
  client: ResupplySupabaseClient;
  captured: Captured;
} {
  const captured: Captured = {
    schema: null,
    table: null,
    builder: new RecordingBuilder(),
  };
  const client = {
    schema(name: string) {
      captured.schema = name;
      return {
        from(table: string) {
          captured.table = table;
          return captured.builder;
        },
      };
    },
  } as unknown as ResupplySupabaseClient;
  return { client, captured };
}

describe("getOrgScopedClient", () => {
  it("throws on an empty / whitespace orgId (fails closed)", () => {
    const { client } = makeFakeClient();
    expect(() => getOrgScopedClient("", client)).toThrow(/non-empty orgId/);
    expect(() => getOrgScopedClient("   ", client)).toThrow(/non-empty orgId/);
  });

  it("exposes the bound orgId and the raw client escape hatch", () => {
    const { client } = makeFakeClient();
    const db = getOrgScopedClient(ORG, client);
    expect(db.orgId).toBe(ORG);
    expect(db.raw()).toBe(client);
  });

  it("targets the resupply schema and requested table", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client).from("patients").select("*");
    expect(captured.schema).toBe("resupply");
    expect(captured.table).toBe("patients");
  });

  it("appends an org_id filter to select", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client).from("patients").select("id, name");
    expect(captured.builder.op).toBe("select");
    expect(captured.builder.args[0]).toBe("id, name");
    expect(captured.builder.eqCalls).toEqual([
      { column: ORG_COLUMN, value: ORG },
    ]);
  });

  it("appends an org_id filter to delete", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client).from("patients").delete();
    expect(captured.builder.op).toBe("delete");
    expect(captured.builder.eqCalls).toEqual([
      { column: ORG_COLUMN, value: ORG },
    ]);
  });

  it("tags a single insert payload with org_id", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client).from("patients").insert({ name: "Ada" });
    expect(captured.builder.op).toBe("insert");
    expect(captured.builder.args[0]).toEqual({
      name: "Ada",
      [ORG_COLUMN]: ORG,
    });
  });

  it("tags every row of an array insert with org_id", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client)
      .from("patients")
      .insert([{ name: "Ada" }, { name: "Bob" }]);
    expect(captured.builder.args[0]).toEqual([
      { name: "Ada", [ORG_COLUMN]: ORG },
      { name: "Bob", [ORG_COLUMN]: ORG },
    ]);
  });

  it("forces org_id onto an insert that tries to set a different tenant", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client)
      .from("patients")
      .insert({ name: "Ada", [ORG_COLUMN]: "other-tenant" });
    expect(
      (captured.builder.args[0] as Record<string, unknown>)[ORG_COLUMN],
    ).toBe(ORG);
  });

  it("scopes update by org_id AND forces org_id onto the patch", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client).from("patients").update({ name: "Ada" });
    expect(captured.builder.op).toBe("update");
    expect(captured.builder.args[0]).toEqual({
      name: "Ada",
      [ORG_COLUMN]: ORG,
    });
    expect(captured.builder.eqCalls).toEqual([
      { column: ORG_COLUMN, value: ORG },
    ]);
  });

  it("tags upsert payloads with org_id", () => {
    const { client, captured } = makeFakeClient();
    getOrgScopedClient(ORG, client)
      .from("patients")
      .upsert([{ id: "1" }]);
    expect(captured.builder.op).toBe("upsert");
    expect(captured.builder.args[0]).toEqual([{ id: "1", [ORG_COLUMN]: ORG }]);
  });
});

// A minimal directory-read fake: `.schema().from().select().eq()` resolves
// to the staged `{ data, error }` envelope (PostgREST select-many shape).
function makeDirectoryClient(result: { data?: unknown; error?: unknown }): {
  client: ResupplySupabaseClient;
  lastEq?: { column: string; value: unknown };
} {
  const state: { lastEq?: { column: string; value: unknown } } = {};
  const builder = {
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      state.lastEq = { column, value };
      return Promise.resolve(result);
    },
  };
  const client = {
    schema() {
      return { from: () => builder };
    },
  } as unknown as ResupplySupabaseClient;
  return {
    client,
    get lastEq() {
      return state.lastEq;
    },
  };
}

describe("listActiveOrgIds", () => {
  it("returns the ids of active tenants, filtering on status = active", async () => {
    const dir = makeDirectoryClient({
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const ids = await listActiveOrgIds(dir.client);
    expect(dir.lastEq).toEqual({ column: "status", value: "active" });
    expect(ids).toEqual(["org-a", "org-b"]);
  });

  it("drops rows with a missing / empty id", async () => {
    const { client } = makeDirectoryClient({
      data: [{ id: "org-a" }, { id: "" }, {}, { id: "org-c" }],
    });
    expect(await listActiveOrgIds(client)).toEqual(["org-a", "org-c"]);
  });

  it("returns [] on a query error (fail-soft, never throws)", async () => {
    const { client } = makeDirectoryClient({ error: { message: "boom" } });
    expect(await listActiveOrgIds(client)).toEqual([]);
  });

  it("returns [] when the directory read throws", async () => {
    const throwingClient = {
      schema() {
        throw new Error("connection refused");
      },
    } as unknown as ResupplySupabaseClient;
    expect(await listActiveOrgIds(throwingClient)).toEqual([]);
  });
});
