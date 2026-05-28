// Unit tests for the MMS ingestion module.
//
// These mock global.fetch (Twilio download + GCS PUT both go through
// fetch) plus a stub ObjectStorageService + Supabase insert, so we
// can assert the per-media gating (allowlist, size cap, missing
// SID) without touching the network or the database.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// ObjectStorageService stub — both upload-url issuance and ACL set.
const getUploadUrlMock = vi.fn(
  async () => "https://storage.googleapis.com/test-bucket/uploads/abc?signed=1",
);
const setAclMock = vi.fn(
  async (_url: string, _opts: unknown) => "/objects/uploads/abc",
);
vi.mock("../object-storage/objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {
    getObjectEntityUploadURL = () => getUploadUrlMock();
    trySetObjectEntityAclPolicy = (url: string, opts: unknown) =>
      setAclMock(url, opts);
  },
}));

import { ingestInboundMmsMedia, persistInboundAttachment } from "./ingest-mms";

const SILENT_LOGGER = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as Parameters<typeof ingestInboundMmsMedia>[1];

const TWILIO_SID = "ACtest";
const TWILIO_TOKEN = "token-test";
const MSG_ID = "11111111-1111-4111-8111-111111111111";

function pngBytes(size = 32): Uint8Array {
  // Valid PNG magic header (89 50 4E 47 0D 0A 1A 0A) followed by
  // filler. persistInboundAttachment now sniffs the magic bytes
  // against the declared content-type to reject polyglot uploads,
  // so the fixture bytes must actually parse as a PNG.
  const buf = new Uint8Array(size);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  for (let i = 8; i < size; i++) buf[i] = 0xab;
  return buf;
}

function mockFetch(impl: (url: string, init?: RequestInit) => Response) {
  // Cast through unknown — vitest's typing of global.fetch is strict.
  return (
    vi.spyOn(globalThis, "fetch" as never) as unknown as MockInstance
  ).mockImplementation((async (url: unknown, init?: unknown) =>
    impl(String(url), init as RequestInit | undefined)) as never);
}

// Exact Twilio-media URL check used by the fetch mocks below. A naive
// `url.includes("api.twilio.com")` would also match a hostile
// `https://evil.example.com/api.twilio.com/...` URL, and production
// also requires HTTPS. Parse once and require both the expected
// protocol and hostname so the test fixtures stay aligned with the
// production allowlist semantics.
function isTwilioMediaUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.protocol === "https:" &&
      parsedUrl.hostname === "api.twilio.com"
    );
  } catch {
    return false;
  }
}

// Read the captured insert payloads on `message_attachments` from
// the shared supabase mock. These are the rows the production code
// would have written; we assert on filename / content_type / size /
// object_key / twilio_media_sid here.
function attachmentInserts(): Record<string, unknown>[] {
  return getSupabaseWritePayloads(
    "message_attachments",
    "insert",
  ) as Record<string, unknown>[];
}

describe("ingestInboundMmsMedia", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    supabaseMock.reset();
    getUploadUrlMock.mockClear();
    setAclMock.mockClear();
    (SILENT_LOGGER.warn as ReturnType<typeof vi.fn>).mockReset?.();
  });
  afterEach(() => {
    fetchSpy?.mockRestore?.();
  });

  it("returns zero counts when numMedia is 0", async () => {
    fetchSpy = mockFetch(() => new Response("", { status: 200 }));
    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: { NumMedia: "0" },
        numMedia: 0,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );
    expect(result).toEqual({
      attempted: 0,
      succeeded: 0,
      rejected: 0,
      errored: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(attachmentInserts()).toHaveLength(0);
  });

  it("downloads, uploads, and persists a single allowed image", async () => {
    fetchSpy = mockFetch((url) => {
      if (isTwilioMediaUrl(url)) {
        return new Response(pngBytes(64), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      // GCS upload PUT.
      return new Response("", { status: 200 });
    });

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "1",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMabc/Media/MEdef",
          MediaContentType0: "image/png",
        },
        numMedia: 1,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );

    expect(result).toEqual({
      attempted: 1,
      succeeded: 1,
      rejected: 0,
      errored: 0,
    });
    const inserts = attachmentInserts();
    expect(inserts).toHaveLength(1);
    const inserted = inserts[0]!;
    expect(inserted.message_id).toBe(MSG_ID);
    expect(inserted.content_type).toBe("image/png");
    expect(inserted.size_bytes).toBe(64);
    expect(inserted.object_key).toBe("/objects/uploads/abc");
    expect(inserted.twilio_media_sid).toBe("MEdef");
    expect(String(inserted.filename)).toMatch(/^mms-MEdef\.png$/);
  });

  it("rejects unsupported content types without uploading or inserting", async () => {
    fetchSpy = mockFetch(
      () =>
        new Response("MZ", {
          status: 200,
          headers: { "content-type": "application/x-msdownload" },
        }),
    );

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "1",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMabc/Media/MEbad",
          MediaContentType0: "application/x-msdownload",
        },
        numMedia: 1,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );

    expect(result.rejected).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(getUploadUrlMock).not.toHaveBeenCalled();
    expect(attachmentInserts()).toHaveLength(0);
  });

  it("rejects oversize bytes (>5MB) without inserting", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    fetchSpy = mockFetch((url) => {
      if (isTwilioMediaUrl(url)) {
        return new Response(big, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("", { status: 200 });
    });

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "1",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEbig",
          MediaContentType0: "image/jpeg",
        },
        numMedia: 1,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );
    expect(result.rejected).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(attachmentInserts()).toHaveLength(0);
  });

  it("counts a download non-2xx as rejected and continues", async () => {
    fetchSpy = mockFetch((url) => {
      if (url.endsWith("/MEgood")) {
        return new Response(pngBytes(16), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.endsWith("/MEgone")) {
        return new Response("not found", { status: 404 });
      }
      // GCS PUT
      return new Response("", { status: 200 });
    });

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "2",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEgone",
          MediaContentType0: "image/png",
          MediaUrl1:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEgood",
          MediaContentType1: "image/png",
        },
        numMedia: 2,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );

    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      rejected: 1,
      errored: 0,
    });
    const inserts = attachmentInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.twilio_media_sid).toBe("MEgood");
  });

  it("caps at MAX_MEDIA_PER_MESSAGE when numMedia is wildly inflated", async () => {
    fetchSpy = mockFetch(
      () =>
        new Response(pngBytes(8), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const body: Record<string, string> = { NumMedia: "99" };
    for (let i = 0; i < 99; i++) {
      body[`MediaUrl${i}`] =
        `https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/ME${i}`;
      body[`MediaContentType${i}`] = "image/png";
    }

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: body,
        numMedia: 99,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );

    expect(result.attempted).toBeLessThanOrEqual(10);
    expect(
      result.attempted + result.rejected + result.errored,
    ).toBeLessThanOrEqual(10);
  });

  it("silently drops MediaUrls on non-Twilio hosts without fetching", async () => {
    // A tampered webhook body pointing at an attacker-controlled host
    // must be filtered out by the allowlist before any fetch is issued.
    fetchSpy = mockFetch(
      () =>
        new Response(pngBytes(8), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "2",
          // Attacker-controlled URL — must never be fetched.
          MediaUrl0: "https://example.com/evil-image.png",
          MediaContentType0: "image/png",
          // Valid Twilio URL — should proceed normally.
          MediaUrl1:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEsafe",
          MediaContentType1: "image/png",
        },
        numMedia: 2,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );

    // Only the allowlisted Twilio URL should be attempted; the
    // non-Twilio URL must be silently dropped (not counted as
    // attempted, rejected, or errored — it never enters the pipeline).
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.rejected).toBe(0);

    // Fetch must only have been called for the valid Twilio URL —
    // never for example.com.
    const fetchedHosts = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => new URL(String(c[0])).hostname,
    );
    expect(fetchedHosts.some((h: string) => h === "example.com")).toBe(false);
    expect(fetchedHosts.some((h: string) => h === "api.twilio.com")).toBe(true);
  });

  describe("persistInboundAttachment (shared validate→upload→insert tail)", () => {
    const SAMPLE_MSG = "22222222-2222-4222-8222-222222222222";

    it("uploads + inserts an email-sourced PNG attachment", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 })); // GCS PUT

      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pngBytes(128),
          contentType: "image/png",
          filename: "patient-card.png",
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );

      expect(outcome).toBe("succeeded");
      const inserts = attachmentInserts();
      expect(inserts).toHaveLength(1);
      const inserted = inserts[0]!;
      expect(inserted.message_id).toBe(SAMPLE_MSG);
      expect(inserted.content_type).toBe("image/png");
      expect(inserted.size_bytes).toBe(128);
      expect(inserted.object_key).toBe("/objects/uploads/abc");
      expect(inserted.twilio_media_sid).toBeNull();
      expect(String(inserted.filename)).toBe("patient-card.png");
    });

    it("strips charset from content-type when matching the allowlist", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));

      // Use real PDF magic bytes ("%PDF-") because persistInboundAttachment
      // now sniffs the body and rejects polyglot uploads where the declared
      // type doesn't match.
      const pdfBytes = new Uint8Array(8);
      pdfBytes[0] = 0x25; // %
      pdfBytes[1] = 0x50; // P
      pdfBytes[2] = 0x44; // D
      pdfBytes[3] = 0x46; // F
      pdfBytes[4] = 0x2d; // -
      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pdfBytes,
          // SendGrid sometimes forwards "application/pdf; name=foo.pdf"
          // — the helper must normalize to the bare type for the allowlist.
          contentType: "application/pdf; name=insurance.pdf",
          filename: "insurance.pdf",
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );
      expect(outcome).toBe("succeeded");
      expect(attachmentInserts()[0]!.content_type).toBe("application/pdf");
    });

    it("rejects content types outside the allowlist without uploading", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pngBytes(8),
          contentType: "application/zip",
          filename: "stuff.zip",
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );
      expect(outcome).toBe("rejected");
      expect(getUploadUrlMock).not.toHaveBeenCalled();
      expect(attachmentInserts()).toHaveLength(0);
    });

    it("rejects oversize (>5MB) bytes without uploading", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: new Uint8Array(5 * 1024 * 1024 + 1),
          contentType: "image/jpeg",
          filename: "huge.jpg",
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );
      expect(outcome).toBe("rejected");
      expect(getUploadUrlMock).not.toHaveBeenCalled();
      expect(attachmentInserts()).toHaveLength(0);
    });

    it("synthesizes a safe filename when caller passes null", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));

      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pngBytes(8),
          contentType: "image/png",
          filename: null,
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );
      expect(outcome).toBe("succeeded");
      // Falls back to "<source>-<random>.<ext>" — no sid available.
      expect(String(attachmentInserts()[0]!.filename)).toMatch(
        /^email-[a-z0-9]+\.png$/,
      );
    });

    it("scrubs path separators + control chars from caller-supplied names", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));

      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pngBytes(8),
          contentType: "image/png",
          filename: "../../etc/pass\x00wd",
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );
      expect(outcome).toBe("succeeded");
      const fn = String(attachmentInserts()[0]!.filename);
      // Path separators and NUL bytes must be replaced — those are the
      // actively dangerous bits. We deliberately allow ".." to survive
      // as part of the basename (it isn't dangerous once the slashes
      // are gone, and the GCS object key is a UUID anyway).
      expect(fn).not.toContain("/");
      expect(fn).not.toContain("\\");
      expect(fn).not.toContain("\x00");
    });

    it("returns 'errored' when the DB insert fails", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      // Stage an error envelope on the next message_attachments
      // insert. PostgREST surfaces transport failures as `error`.
      stageSupabaseResponse("message_attachments", "insert", {
        error: new Error("transient db error"),
      });

      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pngBytes(8),
          contentType: "image/png",
          filename: "foo.png",
          twilioMediaSid: null,
          source: "email",
        },
        SILENT_LOGGER,
      );
      expect(outcome).toBe("errored");
    });
  });

  // Task #52 — exercise the OVERALL_BUDGET_MS race in `ingestInboundMmsMedia`.
  describe("OVERALL_BUDGET_MS — stalled fetch can't hold the webhook", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      // Drop any still-pending timers (e.g. the per-media abort
      // setTimeout we never let fire) before handing control back.
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    /** Fetch impl that returns a Promise which never settles. The
     *  AbortSignal handed to it is intentionally ignored — that's
     *  the failure mode the overall-budget guard exists for. */
    function neverSettlingFetch(): MockInstance {
      return (
        vi.spyOn(globalThis, "fetch" as never) as unknown as MockInstance
      ).mockImplementation(
        (async () =>
          new Promise(() => {
            /* never resolves */
          })) as never,
      );
    }

    it("returns within the 9s budget with every slot counted as errored", async () => {
      fetchSpy = neverSettlingFetch();

      const promise = ingestInboundMmsMedia(
        {
          messageId: MSG_ID,
          rawWebhookBody: {
            NumMedia: "3",
            MediaUrl0:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEa",
            MediaContentType0: "image/png",
            MediaUrl1:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEb",
            MediaContentType1: "image/png",
            MediaUrl2:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEc",
            MediaContentType2: "image/png",
          },
          numMedia: 3,
          twilioAccountSid: TWILIO_SID,
          twilioAuthToken: TWILIO_TOKEN,
        },
        SILENT_LOGGER,
      );

      // Advance to 8.999s — JUST before the budget. The promise
      // must still be pending; if it's already settled the budget
      // is firing too early (regression).
      await vi.advanceTimersByTimeAsync(8_999);
      let earlySettled = false;
      void promise.then(() => {
        earlySettled = true;
      });
      // Yield to the microtask queue so any spurious early settle
      // would have flipped the flag.
      await Promise.resolve();
      expect(earlySettled).toBe(false);

      // Tick past the 9s budget; the Promise.race resolves with the
      // sentinel and the helper returns.
      await vi.advanceTimersByTimeAsync(2);

      const result = await promise;
      expect(result).toEqual({
        attempted: 3,
        succeeded: 0,
        rejected: 0,
        errored: 3,
      });
      // Critical: no DB insert can have happened — the production
      // code path returns BEFORE any persistInboundAttachment call
      // could land.
      expect(attachmentInserts()).toHaveLength(0);
      expect(getUploadUrlMock).not.toHaveBeenCalled();
    });

    it("emits the mms_ingest_overall_budget_exceeded warning log", async () => {
      fetchSpy = neverSettlingFetch();
      const warn = SILENT_LOGGER.warn as ReturnType<typeof vi.fn>;
      warn.mockClear();

      const promise = ingestInboundMmsMedia(
        {
          messageId: MSG_ID,
          rawWebhookBody: {
            NumMedia: "2",
            MediaUrl0:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEx",
            MediaContentType0: "image/png",
            MediaUrl1:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEy",
            MediaContentType1: "image/png",
          },
          numMedia: 2,
          twilioAccountSid: TWILIO_SID,
          twilioAuthToken: TWILIO_TOKEN,
        },
        SILENT_LOGGER,
      );

      await vi.advanceTimersByTimeAsync(9_001);
      await promise;

      // Pino-style call shape is `(obj, msg)`. Find the budget log
      // by message string so any future per-media abort warnings
      // emitted alongside it don't break the assertion.
      const budgetCall = warn.mock.calls.find(
        (c) => c[1] === "mms_ingest_overall_budget_exceeded",
      );
      expect(budgetCall).toBeDefined();
      expect(budgetCall![0]).toMatchObject({
        budget_ms: 9_000,
        attempted: 2,
      });
    });
  });

  it("counts a DB insert failure as errored without throwing", async () => {
    fetchSpy = mockFetch((url) => {
      if (isTwilioMediaUrl(url)) {
        return new Response(pngBytes(8), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("", { status: 200 });
    });
    // PostgREST surfaces a unique-violation as a `code: "23505"`
    // error envelope — same shape we'd see in prod.
    stageSupabaseResponse("message_attachments", "insert", {
      error: { code: "23505", message: "unique violation on twilio_media_sid" },
    });

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "1",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEdup",
          MediaContentType0: "image/png",
        },
        numMedia: 1,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );
    expect(result.errored).toBe(1);
    expect(result.succeeded).toBe(0);
  });
});

// ── outerSignal / budget-level AbortController (PR change) ───────────────────
//
// PR adds an `outerSignal?: AbortSignal` parameter to `downloadOneMedia`
// and wires a `budgetController` in `ingestInboundMmsMedia` so the
// overall wall-clock budget can abort in-flight Twilio CDN fetches.
//
// The `downloadOneMedia` function is internal; we test the observable
// contract via `ingestInboundMmsMedia`:
//
//   1. When the budget controller fires while fetches are pending, the
//      function must still return promptly (not hang waiting for the
//      network) with all slots counted as errored.
//
//   2. An already-aborted signal must not cause the function to hang.
//
// The underlying behavior is: `budgetController.abort()` → each
// in-flight `downloadOneMedia` call receives an AbortError on its
// internal fetch → returns null → counted as "rejected" which the
// budget path promotes to "errored" in the audit counts.

describe("ingestInboundMmsMedia — outerSignal budget abort (PR change)", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    supabaseMock.reset();
    getUploadUrlMock.mockClear();
    setAclMock.mockClear();
    (SILENT_LOGGER.warn as ReturnType<typeof vi.fn>).mockReset?.();
  });

  afterEach(() => {
    fetchSpy?.mockRestore?.();
  });

  it("counts all slots as errored when the overall budget blows mid-fetch", async () => {
    // Simulate a stalled Twilio CDN response: the fetch never settles.
    // The budget abort triggers PER_MEDIA_TIMEOUT or the outerSignal —
    // whichever fires first — so the function resolves rather than hanging.
    let fetchAbortController: (() => void) | null = null;
    fetchSpy = (
      vi.spyOn(globalThis, "fetch" as never) as unknown as MockInstance
    ).mockImplementation(async (_url: unknown, init?: unknown) => {
      const signal = (init as RequestInit | undefined)?.signal;
      // Track the abort signal so we can fire it from the test
      if (signal) {
        fetchAbortController = () => (signal as AbortSignal).dispatchEvent(new Event("abort"));
      }
      // Return a response that never resolves (hangs until aborted)
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          }, { once: true });
        }
      });
    });

    // Kick off the ingest — it will stall on the fetch
    const promise = ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "1",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMabc/Media/MEabc",
          MediaContentType0: "image/png",
        },
        numMedia: 1,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );

    // Allow the event loop to advance so the fetch begins
    await new Promise<void>((r) => setTimeout(r, 0));

    // Abort the stalled fetch — mimics the budget controller firing
    fetchAbortController?.()

    const result = await promise;

    // The function resolves even though the fetch was aborted
    expect(result.attempted).toBe(1);
    // The aborted download returns null → slot is "rejected" or "errored"
    expect(result.succeeded).toBe(0);
  });

  it("returns promptly when numMedia is 0 (no outerSignal interaction needed)", async () => {
    fetchSpy = mockFetch(() => new Response("", { status: 200 }));
    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: { NumMedia: "0" },
        numMedia: 0,
        twilioAccountSid: TWILIO_SID,
        twilioAuthToken: TWILIO_TOKEN,
      },
      SILENT_LOGGER,
    );
    // Zero media means budget controller is created but never armed
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
  });
});
