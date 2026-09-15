// Unit tests for the code→schema reference extractor (the pure functions).
//
// The DB-touching `run()` path is not covered here (it needs a real
// DATABASE_URL); what is covered is the textual extraction, because that is
// the part that decides whether a real bug is seen at all. Two failure modes
// matter equally:
//
//   * a MISS lets a shipped bug through — the seven this checker was written
//     for were all of that shape, so each one has a test below;
//   * a FALSE POSITIVE trains people to ignore the output, which is worse
//     than not having it. The chain-bounding and non-literal cases exist to
//     pin that behaviour.

import { describe, expect, it } from "vitest";

import {
  extractReferences,
  joinStringLiteral,
  parseFilterString,
  parseSelect,
  stripComments,
} from "./check-code-schema-refs.js";

function columnsOf(source: string): string[] {
  return extractReferences("f.ts", source)
    .refs.filter((r) => r.column)
    .map((r) => `${r.table}.${r.column}`);
}

function tablesOf(source: string): string[] {
  return extractReferences("f.ts", source)
    .refs.filter((r) => !r.column)
    .map((r) => r.table);
}

describe("stripComments", () => {
  it("drops line comments", () => {
    expect(stripComments('const a = 1; // .from("ghost")')).not.toContain(
      "ghost",
    );
  });

  it("drops block comments", () => {
    expect(
      stripComments('/* .from("ghost").select("x") */ const a = 1;'),
    ).not.toContain("ghost");
  });

  it("keeps a // that lives inside a string literal", () => {
    // Clobbering this would corrupt the query chain the URL sits in.
    const out = stripComments('const u = "https://example.test/x"; ');
    expect(out).toContain("https://example.test/x");
  });

  it("preserves line numbering across a multi-line block comment", () => {
    const src = [
      "const a = 1;",
      "/* one",
      "two",
      "three */",
      '.from("t")',
    ].join("\n");
    // The `.from` must still report line 5, not line 2.
    const { refs } = extractReferences("f.ts", src);
    expect(refs[0]?.line).toBe(5);
  });

  it("does not treat an escaped quote as ending the string", () => {
    const out = stripComments('const s = "a\\"b"; // gone');
    expect(out).not.toContain("gone");
    expect(out).toContain('a\\"b');
  });
});

describe("parseSelect", () => {
  it("splits plain columns", () => {
    expect(parseSelect("id, org_id, status").columns).toEqual([
      "id",
      "org_id",
      "status",
    ]);
  });

  it("ignores a bare star", () => {
    expect(parseSelect("*").columns).toEqual([]);
  });

  it("takes the real column from an alias", () => {
    // `alias:column` — the column that must exist is on the right.
    expect(parseSelect("total:amount_cents").columns).toEqual(["amount_cents"]);
  });

  it("strips a cast", () => {
    expect(parseSelect("created_at::text").columns).toEqual(["created_at"]);
  });

  it("keeps only the head of a json path", () => {
    expect(parseSelect("payload->>'x'").columns).toEqual(["payload"]);
  });

  it("reports an embed as an embed, not a column", () => {
    const r = parseSelect("id, fit_sessions(patient_id)");
    expect(r.columns).toEqual(["id"]);
    expect(r.embeds).toEqual(["fit_sessions"]);
  });

  it("does not mistake a nested embed column for a top-level column", () => {
    // The regression that made the fitter-followup assertion wrong: a
    // top-level check must not see `patient_id` from inside the embed.
    const r = parseSelect("id, status, fit_sessions!some_fkey(patient_id)");
    expect(r.columns).toEqual(["id", "status"]);
    expect(r.columns).not.toContain("patient_id");
    expect(r.embeds).toEqual(["fit_sessions"]);
  });

  it("handles an embed carrying an explicit FK hint and inner join", () => {
    const r = parseSelect(
      "id, insurance_claims!claim_denial_analyses_claim_id_fkey!inner(patient_id)",
    );
    expect(r.embeds).toEqual(["insurance_claims"]);
    expect(r.columns).toEqual(["id"]);
  });

  it("tolerates whitespace and newlines between columns", () => {
    expect(parseSelect("\n  id,\n  org_id\n").columns).toEqual([
      "id",
      "org_id",
    ]);
  });
});

describe("parseFilterString", () => {
  it("pulls the column out of each or() clause", () => {
    expect(parseFilterString("status.eq.open,status.is.null")).toEqual([
      "status",
      "status",
    ]);
  });

  it("reads columns inside a nested and() group", () => {
    expect(
      parseFilterString("and(org_id.eq.1,dedupe_hash.not.is.null)"),
    ).toEqual(["org_id", "dedupe_hash"]);
  });

  it("never returns the and/or keywords as columns", () => {
    expect(parseFilterString("or(a.eq.1,b.eq.2)")).not.toContain("or");
  });
});

describe("joinStringLiteral", () => {
  it("reads a single literal", () => {
    expect(joinStringLiteral('"id, org_id"')).toBe("id, org_id");
  });

  it("concatenates adjacent literals", () => {
    expect(joinStringLiteral('"id, " + "org_id"')).toBe("id, org_id");
  });

  it("refuses a template with an interpolation", () => {
    // A select built from a variable cannot be checked; inventing columns
    // from it would produce false positives.
    expect(joinStringLiteral("`id, ${extra}`")).toBeNull();
  });

  it("refuses a bare variable", () => {
    expect(joinStringLiteral("columns")).toBeNull();
  });

  it("refuses a literal concatenated with a variable", () => {
    expect(joinStringLiteral('"id, " + extra')).toBeNull();
  });
});

describe("extractReferences — the seven shipped bugs it must catch", () => {
  it("sees a column selected from the wrong table", () => {
    // shop_orders has no patient_id; this shape shipped twice.
    expect(
      columnsOf('await db.from("shop_orders").select("id, patient_id");'),
    ).toContain("shop_orders.patient_id");
  });

  it("sees a wrong column used in an eq() filter", () => {
    expect(
      columnsOf(
        'await db.from("office_ally_submissions").select("id").eq("created_at", x);',
      ),
    ).toContain("office_ally_submissions.created_at");
  });

  it("sees a wrong column named only inside an or() filter", () => {
    expect(
      columnsOf(
        'await db.from("patients").select("id").or("communication_preferences.is.null");',
      ),
    ).toContain("patients.communication_preferences");
  });

  it("sees a wrong column in a gte()/lte() range filter", () => {
    const cols = columnsOf(
      'await db.from("t").select("id").gte("start_at", a).lte("end_at", b);',
    );
    expect(cols).toEqual(expect.arrayContaining(["t.start_at", "t.end_at"]));
  });

  it("sees a wrong column in an overlaps() filter", () => {
    expect(
      columnsOf(
        'await db.from("office_ally_submissions").select("id").overlaps("attempted_claim_ids", ids);',
      ),
    ).toContain("office_ally_submissions.attempted_claim_ids");
  });

  it("records the table itself so an unknown table is reported", () => {
    expect(tablesOf('await db.from("ghost_table").select("id");')).toEqual([
      "ghost_table",
    ]);
  });

  it("finds an rpc call", () => {
    const { rpcs } = extractReferences(
      "f.ts",
      'await db.rpc("adjust_product_stock", { p_sku: sku });',
    );
    expect(rpcs.map((r) => r.fn)).toEqual(["adjust_product_stock"]);
  });
});

describe("extractReferences — chain bounding (false-positive guards)", () => {
  it("does not attribute a column to the previous query's table", () => {
    // The bug this guards: `status` belongs to orders, not to patients.
    const cols = columnsOf(
      [
        'const a = await db.from("patients").select("id");',
        'const b = await db.from("orders").select("status");',
      ].join("\n"),
    );
    expect(cols).toEqual(["patients.id", "orders.status"]);
  });

  it("keeps a multi-line chain attached to its own table", () => {
    const cols = columnsOf(
      [
        "const r = await db",
        '  .from("insurance_claims")',
        '  .select("id, status")',
        '  .eq("org_id", orgId);',
      ].join("\n"),
    );
    expect(cols).toEqual([
      "insurance_claims.id",
      "insurance_claims.status",
      "insurance_claims.org_id",
    ]);
  });

  it("skips a chain rooted at a variable table name", () => {
    // A helper taking `table` as a parameter is unresolvable; guessing here
    // is what misattributes columns to whatever table came before.
    const { refs } = extractReferences(
      "f.ts",
      'await db.from(table).select("id, whatever");',
    );
    expect(refs).toEqual([]);
  });

  it("ignores .from() on JS builtins", () => {
    const { refs } = extractReferences(
      "f.ts",
      'const b = Buffer.from("abc"); const a = Array.from(xs);',
    );
    expect(refs).toEqual([]);
  });

  it("does not read a column out of a non-column verb", () => {
    // `.limit(1)` / `.single()` take no column name.
    const cols = columnsOf(
      'await db.from("t").select("id").limit(1).maybeSingle();',
    );
    expect(cols).toEqual(["t.id"]);
  });

  it("skips a select built from an interpolated template", () => {
    const cols = columnsOf('await db.from("t").select(`id, ${extra}`);');
    expect(cols).toEqual([]);
  });

  it("attributes the correct line number to a column on a later line", () => {
    const src = [
      "// header",
      "",
      'const r = await db.from("t")',
      '  .select("id")',
      '  .eq("org_id", orgId);',
    ].join("\n");
    const { refs } = extractReferences("f.ts", src);
    const orgRef = refs.find((r) => r.column === "org_id");
    expect(orgRef?.line).toBe(5);
  });

  it("reports the .from line, not the receiver's, in a wrapped chain", () => {
    const src = ["const r = await db", '  .from("t")', '  .select("id");'].join(
      "\n",
    );
    const { refs } = extractReferences("f.ts", src);
    expect(refs.find((r) => !r.column)?.line).toBe(2);
  });

  it("still resolves a chain rooted at a function call receiver", () => {
    const cols = columnsOf('await getClient().from("t").select("id");');
    expect(cols).toEqual(["t.id"]);
  });

  it("records how each reference was made, for the report", () => {
    const { refs } = extractReferences(
      "f.ts",
      'await db.from("t").select("id").eq("org_id", o);',
    );
    expect(refs.map((r) => r.via)).toEqual([".from()", ".select()", ".eq()"]);
  });
});
