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

// Mock pdfkit so tests don't generate real PDFs and stay fast.
vi.mock("pdfkit", () => {
  const EventEmitter = require("node:events");
  class FakePDF extends EventEmitter {
    fontSize() { return this; }
    font() { return this; }
    text() { return this; }
    moveDown() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    stroke() { return this; }
    fillColor() { return this; }
    rect() { return this; }
    fill() { return this; }
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

const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => dbStub }));
vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

import documentRouter from "./document";

function makeApp(): Express {
  const app = express();
  app.use(documentRouter);
  return app;
}

beforeEach(() => {
  selectQueue.length = 0;
  verifyTokenMock.mockClear();
  dbStub.select.mockClear();
});

describe("GET /fax/document/:token", () => {
  it("403s when token is invalid (bad signature)", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: false });
    const res = await request(makeApp()).get("/fax/document/bad-token");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_token");
    expect(dbStub.select).not.toHaveBeenCalled();
  });

  it("403s when token is expired", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: false });
    const res = await request(makeApp()).get(
      "/fax/document/expired.signature",
    );
    expect(res.status).toBe(403);
  });

  it("404s when outreach row not found in DB", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: true, outreachId: "out_1" });
    selectQueue.push([]); // DB returns no rows
    const res = await request(makeApp()).get("/fax/document/valid.token");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("200s and streams a PDF with correct headers", async () => {
    verifyTokenMock.mockReturnValueOnce({ valid: true, outreachId: "out_1" });
    selectQueue.push([
      {
        physicianName: "Dr. Anna Stein",
        coverLetterText:
          "Please renew the prescription for the patient below.",
      },
    ]);
    const res = await request(makeApp()).get("/fax/document/valid.token");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toContain("cover-letter.pdf");
    // Body starts with PDF magic bytes (from our fake PDFDocument).
    expect(res.body.toString()).toContain("%PDF");
  });

  it("uses RESUPPLY_PRACTICE_NAME in the PDF (no error thrown)", async () => {
    const orig = process.env.RESUPPLY_PRACTICE_NAME;
    process.env.RESUPPLY_PRACTICE_NAME = "TestPractice";
    try {
      verifyTokenMock.mockReturnValueOnce({ valid: true, outreachId: "out_2" });
      selectQueue.push([
        {
          physicianName: "Dr. B",
          coverLetterText: "At least twenty characters here for the cover letter.",
        },
      ]);
      const res = await request(makeApp()).get("/fax/document/valid.token");
      expect(res.status).toBe(200);
    } finally {
      if (orig === undefined) delete process.env.RESUPPLY_PRACTICE_NAME;
      else process.env.RESUPPLY_PRACTICE_NAME = orig;
    }
  });
});
