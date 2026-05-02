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
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

// ObjectStorageService stub — both upload-url issuance and ACL set.
const getUploadUrlMock = vi.fn(
  async () =>
    "https://storage.googleapis.com/test-bucket/uploads/abc?signed=1",
);
const setAclMock = vi.fn(async (_url: string, _opts: unknown) =>
  "/objects/uploads/abc",
);
vi.mock("../object-storage/objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {
    getObjectEntityUploadURL = () => getUploadUrlMock();
    trySetObjectEntityAclPolicy = (url: string, opts: unknown) =>
      setAclMock(url, opts);
  },
}));

import { ingestInboundMmsMedia } from "./ingest-mms";

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
    expect(result.attempted + result.rejected + result.errored).toBeLessThanOrEqual(
      10,
    );
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
