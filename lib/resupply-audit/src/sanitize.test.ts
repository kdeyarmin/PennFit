import { describe, expect, it } from "vitest";

import {
  AUDIT_METADATA_MAX_BYTES,
  AuditMetadataDepthError,
  AuditMetadataPhiError,
  AuditMetadataShapeError,
  AuditMetadataSizeError,
  sanitizeMetadata,
} from "./sanitize";

// These tests are the contract for what `audit_log.metadata` is
// allowed to contain. They are intentionally exhaustive about the
// failure modes — when this gate fires in production we want it to
// fire LOUD and EARLY, not silently strip a key and leak PHI.

describe("sanitizeMetadata", () => {
  it("accepts undefined / null as empty object", () => {
    expect(sanitizeMetadata(undefined)).toEqual({});
    expect(sanitizeMetadata(null)).toEqual({});
  });

  it("accepts an empty object", () => {
    expect(sanitizeMetadata({})).toEqual({});
  });

  it("accepts request-shaped, non-PHI metadata", () => {
    const m = {
      requestId: "req_abc",
      filters: { status: "active", page: 2 },
      changedFields: ["status"],
    };
    // Returns a deep clone (not the same reference) — see the
    // TOCTOU rationale in `validateAndClone`. The clone is
    // structurally equal and JSON-equivalent.
    const out = sanitizeMetadata(m);
    expect(out).toEqual(m);
    expect(out).not.toBe(m);
    expect(out.filters).not.toBe(m.filters);
    expect(out.changedFields).not.toBe(m.changedFields);
  });

  it("rejects array as top-level metadata", () => {
    // Audit metadata is shaped as a key/value envelope, not a list.
    // Allowing arrays would defeat the point of `metadata.requestId`
    // existing as a stable lookup key.
    expect(() => sanitizeMetadata([1, 2, 3])).toThrow(
      AuditMetadataShapeError,
    );
  });

  it("rejects primitives as top-level metadata", () => {
    expect(() => sanitizeMetadata("hello")).toThrow(AuditMetadataShapeError);
    expect(() => sanitizeMetadata(42)).toThrow(AuditMetadataShapeError);
    expect(() => sanitizeMetadata(true)).toThrow(AuditMetadataShapeError);
  });

  // Strong-token denylist: catches PHI-shaped tokens at any
  // position in the key (camelCase, snake_case, kebab-case, …).
  it.each([
    ["email"],
    ["EMAIL"],
    ["patientEmail"],
    ["email_address"],
    ["EMAIL-ADDRESS"],
    ["email.address"],
    ["operatorEmailNote"],
    ["phone"],
    ["phoneNumber"],
    ["patientPhone"],
    ["phone_number"],
    ["mobile"],
    ["mobileNumber"],
    ["ssn"],
    ["patient_ssn"],
    ["mrn"],
    ["dob"],
    ["patientDob"],
    ["diagnosis"],
    ["primaryDiagnosis"],
    ["transcript"],
    ["callTranscript"],
  ])("strong-token denylist rejects %p", (key) => {
    expect(() => sanitizeMetadata({ [key]: "anything" })).toThrow(
      AuditMetadataPhiError,
    );
  });

  // Joined denylist: catches multi-word concatenations whose
  // individual tokens are too generic to put in the strong set
  // (`address`, `member`, `id`, `body`).
  it.each([
    ["dateOfBirth"],
    ["birthdate"],
    ["birthDate"],
    ["firstName"],
    ["lastName"],
    ["fullName"],
    ["patientName"],
    ["patient_name"],
    ["patientNotes"],
    ["clinicalNotes"],
    ["addressLine1"],
    ["address_line_2"],
    ["zipCode"],
    ["postalCode"],
    ["memberId"],
    ["messageBody"],
    ["smsBody"],
    ["emailBody"],
    ["freeText"],
    ["FREETEXT"],
    ["address"],
    ["street"],
    ["city"],
  ])("joined denylist rejects %p", (key) => {
    expect(() => sanitizeMetadata({ [key]: "x" })).toThrow(
      AuditMetadataPhiError,
    );
  });

  // Whole-key denylist: generic terms only fire when the entire
  // normalized key equals the entry. Compound keys pass.
  it.each([
    ["name"],
    ["NAME"],
    ["state"],
    ["notes"],
    ["dx"],
    ["condition"],
  ])("whole-key denylist rejects bare %p", (key) => {
    expect(() => sanitizeMetadata({ [key]: "x" })).toThrow(
      AuditMetadataPhiError,
    );
  });

  // The whole-key denylist must NOT fire on compound keys — these
  // are common JS idioms and blocking them would create absurd
  // developer friction without reducing PHI risk.
  it.each([
    ["displayName"],
    ["ruleName"],
    ["fileName"],
    ["previousState"],
    ["uiState"],
    ["releaseNotes"],
    ["statusNotes"],
    ["paramName"],
  ])("whole-key denylist allows compound %p", (key) => {
    expect(() => sanitizeMetadata({ [key]: "x" })).not.toThrow();
  });

  it("rejects PHI-shaped keys nested inside a filters object", () => {
    // The recursion is the whole point — a stray
    // `{ filters: { email: "..." } }` is exactly the bug we are
    // trying to prevent, and it would slip through a top-level-only
    // check.
    expect(() =>
      sanitizeMetadata({ filters: { email: "patient@example.com" } }),
    ).toThrow(AuditMetadataPhiError);
  });

  it("rejects PHI-shaped keys nested inside arrays", () => {
    expect(() =>
      sanitizeMetadata({
        changes: [{ field: "status" }, { ssn: "123-45-6789" }],
      }),
    ).toThrow(AuditMetadataPhiError);
  });

  it("normalizes unicode confusables (NFKC) before denylist lookup", () => {
    // Fullwidth `ｅ` (U+FF45) NFKC-normalizes to ASCII `e`, so
    // `ｅmail` should match the strong-token "email". Without NFKC
    // this would slip past a naive `.toLowerCase()` check.
    const fullwidthE = "\uFF45";
    const sneakyKey = `${fullwidthE}mail`;
    expect(() => sanitizeMetadata({ [sneakyKey]: "x" })).toThrow(
      AuditMetadataPhiError,
    );
  });

  it("rejects objects with a custom toJSON method (PHI-injection bypass)", () => {
    // This is the critical bypass: the recursive key check sees only
    // `{ id, toJSON }` (no PHI), passes, then `JSON.stringify` calls
    // `toJSON()` and writes `{"email":"…"}` to the database column.
    // We refuse the SHAPE outright instead of trying to "see through"
    // a custom serializer.
    const sneaky = {
      id: "ok",
      toJSON: () => ({ email: "patient@example.com" }),
    };
    expect(() => sanitizeMetadata(sneaky)).toThrow(AuditMetadataShapeError);
    // Nested too — a child with toJSON is still a bypass.
    expect(() =>
      sanitizeMetadata({
        outer: { id: "ok", toJSON: () => ({ ssn: "1" }) },
      }),
    ).toThrow(AuditMetadataShapeError);
  });

  it("rejects class instances (only plain objects allowed)", () => {
    class MyThing {
      constructor(public requestId: string) {}
    }
    expect(() =>
      sanitizeMetadata({ thing: new MyThing("req_1") }),
    ).toThrow(AuditMetadataShapeError);
  });

  it("rejects Map / Set / Date / Buffer values", () => {
    expect(() => sanitizeMetadata({ m: new Map() })).toThrow(
      AuditMetadataShapeError,
    );
    expect(() => sanitizeMetadata({ s: new Set() })).toThrow(
      AuditMetadataShapeError,
    );
    expect(() => sanitizeMetadata({ d: new Date() })).toThrow(
      AuditMetadataShapeError,
    );
    expect(() => sanitizeMetadata({ b: Buffer.from("x") })).toThrow(
      AuditMetadataShapeError,
    );
  });

  it("rejects objects with symbol-keyed properties", () => {
    // Symbol keys vanish from JSON.stringify silently. We refuse the
    // shape so a future refactor that switches to a different
    // serializer can't accidentally surface them.
    const sym = Symbol("hidden");
    const sneaky = { id: "ok", [sym]: { email: "x" } };
    expect(() => sanitizeMetadata(sneaky)).toThrow(AuditMetadataShapeError);
  });

  it("includes a useful path in the thrown error", () => {
    try {
      sanitizeMetadata({
        outer: { inner: { email: "leak@example.com" } },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuditMetadataPhiError);
      const phi = err as AuditMetadataPhiError;
      expect(phi.key).toBe("email");
      expect(phi.path).toContain("outer");
      expect(phi.path).toContain("inner");
      // The thrown error must NOT echo the offending value, even
      // accidentally — that value is presumed to be PHI.
      expect(phi.message).not.toContain("leak@example.com");
    }
  });

  it("rejects payloads exceeding the byte cap", () => {
    // Build a payload that's safely over the 8 KiB cap with non-PHI
    // keys so the size check is the trigger.
    const big = "x".repeat(AUDIT_METADATA_MAX_BYTES + 100);
    expect(() => sanitizeMetadata({ blob: big })).toThrow(
      AuditMetadataSizeError,
    );
  });

  it("rejects payloads exceeding the depth cap", () => {
    // 8 levels deep — well past the limit.
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => sanitizeMetadata(deep)).toThrow(AuditMetadataDepthError);
  });

  it("returns a deep clone on success (TOCTOU defence)", () => {
    // The previous design returned the same reference for
    // zero-overhead. The architect review (2026-04) flagged a
    // TOCTOU window: a Proxy/getter on the input could pass the
    // sanitizer's first walk and return DIFFERENT data during the
    // subsequent JSON.stringify in `logAudit`. Returning a deep
    // plain-data clone closes the window — `logAudit` serialises
    // the clone, which contains only primitives/arrays/plain
    // objects with no foreign behaviour.
    const m = { requestId: "req_abc", filters: { status: "active" } };
    const out = sanitizeMetadata(m);
    expect(out).not.toBe(m);
    expect(out.filters).not.toBe(m.filters);
    expect(out).toEqual(m);
  });

  it("freezes proxy values at validation time (no TOCTOU)", () => {
    // Build a Proxy that returns ONE value during the sanitizer's
    // walk and a DIFFERENT value on every subsequent access. If
    // the sanitizer returned the live proxy, `JSON.stringify`
    // would later serialise the second-pass shape and we'd write
    // unvalidated content to the DB. The clone defeats this:
    // whatever the proxy returns during the SINGLE read inside
    // `validateAndClone` is what gets serialised.
    let callCount = 0;
    const flipping = new Proxy(
      { requestId: "first" },
      {
        get(target, prop) {
          if (prop === "requestId") {
            callCount += 1;
            return callCount === 1 ? "first" : "second";
          }
          return Reflect.get(target, prop);
        },
        // ownKeys / getOwnPropertyDescriptor must reflect the
        // backing object so Object.entries() returns ["requestId"].
        ownKeys(target) {
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    const out = sanitizeMetadata(flipping);
    // Sanitizer read once. Subsequent JSON.stringify in logAudit
    // will see the SAME value (frozen into the clone), not "second".
    expect(callCount).toBe(1);
    const json = JSON.stringify(out);
    expect(callCount).toBe(1); // serialising the clone does NOT poke the proxy
    expect(out.requestId).toBe("first");
    expect(json).toContain("first");
    expect(json).not.toContain("second");
  });

  it("evaluates accessor values exactly once during validation", () => {
    // A getter that increments a counter — proves the sanitizer
    // walks the source ONCE and the resulting clone is plain data
    // (no live getter survives into the writer's serialise step).
    let getterCalls = 0;
    const m: Record<string, unknown> = {};
    Object.defineProperty(m, "requestId", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "req_abc";
      },
    });
    const out = sanitizeMetadata(m);
    expect(getterCalls).toBe(1);
    JSON.stringify(out);
    expect(getterCalls).toBe(1); // clone holds the materialised string
    expect(out).toEqual({ requestId: "req_abc" });
  });

  it("snapshots array length once (proxy-stable)", () => {
    // A Proxy whose .length grows on every access could otherwise
    // trick the sanitizer into validating fewer entries than
    // JSON.stringify later serialises. Snapshotting length means
    // the clone has a fixed size matching what we validated.
    let lengthReads = 0;
    const backing = ["a", "b", "c"];
    const arr = new Proxy(backing, {
      get(target, prop) {
        if (prop === "length") {
          lengthReads += 1;
          // Lie on subsequent reads — say the array is bigger.
          return lengthReads === 1 ? target.length : target.length + 5;
        }
        return Reflect.get(target, prop);
      },
    });
    const out = sanitizeMetadata({ items: arr }) as { items: unknown[] };
    expect(out.items).toHaveLength(3); // length frozen at first read
    expect(JSON.stringify(out)).toBe('{"items":["a","b","c"]}');
  });
});
