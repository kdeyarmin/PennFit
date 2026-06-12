// Tests for runReviewExtraction — the shared download → extract →
// persist routine behind the pg-boss job and the re-run route.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));
vi.mock("./extract", () => ({ extractReferral: extractMock }));

const { getFileMock, downloadObjectMock, ObjectNotFoundErrorClass } =
  vi.hoisted(() => ({
    getFileMock: vi.fn(async (_p?: unknown) => ({ bucket: "b", path: "p" })),
    downloadObjectMock: vi.fn(async () => ({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })),
    ObjectNotFoundErrorClass: class ObjectNotFoundError extends Error {},
  }));
vi.mock("../object-storage/objectStorage", () => ({
  ObjectNotFoundError: ObjectNotFoundErrorClass,
  ObjectStorageService: class {
    getObjectEntityFile = (p: string) => getFileMock(p);
    downloadObject = () => downloadObjectMock();
  },
}));

import { runReviewExtraction } from "./run";

const REVIEW_ID = "22222222-2222-4222-8222-222222222222";

function stageReview(overrides: Record<string, unknown> = {}) {
  stageSupabaseResponse("referral_reviews", "select", {
    data: {
      id: REVIEW_ID,
      status: "pending",
      media_object_key: "/objects/fax/abc",
      media_content_type: "application/pdf",
      ...overrides,
    },
  });
}

beforeEach(() => {
  supabaseMock.reset();
  extractMock.mockReset();
  getFileMock.mockClear();
  downloadObjectMock.mockClear();
});

describe("runReviewExtraction", () => {
  it("persists an extracted result", async () => {
    stageReview();
    stageSupabaseResponse("referral_reviews", "update", { data: null });
    extractMock.mockResolvedValue({
      status: "extracted",
      model: "claude-sonnet-4-6",
      extractedAt: "2026-06-12T00:00:00.000Z",
      extraction: { patient: { firstName: "Jane" } },
    });
    const outcome = await runReviewExtraction(REVIEW_ID);
    expect(outcome).toEqual({ kind: "ran", status: "extracted" });
    const upd = getSupabaseWritePayloads(
      "referral_reviews",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd).toMatchObject({
      status: "extracted",
      extraction_model: "claude-sonnet-4-6",
      error_reason: null,
    });
  });

  it("persists a failed result with its reason", async () => {
    stageReview();
    stageSupabaseResponse("referral_reviews", "update", { data: null });
    extractMock.mockResolvedValue({
      status: "failed",
      reason: "unparseable_model_output",
    });
    const outcome = await runReviewExtraction(REVIEW_ID);
    expect(outcome).toEqual({ kind: "ran", status: "failed" });
    const upd = getSupabaseWritePayloads(
      "referral_reviews",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd).toMatchObject({
      status: "failed",
      extraction: null,
      error_reason: "unparseable_model_output",
    });
  });

  it("returns not_found for a missing review", async () => {
    stageSupabaseResponse("referral_reviews", "select", { data: null });
    expect(await runReviewExtraction(REVIEW_ID)).toEqual({
      kind: "not_found",
    });
  });

  it("leaves settled reviews alone even when forced", async () => {
    stageReview({ status: "accepted" });
    expect(await runReviewExtraction(REVIEW_ID, { force: true })).toEqual({
      kind: "already_terminal",
      status: "accepted",
    });
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("skips a non-pending row without force (duplicate job delivery)", async () => {
    stageReview({ status: "extracted" });
    expect(await runReviewExtraction(REVIEW_ID)).toEqual({
      kind: "already_terminal",
      status: "extracted",
    });
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("re-runs a non-pending row with force", async () => {
    stageReview({ status: "failed" });
    stageSupabaseResponse("referral_reviews", "update", { data: null });
    extractMock.mockResolvedValue({ status: "offline" });
    expect(await runReviewExtraction(REVIEW_ID, { force: true })).toEqual({
      kind: "ran",
      status: "offline",
    });
  });

  it("returns media_missing when no object key", async () => {
    stageReview({ media_object_key: null });
    expect(await runReviewExtraction(REVIEW_ID)).toEqual({
      kind: "media_missing",
    });
  });

  it("returns media_missing when the object was reaped", async () => {
    stageReview();
    getFileMock.mockRejectedValueOnce(new ObjectNotFoundErrorClass());
    expect(await runReviewExtraction(REVIEW_ID)).toEqual({
      kind: "media_missing",
    });
  });

  it("propagates a transient storage error so the job retries", async () => {
    stageReview();
    getFileMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(runReviewExtraction(REVIEW_ID)).rejects.toThrow(
      "socket hang up",
    );
  });
});
