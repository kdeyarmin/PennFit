// Tests for lib/admin/inventory-reconciliation-api.ts
//
// The module is a set of hand-rolled fetch wrappers for the inventory
// reconciliation endpoints.  We test:
//
//   1. ReconciliationUnavailableError — class invariants.
//   2. startReconciliation   — success, issues array, error string, fallback.
//   3. listReconciliations   — success, HTTP error.
//   4. getReconciliation     — success, ID encoding, HTTP error.
//   5. submitReconciliation  — success, 503, 502, issues, error string, generic.
//
// Fetch is stubbed with vi.stubGlobal so no real network calls are made.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReconciliation,
  listReconciliations,
  ReconciliationUnavailableError,
  startReconciliation,
  submitReconciliation,
  type ReconciliationDetail,
  type ReconciliationListItem,
} from "./inventory-reconciliation-api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

function makeFetchFail(status: number, body?: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body ?? { error: `HTTP ${status}` }),
  } as unknown as Response);
}

function makeFetchFailNonJson(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
  } as unknown as Response);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// ReconciliationUnavailableError
// ---------------------------------------------------------------------------

describe("ReconciliationUnavailableError", () => {
  it("is an instance of Error", () => {
    const e = new ReconciliationUnavailableError("stripe_not_configured");
    expect(e).toBeInstanceOf(Error);
  });

  it("has the correct name", () => {
    const e = new ReconciliationUnavailableError("stripe_not_configured");
    expect(e.name).toBe("ReconciliationUnavailableError");
  });

  it("stores the reason 'stripe_not_configured'", () => {
    const e = new ReconciliationUnavailableError("stripe_not_configured");
    expect(e.reason).toBe("stripe_not_configured");
  });

  it("stores the reason 'stripe_list_failed'", () => {
    const e = new ReconciliationUnavailableError("stripe_list_failed");
    expect(e.reason).toBe("stripe_list_failed");
  });

  it("message equals the reason string", () => {
    const e = new ReconciliationUnavailableError("stripe_not_configured");
    expect(e.message).toBe("stripe_not_configured");
  });

  it("instanceof ReconciliationUnavailableError is true", () => {
    const e = new ReconciliationUnavailableError("stripe_list_failed");
    expect(e).toBeInstanceOf(ReconciliationUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// startReconciliation
// ---------------------------------------------------------------------------

describe("startReconciliation — success", () => {
  it("sends POST to /resupply-api/admin/shop/inventory/reconciliations", async () => {
    const fetchSpy = makeFetchOk(
      { id: "rec_1", startedAt: "2026-05-01T00:00:00Z" },
      201,
    );
    vi.stubGlobal("fetch", fetchSpy);

    await startReconciliation({ periodLabel: "2026-05" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/inventory/reconciliations");
    expect(opts.method).toBe("POST");
  });

  it("serialises the body as JSON", async () => {
    const fetchSpy = makeFetchOk(
      { id: "rec_1", startedAt: "2026-05-01T00:00:00Z" },
      201,
    );
    vi.stubGlobal("fetch", fetchSpy);

    await startReconciliation({ periodLabel: "2026-05", notes: "spot check" });

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(opts.body as string)).toEqual({
      periodLabel: "2026-05",
      notes: "spot check",
    });
  });

  it("returns the parsed id and startedAt on success", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk({ id: "rec_abc", startedAt: "2026-05-01T12:00:00Z" }, 201),
    );

    const result = await startReconciliation({ periodLabel: "2026-05" });

    expect(result).toEqual({
      id: "rec_abc",
      startedAt: "2026-05-01T12:00:00Z",
    });
  });

  it("accepts null notes", async () => {
    const fetchSpy = makeFetchOk({ id: "rec_1", startedAt: "" }, 201);
    vi.stubGlobal("fetch", fetchSpy);

    await startReconciliation({ periodLabel: "2026-05", notes: null });

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(opts.body as string)).toMatchObject({ notes: null });
  });
});

describe("startReconciliation — error handling", () => {
  it("throws with issues detail when body.issues is present", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchFail(400, {
        error: "invalid_body",
        issues: [
          { path: "periodLabel", message: "must be at least 2 characters" },
        ],
      }),
    );

    await expect(startReconciliation({ periodLabel: "" })).rejects.toThrow(
      "periodLabel: must be at least 2 characters",
    );
  });

  it("joins multiple issues with semicolons", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchFail(400, {
        error: "invalid_body",
        issues: [
          { path: "periodLabel", message: "too short" },
          { path: "notes", message: "too long" },
        ],
      }),
    );

    await expect(startReconciliation({ periodLabel: "" })).rejects.toThrow(
      "periodLabel: too short; notes: too long",
    );
  });

  it("throws with error string when issues is absent", async () => {
    vi.stubGlobal("fetch", makeFetchFail(500, { error: "insert_failed" }));

    await expect(
      startReconciliation({ periodLabel: "2026-05" }),
    ).rejects.toThrow("insert_failed");
  });

  it("falls back to generic message when body is not parseable JSON", async () => {
    vi.stubGlobal("fetch", makeFetchFailNonJson(500));

    await expect(
      startReconciliation({ periodLabel: "2026-05" }),
    ).rejects.toThrow("Start failed (500)");
  });

  it("uses generic message when body has no error or issues keys", async () => {
    vi.stubGlobal("fetch", makeFetchFail(503, {}));

    await expect(
      startReconciliation({ periodLabel: "2026-05" }),
    ).rejects.toThrow("Start failed (503)");
  });
});

// ---------------------------------------------------------------------------
// listReconciliations
// ---------------------------------------------------------------------------

describe("listReconciliations — success", () => {
  it("sends GET to the base URL", async () => {
    const fetchSpy = makeFetchOk({ reconciliations: [] });
    vi.stubGlobal("fetch", fetchSpy);

    await listReconciliations();

    const [url, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/inventory/reconciliations");
    expect(opts?.method).toBeUndefined(); // GET has no method override
  });

  it("returns the reconciliations array", async () => {
    const items: ReconciliationListItem[] = [
      {
        id: "r1",
        periodLabel: "2026-05",
        status: "submitted",
        startedByEmail: "ops@test.com",
        startedAt: "2026-05-01T00:00:00Z",
        submittedAt: "2026-05-02T00:00:00Z",
        totalLines: 10,
        totalVarianceUnits: 2,
        appliedToStripe: true,
      },
    ];
    vi.stubGlobal("fetch", makeFetchOk({ reconciliations: items }));

    const result = await listReconciliations();

    expect(result).toEqual(items);
  });

  it("returns an empty array when reconciliations is []", async () => {
    vi.stubGlobal("fetch", makeFetchOk({ reconciliations: [] }));

    const result = await listReconciliations();

    expect(result).toEqual([]);
  });
});

describe("listReconciliations — error handling", () => {
  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", makeFetchFail(500, {}));

    await expect(listReconciliations()).rejects.toThrow(
      "Failed to load reconciliations (500)",
    );
  });

  it("includes the status code in the error message", async () => {
    vi.stubGlobal("fetch", makeFetchFail(403, {}));

    await expect(listReconciliations()).rejects.toThrow("(403)");
  });
});

// ---------------------------------------------------------------------------
// getReconciliation
// ---------------------------------------------------------------------------

describe("getReconciliation — success", () => {
  const DETAIL: ReconciliationDetail = {
    reconciliation: {
      id: "rec-123",
      periodLabel: "2026-05",
      status: "draft",
      startedByEmail: "ops@test.com",
      startedByUserId: "u1",
      startedAt: "2026-05-01T00:00:00Z",
      submittedAt: null,
      notes: null,
      totalLines: 0,
      totalVarianceUnits: 0,
      appliedToStripe: false,
    },
    lines: [],
    currentProducts: null,
  };

  it("sends GET to the correct URL", async () => {
    const fetchSpy = makeFetchOk(DETAIL);
    vi.stubGlobal("fetch", fetchSpy);

    await getReconciliation("rec-123");

    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe(
      "/resupply-api/admin/shop/inventory/reconciliations/rec-123",
    );
  });

  it("URI-encodes the id", async () => {
    const fetchSpy = makeFetchOk(DETAIL);
    vi.stubGlobal("fetch", fetchSpy);

    await getReconciliation("id with spaces");

    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain("id%20with%20spaces");
  });

  it("returns the parsed detail object", async () => {
    vi.stubGlobal("fetch", makeFetchOk(DETAIL));

    const result = await getReconciliation("rec-123");

    expect(result).toEqual(DETAIL);
  });
});

describe("getReconciliation — error handling", () => {
  it("throws when response is not ok", async () => {
    vi.stubGlobal("fetch", makeFetchFail(404, {}));

    await expect(getReconciliation("missing")).rejects.toThrow(
      "Failed to load reconciliation (404)",
    );
  });
});

// ---------------------------------------------------------------------------
// submitReconciliation
// ---------------------------------------------------------------------------

const SUBMIT_INPUT = {
  lines: [{ productId: "prod_abc", countedQty: 10 }],
  applyToStripe: true,
};
const SUBMIT_SUCCESS = {
  id: "rec-123",
  totalLines: 1,
  totalVarianceUnits: 2,
  appliedToStripe: true,
  stripeApplyFailures: 0,
};

describe("submitReconciliation — success", () => {
  it("sends POST to /:id/submit", async () => {
    const fetchSpy = makeFetchOk(SUBMIT_SUCCESS);
    vi.stubGlobal("fetch", fetchSpy);

    await submitReconciliation("rec-123", SUBMIT_INPUT);

    const [url, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/shop/inventory/reconciliations/rec-123/submit",
    );
    expect(opts.method).toBe("POST");
  });

  it("URI-encodes the id in submit URL", async () => {
    const fetchSpy = makeFetchOk(SUBMIT_SUCCESS);
    vi.stubGlobal("fetch", fetchSpy);

    await submitReconciliation("id/tricky", SUBMIT_INPUT);

    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain("id%2Ftricky");
  });

  it("serialises the body correctly", async () => {
    const fetchSpy = makeFetchOk(SUBMIT_SUCCESS);
    vi.stubGlobal("fetch", fetchSpy);

    await submitReconciliation("rec-123", SUBMIT_INPUT);

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(opts.body as string)).toEqual(SUBMIT_INPUT);
  });

  it("returns the parsed result on success", async () => {
    vi.stubGlobal("fetch", makeFetchOk(SUBMIT_SUCCESS));

    const result = await submitReconciliation("rec-123", SUBMIT_INPUT);

    expect(result).toEqual(SUBMIT_SUCCESS);
  });
});

describe("submitReconciliation — 503 → ReconciliationUnavailableError", () => {
  it("throws ReconciliationUnavailableError with reason stripe_not_configured on 503", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchFail(503, { error: "stripe_not_configured" }),
    );

    await expect(submitReconciliation("rec-123", SUBMIT_INPUT)).rejects.toThrow(
      ReconciliationUnavailableError,
    );
  });

  it("reason is 'stripe_not_configured' on 503", async () => {
    vi.stubGlobal("fetch", makeFetchFail(503, {}));

    try {
      await submitReconciliation("rec-123", SUBMIT_INPUT);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconciliationUnavailableError);
      expect((e as ReconciliationUnavailableError).reason).toBe(
        "stripe_not_configured",
      );
    }
  });
});

describe("submitReconciliation — 502 → ReconciliationUnavailableError", () => {
  it("throws ReconciliationUnavailableError on 502", async () => {
    vi.stubGlobal("fetch", makeFetchFail(502, { error: "stripe_list_failed" }));

    await expect(submitReconciliation("rec-123", SUBMIT_INPUT)).rejects.toThrow(
      ReconciliationUnavailableError,
    );
  });

  it("reason is 'stripe_list_failed' on 502", async () => {
    vi.stubGlobal("fetch", makeFetchFail(502, {}));

    try {
      await submitReconciliation("rec-123", SUBMIT_INPUT);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconciliationUnavailableError);
      expect((e as ReconciliationUnavailableError).reason).toBe(
        "stripe_list_failed",
      );
    }
  });
});

describe("submitReconciliation — generic error handling", () => {
  it("throws with issues detail when body.issues is present", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchFail(400, {
        error: "invalid_body",
        issues: [{ path: "lines", message: "must have at least 1 item" }],
      }),
    );

    await expect(submitReconciliation("rec-123", SUBMIT_INPUT)).rejects.toThrow(
      "lines: must have at least 1 item",
    );
  });

  it("throws with error string when issues absent", async () => {
    vi.stubGlobal("fetch", makeFetchFail(409, { error: "already_submitted" }));

    await expect(submitReconciliation("rec-123", SUBMIT_INPUT)).rejects.toThrow(
      "already_submitted",
    );
  });

  it("falls back to generic message on non-JSON body", async () => {
    vi.stubGlobal("fetch", makeFetchFailNonJson(500));

    await expect(submitReconciliation("rec-123", SUBMIT_INPUT)).rejects.toThrow(
      "Submit failed (500)",
    );
  });

  it("uses generic message when body has no error/issues keys", async () => {
    vi.stubGlobal("fetch", makeFetchFail(400, {}));

    await expect(submitReconciliation("rec-123", SUBMIT_INPUT)).rejects.toThrow(
      "Submit failed (400)",
    );
  });

  it("throws a plain Error (not ReconciliationUnavailableError) for other 4xx/5xx", async () => {
    vi.stubGlobal("fetch", makeFetchFail(422, { error: "no_valid_lines" }));

    try {
      await submitReconciliation("rec-123", SUBMIT_INPUT);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(ReconciliationUnavailableError);
    }
  });
});

// ---------------------------------------------------------------------------
// CSRF header — startReconciliation and submitReconciliation
// ---------------------------------------------------------------------------
//
// The PR added csrfHeader() to the headers of both mutating calls.
// Read-only calls (listReconciliations, getReconciliation) are unchanged.

describe("CSRF header — startReconciliation", () => {
  function setDocumentCookie(cookie: string | null) {
    if (cookie === null) {
      delete (globalThis as unknown as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document?: unknown }).document = { cookie };
    }
  }

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    vi.unstubAllGlobals();
  });

  it("sends X-PF-CSRF when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=recon-csrf-token");
    const fetchSpy = makeFetchOk(
      { id: "rec_1", startedAt: "2026-05-01T00:00:00Z" },
      201,
    );
    vi.stubGlobal("fetch", fetchSpy);

    await startReconciliation({ periodLabel: "2026-05" });

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = opts.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("recon-csrf-token");
  });

  it("does not send X-PF-CSRF when pf_csrf cookie is absent", async () => {
    setDocumentCookie("other=unrelated");
    const fetchSpy = makeFetchOk(
      { id: "rec_1", startedAt: "2026-05-01T00:00:00Z" },
      201,
    );
    vi.stubGlobal("fetch", fetchSpy);

    await startReconciliation({ periodLabel: "2026-05" });

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = opts.headers as Record<string, string>;
    expect("X-PF-CSRF" in headers).toBe(false);
  });
});

describe("CSRF header — submitReconciliation", () => {
  function setDocumentCookie(cookie: string | null) {
    if (cookie === null) {
      delete (globalThis as unknown as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document?: unknown }).document = { cookie };
    }
  }

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    vi.unstubAllGlobals();
  });

  it("sends X-PF-CSRF when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=submit-csrf-token");
    const fetchSpy = makeFetchOk(SUBMIT_SUCCESS);
    vi.stubGlobal("fetch", fetchSpy);

    await submitReconciliation("rec-123", SUBMIT_INPUT);

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = opts.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("submit-csrf-token");
  });

  it("does not send X-PF-CSRF when pf_csrf cookie is absent", async () => {
    setDocumentCookie("");
    const fetchSpy = makeFetchOk(SUBMIT_SUCCESS);
    vi.stubGlobal("fetch", fetchSpy);

    await submitReconciliation("rec-123", SUBMIT_INPUT);

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = opts.headers as Record<string, string>;
    expect("X-PF-CSRF" in headers).toBe(false);
  });

  it("read-only GET (listReconciliations) does NOT send X-PF-CSRF regardless of cookie", async () => {
    setDocumentCookie("pf_csrf=should-not-appear");
    const fetchSpy = makeFetchOk({ reconciliations: [] });
    vi.stubGlobal("fetch", fetchSpy);

    await listReconciliations();

    const [, opts] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = (opts?.headers ?? {}) as Record<string, string>;
    expect("X-PF-CSRF" in headers).toBe(false);
  });
});
