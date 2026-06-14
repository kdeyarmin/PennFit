// Two-tenant leakage test for the org-scoped chokepoint.
//
// org-scoped-client.test.ts proves the facade appends the org_id filter
// and tags write payloads. This file goes one step further: it stands up
// a SHARED in-memory store holding rows for two tenants and drives it
// only through `getOrgScopedClient(org)`, asserting that tenant A can
// never read, update, or delete tenant B's rows, that a forged org_id on
// an insert is overridden, and that `.raw()` is the only way to cross the
// boundary. This is the behavioural regression guard for tenant
// isolation — independent of how many callsites have been cut over.

import { describe, expect, it, beforeEach } from "vitest";

import { getOrgScopedClient, ORG_COLUMN } from "./org-scoped-client";
import type { ResupplySupabaseClient } from "./supabase-client";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

interface QueryResult {
  data: Row[] | null;
  error: null;
}

/**
 * A tiny in-memory stand-in for the PostgREST builder that ACTUALLY
 * stores + filters rows, so a cross-tenant read returns the wrong-tenant
 * rows iff isolation is broken. Honors the accumulated `.eq(col, val)`
 * conjunction (the facade adds `.eq("org_id", org)`; callers add their
 * own `.eq("id", …)`), and is thenable so `await db.from(t).select(...)`
 * resolves to `{ data, error }`.
 */
class FakeBuilder implements PromiseLike<QueryResult> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" | null =
    null;
  private payload: unknown;
  private readonly filters: Array<{ column: string; value: unknown }> = [];

  constructor(
    private readonly store: Store,
    private readonly table: string,
  ) {}

  private rows(): Row[] {
    let list = this.store.get(this.table);
    if (!list) {
      list = [];
      this.store.set(this.table, list);
    }
    return list;
  }

  select(_columns?: string, _options?: unknown): this {
    if (this.op === null) this.op = "select";
    return this;
  }
  insert(values: unknown): this {
    this.op = "insert";
    this.payload = values;
    return this;
  }
  update(values: unknown): this {
    this.op = "update";
    this.payload = values;
    return this;
  }
  upsert(values: unknown): this {
    this.op = "upsert";
    this.payload = values;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }
  // Chain no-ops the facade/callers may tack on.
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => row[f.column] === f.value);
  }

  private run(): QueryResult {
    const rows = this.rows();
    switch (this.op) {
      case "insert":
      case "upsert": {
        const incoming = Array.isArray(this.payload)
          ? (this.payload as Row[])
          : [this.payload as Row];
        rows.push(...incoming.map((r) => ({ ...r })));
        return { data: incoming, error: null };
      }
      case "update": {
        const matched = rows.filter((r) => this.matches(r));
        for (const r of matched) Object.assign(r, this.payload as Row);
        return { data: matched, error: null };
      }
      case "delete": {
        const kept: Row[] = [];
        const removed: Row[] = [];
        for (const r of rows) (this.matches(r) ? removed : kept).push(r);
        this.store.set(this.table, kept);
        return { data: removed, error: null };
      }
      case "select":
      default:
        return { data: rows.filter((r) => this.matches(r)), error: null };
    }
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function makeSharedClient(store: Store): ResupplySupabaseClient {
  return {
    schema() {
      return {
        from(table: string) {
          return new FakeBuilder(store, table);
        },
      };
    },
  } as unknown as ResupplySupabaseClient;
}

describe("getOrgScopedClient — two-tenant isolation (shared store)", () => {
  let store: Store;
  let client: ResupplySupabaseClient;

  beforeEach(async () => {
    store = new Map();
    client = makeSharedClient(store);
    // Seed one row per tenant through the scoped clients themselves.
    await getOrgScopedClient(ORG_A, client)
      .from("patients")
      .insert({ id: "a1", legal_first_name: "Ada" });
    await getOrgScopedClient(ORG_B, client)
      .from("patients")
      .insert({ id: "b1", legal_first_name: "Bo" });
  });

  it("seeds each row tagged with its own tenant", () => {
    const rows = store.get("patients")!;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "a1")![ORG_COLUMN]).toBe(ORG_A);
    expect(rows.find((r) => r.id === "b1")![ORG_COLUMN]).toBe(ORG_B);
  });

  it("a tenant's SELECT returns only its own rows", async () => {
    const { data: aRows } = await getOrgScopedClient(ORG_A, client)
      .from("patients")
      .select("*");
    expect(aRows?.map((r: Row) => r.id)).toEqual(["a1"]);

    const { data: bRows } = await getOrgScopedClient(ORG_B, client)
      .from("patients")
      .select("*");
    expect(bRows?.map((r: Row) => r.id)).toEqual(["b1"]);
  });

  it("a SELECT filtered by the OTHER tenant's row id still returns nothing", async () => {
    const { data } = await getOrgScopedClient(ORG_A, client)
      .from("patients")
      .select("*")
      .eq("id", "b1");
    expect(data).toEqual([]);
  });

  it("a tenant cannot UPDATE the other tenant's row (0 matched, row untouched)", async () => {
    const { data: updated } = await getOrgScopedClient(ORG_A, client)
      .from("patients")
      .update({ legal_first_name: "HACKED" })
      .eq("id", "b1");
    expect(updated).toEqual([]); // no cross-tenant match

    const bRow = store.get("patients")!.find((r) => r.id === "b1")!;
    expect(bRow.legal_first_name).toBe("Bo"); // unchanged
  });

  it("a tenant cannot DELETE the other tenant's rows", async () => {
    await getOrgScopedClient(ORG_A, client).from("patients").delete();
    const remaining = store.get("patients")!;
    expect(remaining.map((r: Row) => r.id)).toEqual(["b1"]); // B survives A's delete
  });

  it("a forged org_id on insert is overridden with the bound tenant", async () => {
    await getOrgScopedClient(ORG_A, client)
      .from("patients")
      .insert({ id: "a2", [ORG_COLUMN]: ORG_B, legal_first_name: "Mallory" });
    // The forged row lands under A, and B still can't see it.
    const { data: bRows } = await getOrgScopedClient(ORG_B, client)
      .from("patients")
      .select("*");
    expect(bRows?.map((r: Row) => r.id)).toEqual(["b1"]);
    const a2 = store.get("patients")!.find((r) => r.id === "a2")!;
    expect(a2[ORG_COLUMN]).toBe(ORG_A);
  });

  it(".raw() is the only way out — it returns the unscoped client", async () => {
    const raw = getOrgScopedClient(ORG_A, client).raw();
    expect(raw).toBe(client);
    // Proof it is genuinely unscoped: a raw read sees BOTH tenants.
    const { data } = (await raw
      .schema("resupply")
      .from("patients")
      .select("*")) as unknown as QueryResult;
    expect(data?.map((r: Row) => r.id)?.sort()).toEqual(["a1", "b1"]);
  });
});
