// Route tests for /admin/outreach-playbooks.
//
// Coverage:
//   * 401 without admin; 403 for CSRs on the editor surface
//     (admin.tools.manage) while the start/run/call surfaces stay
//     open to conversations.manage.
//   * GET serializes playbooks + steps + active-run counts.
//   * POST rejects step lists with unknown variables / missing email
//     subjects; creates playbook + steps rows on the happy path.
//   * POST /:id/start guards patient status and maps the partial-
//     unique violation to 409; returns the touch schedule on success.
//   * cancel + call-task complete map "no row updated" to 409.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import outreachPlaybooksRouter from "./outreach-playbooks";

const PLAYBOOK_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(outreachPlaybooksRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/outreach-playbooks", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/outreach-playbooks");
    expect(res.status).toBe(401);
  });

  it("serializes playbooks with steps and active-run counts", async () => {
    mockAdmin.current = CSR; // conversations.manage is enough to read
    stageSupabaseResponse("outreach_playbooks", "select", {
      data: [
        {
          id: PLAYBOOK_ID,
          playbook_key: "resupply_due",
          name: "Supplies due",
          situation: "Eligible to re-order.",
          description: null,
          category: "resupply",
          is_active: true,
          is_seeded: true,
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("outreach_playbook_steps", "select", {
      data: [
        {
          id: "s1",
          playbook_id: PLAYBOOK_ID,
          step_index: 1,
          day_offset: 0,
          channel: "email",
          subject: "Hello",
          body: "Hi {{first_name}}",
        },
      ],
    });
    stageSupabaseResponse("outreach_playbook_runs", "select", {
      data: [{ playbook_id: PLAYBOOK_ID }, { playbook_id: PLAYBOOK_ID }],
    });

    const res = await request(makeApp()).get("/admin/outreach-playbooks");
    expect(res.status).toBe(200);
    expect(res.body.playbooks).toHaveLength(1);
    expect(res.body.playbooks[0]).toMatchObject({
      id: PLAYBOOK_ID,
      name: "Supplies due",
      activeRunCount: 2,
    });
    expect(res.body.playbooks[0].steps).toEqual([
      {
        id: "s1",
        stepIndex: 1,
        dayOffset: 0,
        channel: "email",
        subject: "Hello",
        body: "Hi {{first_name}}",
      },
    ]);
  });
});

describe("POST /admin/outreach-playbooks", () => {
  const validBody = {
    name: "Custom outreach",
    situation: "When something happens.",
    category: "service",
    steps: [
      {
        dayOffset: 0,
        channel: "sms",
        body: "Hi {{first_name}}. Reply STOP to opt out.",
      },
    ],
  };

  it("403s for CSRs (editor surface is admin.tools.manage)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post("/admin/outreach-playbooks")
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it("400s on unknown variables with the offending token", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/outreach-playbooks")
      .send({
        ...validBody,
        steps: [{ dayOffset: 0, channel: "sms", body: "Hi {{first_nme}}" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_steps");
    expect(String(res.body.problems)).toContain("{{first_nme}}");
  });

  it("400s on an email step without a subject", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/outreach-playbooks")
      .send({
        ...validBody,
        steps: [{ dayOffset: 0, channel: "email", body: "Hello" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_steps");
  });

  it("creates the playbook header and step rows", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("outreach_playbooks", "insert", {
      data: { id: PLAYBOOK_ID },
    });
    stageSupabaseResponse("outreach_playbook_steps", "insert", { data: [] });

    const res = await request(makeApp())
      .post("/admin/outreach-playbooks")
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PLAYBOOK_ID);
    expect(res.body.playbookKey).toMatch(/^custom_custom_outreach_/);

    const stepWrites = getSupabaseWritePayloads(
      "outreach_playbook_steps",
      "insert",
    );
    expect(stepWrites).toHaveLength(1);
    expect(stepWrites[0]).toEqual([
      {
        playbook_id: PLAYBOOK_ID,
        step_index: 1,
        day_offset: 0,
        channel: "sms",
        subject: null,
        body: "Hi {{first_name}}. Reply STOP to opt out.",
      },
    ]);
  });
});

describe("POST /admin/outreach-playbooks/:id/start", () => {
  function stageStartReads(patientStatus: string) {
    stageSupabaseResponse("outreach_playbooks", "select", {
      data: { id: PLAYBOOK_ID, name: "Supplies due", is_active: true },
    });
    stageSupabaseResponse("outreach_playbook_steps", "select", {
      data: [
        { step_index: 1, day_offset: 0, channel: "sms" },
        { step_index: 2, day_offset: 3, channel: "call" },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT_ID, status: patientStatus },
    });
  }

  it("CSRs may start runs (conversations.manage)", async () => {
    mockAdmin.current = CSR;
    stageStartReads("active");
    stageSupabaseResponse("outreach_playbook_runs", "insert", {
      data: { id: RUN_ID },
    });
    const res = await request(makeApp())
      .post(`/admin/outreach-playbooks/${PLAYBOOK_ID}/start`)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBe(RUN_ID);
    expect(res.body.schedule).toHaveLength(2);
    expect(res.body.schedule[0]).toMatchObject({
      stepIndex: 1,
      channel: "sms",
    });
  });

  it("409s for non-active patients", async () => {
    mockAdmin.current = ADMIN;
    stageStartReads("paused");
    const res = await request(makeApp())
      .post(`/admin/outreach-playbooks/${PLAYBOOK_ID}/start`)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("patient_not_active");
  });

  it("maps the one-active-run unique violation to 409", async () => {
    mockAdmin.current = ADMIN;
    stageStartReads("active");
    stageSupabaseResponse("outreach_playbook_runs", "insert", {
      error: { code: "23505", message: "duplicate key" },
    });
    const res = await request(makeApp())
      .post(`/admin/outreach-playbooks/${PLAYBOOK_ID}/start`)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("run_already_active");
  });
});

describe("POST /admin/outreach-playbooks/runs/:id/cancel", () => {
  it("409s when the run is not active", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("outreach_playbook_runs", "update", { data: [] });
    const res = await request(makeApp()).post(
      `/admin/outreach-playbooks/runs/${RUN_ID}/cancel`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("run_not_active");
  });

  it("cancels and skips the run's open call tasks", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("outreach_playbook_runs", "update", {
      data: [{ id: RUN_ID }],
    });
    stageSupabaseResponse("outreach_playbook_step_log", "update", {
      data: [],
    });
    const res = await request(makeApp()).post(
      `/admin/outreach-playbooks/runs/${RUN_ID}/cancel`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: RUN_ID, status: "cancelled" });
    const skipWrites = getSupabaseWritePayloads(
      "outreach_playbook_step_log",
      "update",
    );
    expect(skipWrites[0]).toMatchObject({
      status: "skipped",
      detail: "run_cancelled",
    });
  });
});

describe("POST /admin/outreach-playbooks/call-tasks/:id/complete", () => {
  it("400s on an unknown outcome", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(`/admin/outreach-playbooks/call-tasks/${TASK_ID}/complete`)
      .send({ outcome: "not_a_thing" });
    expect(res.status).toBe(400);
  });

  it("409s when the task is already completed", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("outreach_playbook_step_log", "update", {
      data: [],
    });
    const res = await request(makeApp())
      .post(`/admin/outreach-playbooks/call-tasks/${TASK_ID}/complete`)
      .send({ outcome: "reached" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("task_not_open");
  });

  it("completes with the disposition + actor email", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("outreach_playbook_step_log", "update", {
      data: [{ id: TASK_ID }],
    });
    const res = await request(makeApp())
      .post(`/admin/outreach-playbooks/call-tasks/${TASK_ID}/complete`)
      .send({ outcome: "voicemail" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: TASK_ID, status: "call_completed" });
    const writes = getSupabaseWritePayloads(
      "outreach_playbook_step_log",
      "update",
    );
    expect(writes[0]).toMatchObject({
      status: "call_completed",
      call_outcome: "voicemail",
      completed_by_email: CSR.email,
    });
  });
});
