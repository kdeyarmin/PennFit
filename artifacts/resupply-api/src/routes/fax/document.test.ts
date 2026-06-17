// Route tests for GET /fax/document/:token
//
// Coverage:
//   * 403 on missing token
//   * 403 on malformed / bad-signature token
//   * 403 on expired token
//   * 404 when outreach row not found in DB
//   * 200 streams application/pdf with correct headers on happy path
//
// PHI invariant: the cover letter text never appears in any log or
// response header — only in the streamed PDF body (which tests here
// don't inspect beyond Content-Type).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Mock pdfkit so tests don't generate real PDFs and stay fast.
vi.mock("pdfkit", async () => {
  const { EventEmitter } = await import("node:events");
  class FakePDF extends EventEmitter {
    fontSize() {
      return this;
    }
    font() {
      return this;
    }
    text() {
      return this;
    }
    moveDown() {
      return this;
    }
    moveTo() {
      return this;
    }
    lineTo() {
      return this;
    }
    stroke() {
      return this;
    }
    fillColor() {
      return this;
    }
    rect() {
      return this;
    }
    fill() {
      return this;
    }
    pipe(dest: NodeJS.WritableStream) {
      // Emit a tiny buffer so the response closes cleanly.
      dest.write(Buffer.from("%PDF-fake"));
      dest.end();
    }
    end() {}
  }
  return { default: FakePDF };
});

// Mock verifyFaxDocumentToken to control token validation in tests.
const verifyTokenMock = vi.hoisted(() =>
  vi.fn<
    (token: string) => { valid: true; outreachId: string } | { valid: false }
  >(() => ({ valid: false })),
);
vi.mock("../../lib/fax-document-token", () => ({
  verifyFaxDocumentToken: verifyTokenMock,
}));

// The route resolves its tenant from the token-referenced record via this
// helper (covered by signed-link-org.test). Stub it to the seed org so
// these tests exercise the route, not the cross-tenant lookup.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
vi.mock("../../lib/storefront/signed-link-org", () => ({
  resolveOrgIdForSignedRecord: vi.fn(async () => SEED_ORG),
}));

import documentRouter from "./document";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org";

function makeApp(): Express {
  const app = express();
  app.use(documentRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  verifyTokenMock.mockClear();
  vi.mocked(resolveOrgIdForSignedRecord).mockClear();
});

describe("GET /fax/document/:token", () => {
  it("403s when token is invalid (bad signature)", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: false });
    const res = await request(makeApp()).get("/fax/document/bad-token");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_token");
    expect(getSupabaseCallCount("physician_fax_outreach", "select")).toBe(0);
  });

  it("403s when token is expired", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: false });
    const res = await request(makeApp()).get("/fax/document/expired.signature");
    expect(res.status).toBe(403);
  });

  it("404s when outreach row not found in DB", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: true, outreachId: "out_1" });
    stageSupabaseResponse("physician_fax_outreach", "select", { data: null });
    const res = await request(makeApp()).get("/fax/document/valid.token");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("200s and streams a PDF with correct headers", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: true, outreachId: "out_1" });
    stageSupabaseResponse("physician_fax_outreach", "select", {
      data: {
        physician_name: "Dr. Anna Stein",
        cover_letter_text:
          "Please renew the prescription for the patient below.",
      },
    });
    const res = await request(makeApp()).get("/fax/document/valid.token");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toContain("cover-letter.pdf");
    // Body starts with PDF magic bytes (from our fake PDFDocument).
    expect(res.body.toString()).toContain("%PDF");
    // The tenant was resolved from the token's outreach row, not a fixed seed.
    expect(vi.mocked(resolveOrgIdForSignedRecord)).toHaveBeenCalledWith(
      "physician_fax_outreach",
      "out_1",
    );
  });

  it("uses RESUPPLY_PRACTICE_NAME in the PDF (no error thrown)", async () => {
    const orig = process.env.RESUPPLY_PRACTICE_NAME;
    process.env.RESUPPLY_PRACTICE_NAME = "TestPractice";
    try {
      verifyTokenMock.mockReturnValueOnce({ valid: true, outreachId: "out_2" });
      stageSupabaseResponse("physician_fax_outreach", "select", {
        data: {
          physician_name: "Dr. B",
          cover_letter_text:
            "At least twenty characters here for the cover letter.",
        },
      });
      const res = await request(makeApp()).get("/fax/document/valid.token");
      expect(res.status).toBe(200);
    } finally {
      if (orig === undefined) delete process.env.RESUPPLY_PRACTICE_NAME;
      else process.env.RESUPPLY_PRACTICE_NAME = orig;
    }
  });
});
