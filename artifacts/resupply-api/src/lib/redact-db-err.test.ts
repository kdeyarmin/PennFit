import { describe, expect, it } from "vitest";

import { redactDbErr } from "./redact-db-err";

describe("redactDbErr", () => {
  it("drops the PHI-bearing PostgREST fields (details/hint) on a constraint violation", () => {
    // Shape supabase-js / PostgREST returns on a unique violation —
    // `details` echoes the offending row's column values (here, a
    // patient email + name).
    const pgErr = {
      code: "23505",
      message: "duplicate key value violates unique constraint",
      details: "Key (email)=(jane.doe@example.com) already exists.",
      hint: "Patient Jane Doe (DOB 1980-01-01) already on file.",
    };

    const safe = redactDbErr(pgErr);

    expect(safe).toEqual({
      name: "non_error",
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });
    // No PHI-bearing fields survive.
    expect(safe).not.toHaveProperty("details");
    expect(safe).not.toHaveProperty("hint");
    expect(JSON.stringify(safe)).not.toContain("jane.doe@example.com");
    expect(JSON.stringify(safe)).not.toContain("Jane Doe");
  });

  it("keeps name/code/message for a real Error", () => {
    const err = Object.assign(new Error("boom"), { code: "ECONN" });
    expect(redactDbErr(err)).toEqual({
      name: "Error",
      code: "ECONN",
      message: "boom",
    });
  });

  it("handles non-object throwables", () => {
    expect(redactDbErr("raw string failure")).toEqual({
      name: "non_error",
      message: "raw string failure",
    });
  });
});
