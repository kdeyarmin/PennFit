// Unit tests for the MMS ingestion module.
//
// These mock global.fetch (Twilio download + GCS PUT both go through
// fetch) plus a stub ObjectStorageService + drizzle insert, so we
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

// db stub. ingest-mms.ts calls drizzle(getDbPool()).insert(messageAttachments).values(...)
// then awaits — fluent shape is the same as the inbound test. We
// capture every insert payload so assertions can pin filename /
// content type / size.
const insertCalls: Array<Record<string, unknown>> = [];
const insertImpl = vi.fn();
const dbStub = {
  insert: vi.fn(() => ({
    values: (vals: Record<string, unknown>) => {
      insertCalls.push(vals);
      return Promise.resolve(insertImpl(vals));
    },
  })),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

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
  // Doesn't matter what's inside — content-type comes from the
  // response header in the production code path.
  return new Uint8Array(size).fill(0xab);
}

function mockFetch(impl: (url: string, init?: RequestInit) => Response) {
  // Cast through unknown — vitest's typing of global.fetch is strict.
  return vi
    .spyOn(globalThis, "fetch" as never)
    .mockImplementation((async (url: unknown, init?: unknown) =>
      impl(String(url), init as RequestInit | undefined)) as never);
}

describe("ingestInboundMmsMedia", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    insertCalls.length = 0;
    insertImpl.mockReset();
    dbStub.insert.mockClear();
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
    expect(insertCalls).toHaveLength(0);
  });

  it("downloads, uploads, and persists a single allowed image", async () => {
    fetchSpy = mockFetch((url) => {
      if (url.includes("api.twilio.com")) {
        return new Response(pngBytes(64), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      // GCS upload PUT.
      return new Response("", { status: 200 });
    });
    insertImpl.mockReturnValue(undefined);

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
    expect(insertCalls).toHaveLength(1);
    const inserted = insertCalls[0]!;
    expect(inserted.messageId).toBe(MSG_ID);
    expect(inserted.contentType).toBe("image/png");
    expect(inserted.sizeBytes).toBe(64);
    expect(inserted.objectKey).toBe("/objects/uploads/abc");
    expect(inserted.twilioMediaSid).toBe("MEdef");
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
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects oversize bytes (>5MB) without inserting", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    fetchSpy = mockFetch((url) => {
      if (url.includes("api.twilio.com")) {
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
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEbig",
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
    expect(insertCalls).toHaveLength(0);
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
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEgone",
          MediaContentType0: "image/png",
          MediaUrl1:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEgood",
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
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]!.twilioMediaSid).toBe("MEgood");
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
        `https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/ME${i}`;
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

  describe("persistInboundAttachment (shared validate→upload→insert tail)", () => {
    const SAMPLE_MSG = "22222222-2222-4222-8222-222222222222";

    it("uploads + inserts an email-sourced PNG attachment", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 })); // GCS PUT
      insertImpl.mockReturnValue(undefined);

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
      expect(insertCalls).toHaveLength(1);
      const inserted = insertCalls[0]!;
      expect(inserted.messageId).toBe(SAMPLE_MSG);
      expect(inserted.contentType).toBe("image/png");
      expect(inserted.sizeBytes).toBe(128);
      expect(inserted.objectKey).toBe("/objects/uploads/abc");
      expect(inserted.twilioMediaSid).toBeNull();
      expect(String(inserted.filename)).toBe("patient-card.png");
    });

    it("strips charset from content-type when matching the allowlist", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      insertImpl.mockReturnValue(undefined);

      const outcome = await persistInboundAttachment(
        {
          messageId: SAMPLE_MSG,
          bytes: pngBytes(8),
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
      expect(insertCalls[0]!.contentType).toBe("application/pdf");
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
      expect(insertCalls).toHaveLength(0);
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
      expect(insertCalls).toHaveLength(0);
    });

    it("synthesizes a safe filename when caller passes null", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      insertImpl.mockReturnValue(undefined);

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
      expect(String(insertCalls[0]!.filename)).toMatch(
        /^email-[a-z0-9]+\.png$/,
      );
    });

    it("scrubs path separators + control chars from caller-supplied names", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      insertImpl.mockReturnValue(undefined);

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
      const fn = String(insertCalls[0]!.filename);
      // Path separators and NUL bytes must be replaced — those are the
      // actively dangerous bits. We deliberately allow ".." to survive
      // as part of the basename (it isn't dangerous once the slashes
      // are gone, and the GCS object key is a UUID anyway).
      expect(fn).not.toContain("/");
      expect(fn).not.toContain("\\");
      expect(fn).not.toContain("\x00");
    });

    it("returns 'errored' when the DB insert throws", async () => {
      fetchSpy = mockFetch(() => new Response("", { status: 200 }));
      insertImpl.mockImplementation(() => {
        throw new Error("transient db error");
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
  //
  // What this guards
  // ----------------
  // The 9-second overall budget is the only thing standing between a
  // stalled GCS PUT (or a never-acked Twilio CDN read) and Twilio's
  // 15-second webhook retry threshold — past which Twilio retries
  // the inbound webhook and we get duplicate `messages` rows guarded
  // only by the partial unique index. The other tests in this file
  // use immediate-resolve fetch mocks, so a regression that removed
  // the `Promise.race` against the budget timer would not be caught.
  //
  // How the budget works under test
  // -------------------------------
  // - `vi.useFakeTimers()` controls BOTH the per-media abort timer
  //   (5s) and the overall-budget timer (9s).
  // - `fetch` is mocked to return a Promise that never settles (and
  //   ignores the AbortSignal — the budget is supposed to save us
  //   precisely when the AbortSignal is honoured by nothing on the
  //   other end of the wire).
  // - Advancing fake time past 9s resolves the budget sentinel,
  //   `Promise.race` returns it, and the helper folds every slot
  //   into the `errored` bucket and emits one warning log line.
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
      return vi.spyOn(globalThis, "fetch" as never).mockImplementation(
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
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEa",
            MediaContentType0: "image/png",
            MediaUrl1:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEb",
            MediaContentType1: "image/png",
            MediaUrl2:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEc",
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
      // could land. A bug that swallowed the budget but still
      // awaited the never-settling fetches would either hang the
      // test or — worse in production — let the webhook stall.
      expect(insertCalls).toHaveLength(0);
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
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEx",
            MediaContentType0: "image/png",
            MediaUrl1:
              "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEy",
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
      if (url.includes("api.twilio.com")) {
        return new Response(pngBytes(8), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("", { status: 200 });
    });
    insertImpl.mockImplementation(() => {
      throw new Error("unique violation on twilio_media_sid");
    });

    const result = await ingestInboundMmsMedia(
      {
        messageId: MSG_ID,
        rawWebhookBody: {
          NumMedia: "1",
          MediaUrl0:
            "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM/Media/MEdup",
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
