// Step-5 (referral review) hook tests for the inbound-fax ingest:
//   * flag ON + media persisted + not barcode-filed → opens a review
//   * flag OFF → no review
//   * no media persisted → no review
//   * barcode auto-filed → no review (signed returns aren't referrals)
//   * open-for-fax throwing never breaks the ingest outcome

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "pino";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

installSupabaseMock();

const { isFeatureEnabledMock } = vi.hoisted(() => ({
  isFeatureEnabledMock: vi.fn(async (_key: string) => false),
}));
vi.mock("../feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

const { openReviewMock } = vi.hoisted(() => ({
  openReviewMock: vi.fn(async (_input: unknown, _logger?: unknown) => ({
    reviewId: "rr-1",
    enqueued: true,
  })),
}));
vi.mock("../referral-review/open-for-fax", () => ({
  openReferralReviewForFax: openReviewMock,
}));

const { autoFileMock } = vi.hoisted(() => ({
  autoFileMock: vi.fn(async () => ({ status: "no_code" as string })),
}));
vi.mock("./auto-file-signed", () => ({
  autoFileSignedFax: autoFileMock,
}));
vi.mock("../billing/bill-hold", () => ({
  autoMatchInboundFaxToPaperwork: vi.fn(async () => undefined),
}));

const objectStorageStub = {
  getObjectEntityUploadURL: vi.fn(
    async () => "https://storage.example.test/upload",
  ),
  trySetObjectEntityAclPolicy: vi.fn(async () => "obj-key-12345"),
};

const loggerStub = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
} as unknown as Logger;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { ingestInboundFax } from "./ingest-inbound";

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const FAX_ROW_ID = "11111111-1111-4111-8111-111111111111";

const baseInput = {
  telnyxFaxId: "fx-12345678",
  fromE164: "+12155551234",
  toE164: "+19785551234",
  numPages: 3,
  receivedAt: "2026-06-12T12:00:00Z",
  mediaUrl: "https://s3.amazonaws.com/telnyx-fax/fx-12345678.pdf",
};

function stageHappyIngest() {
  stageSupabaseResponse("inbound_faxes", "insert", {
    data: { id: FAX_ROW_ID },
  });
  // media patch
  stageSupabaseResponse("inbound_faxes", "update", { data: null });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return { ok: true, status: 200 };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => PDF_MAGIC.buffer.slice(0),
    };
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  isFeatureEnabledMock.mockReset();
  isFeatureEnabledMock.mockResolvedValue(false);
  openReviewMock.mockClear();
  autoFileMock.mockReset();
  autoFileMock.mockResolvedValue({ status: "no_code" });
});

async function run() {
  return ingestInboundFax(baseInput, loggerStub, objectStorageStub as never);
}

describe("ingestInboundFax — referral-review hook", () => {
  it("opens a review when the flag is on and media persisted", async () => {
    stageHappyIngest();
    isFeatureEnabledMock.mockImplementation(
      async (key: string) => key === "fax.referral_review",
    );
    const outcome = await run();
    expect(outcome.kind).toBe("inserted");
    expect(openReviewMock).toHaveBeenCalledTimes(1);
    const arg = openReviewMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      faxId: FAX_ROW_ID,
      mediaObjectKey: "obj-key-12345",
      mediaContentType: "application/pdf",
    });
  });

  it("does nothing when the flag is off", async () => {
    stageHappyIngest();
    const outcome = await run();
    expect(outcome.kind).toBe("inserted");
    expect(openReviewMock).not.toHaveBeenCalled();
  });

  it("skips when no media was persisted", async () => {
    stageSupabaseResponse("inbound_faxes", "insert", {
      data: { id: FAX_ROW_ID },
    });
    isFeatureEnabledMock.mockResolvedValue(true);
    const outcome = await ingestInboundFax(
      { ...baseInput, mediaUrl: null },
      loggerStub,
      objectStorageStub as never,
    );
    expect(outcome.kind).toBe("inserted");
    expect(openReviewMock).not.toHaveBeenCalled();
  });

  it("skips a barcode auto-filed fax (signed return, not a referral)", async () => {
    stageHappyIngest();
    isFeatureEnabledMock.mockResolvedValue(true); // both flags on
    autoFileMock.mockResolvedValue({ status: "filed" });
    const outcome = await run();
    expect(outcome.kind).toBe("inserted");
    expect(openReviewMock).not.toHaveBeenCalled();
  });

  it("never fails the ingest when opening the review throws", async () => {
    stageHappyIngest();
    isFeatureEnabledMock.mockImplementation(
      async (key: string) => key === "fax.referral_review",
    );
    openReviewMock.mockRejectedValueOnce(new Error("db down"));
    const outcome = await run();
    expect(outcome.kind).toBe("inserted");
    expect((outcome as { mediaPersisted: boolean }).mediaPersisted).toBe(true);
  });
});
