// Tests for /admin/work-items (Phase 0 / F4 unified work queue).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import workItemsRouter, { buildWorkItems } from "./work-items";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

const EMPTY = {
  conversations: [],
  returns: [],
  reviews: [],
  documents: [],
  shopFollowups: [],
  patientFollowups: [],
  faxes: [],
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(workItemsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildWorkItems", () => {
  const NOW = "2026-05-31T12:00:00.000Z";

  it("merges sources, sorts oldest/most-overdue first, computes overdue hours", () => {
    const items = buildWorkItems(
      {
        ...EMPTY,
        conversations: [{ id: "c1", created_at: "2026-05-31T10:00:00.000Z" }],
        shopFollowups: [
          {
            id: "f1",
            created_at: "2026-05-20T00:00:00.000Z",
            due_at: "2026-05-30T00:00:00.000Z",
          },
        ],
        faxes: [{ id: "x1", created_at: "2026-05-29T00:00:00.000Z" }],
      },
      NOW,
    );
    // sortAt: x1 created 05-29 < f1 due 05-30 < c1 created 05-31.
    expect(items.map((i) => i.refId)).toEqual(["x1", "f1", "c1"]);

    const f1 = items.find((i) => i.refId === "f1");
    expect(f1?.kind).toBe("followup");
    expect(f1?.dueAt).toBe("2026-05-30T00:00:00.000Z");
    expect(f1?.overdueHours).toBeCloseTo(36, 1); // 05-30T00:00 → 05-31T12:00

    expect(items.find((i) => i.refId === "c1")?.overdueHours).toBeNull();
  });

  it("tags each kind correctly", () => {
    const items = buildWorkItems(
      {
        ...EMPTY,
        returns: [{ id: "r1", created_at: NOW }],
        reviews: [{ id: "v1", created_at: NOW }],
        documents: [{ id: "d1", created_at: NOW }],
        patientFollowups: [{ id: "p1", created_at: NOW, due_at: NOW }],
      },
      NOW,
    );
    const byRef = Object.fromEntries(items.map((i) => [i.refId, i.kind]));
    expect(byRef).toEqual({
      r1: "return",
      v1: "review",
      d1: "patient_document",
      p1: "followup",
    });
  });

  it("skips rows without an id", () => {
    const items = buildWorkItems(
      { ...EMPTY, conversations: [{ created_at: NOW }] },
      NOW,
    );
    expect(items).toEqual([]);
  });
});

describe("GET /admin/work-items", () => {
  it("401s without admin", async () => {
    expect((await request(makeApp()).get("/admin/work-items")).status).toBe(
      401,
    );
  });

  it("returns the merged, sorted queue across sources", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("conversations", "select", {
      data: [{ id: "c1", created_at: "2026-05-31T10:00:00.000Z" }],
    });
    stageSupabaseResponse("inbound_faxes", "select", {
      data: [{ id: "x1", created_at: "2026-05-29T00:00:00.000Z" }],
    });
    // Other sources unstaged → empty.

    const res = await request(makeApp()).get("/admin/work-items");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    // fax (05-29) is older than the conversation (05-31) → fax first.
    expect(res.body.workItems.map((w: { refId: string }) => w.refId)).toEqual([
      "x1",
      "c1",
    ]);
    expect(res.body.workItems[0].kind).toBe("fax");
    expect(res.body.degradedSources).toEqual([]);
  });

  it("degrades a single failing source instead of 500ing the whole queue", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("conversations", "select", {
      data: [{ id: "c1", created_at: "2026-05-31T10:00:00.000Z" }],
    });
    // The fax source errors (transient blip). The queue should still
    // return the conversation and name `faxes` as degraded.
    stageSupabaseResponse("inbound_faxes", "select", {
      data: null,
      error: { message: "boom" },
    });

    const res = await request(makeApp()).get("/admin/work-items");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.workItems[0].refId).toBe("c1");
    expect(res.body.degradedSources).toEqual(["faxes"]);
  });
});
