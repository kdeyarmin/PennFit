// Unit tests for safeAuditFromActor.
//
// The helper is a thin translator between the SendActor union and the
// AuditEvent shape `logAudit` expects, plus an "absorb errors" wrapper
// (per ADR 008 — audit-write failures must not surface to the caller
// because vendor SDKs retry on 5xx and would multi-audit).
//
// We mock @workspace/resupply-audit so these tests do not need a live
// Postgres pool — the goal here is to lock down the field-mapping and
// error-swallowing contract, not to re-test the audit writer itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logAuditMock } = vi.hoisted(() => ({
  logAuditMock: vi.fn<(event: unknown) => Promise<void>>(),
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import { safeAuditFromActor } from "./safe-audit";
import type { SendActor } from "./types";

describe("safeAuditFromActor", () => {
  beforeEach(() => {
    logAuditMock.mockReset();
    logAuditMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logAuditMock.mockReset();
  });

  describe("admin actor", () => {
    const adminActor: SendActor = {
      kind: "admin",
      adminEmail: "ops@penn.example.com",
      adminUserId: "user_abc123",
      ip: "10.0.0.1",
      userAgent: "vitest/1.0",
    };

    it("forwards admin envelope fields and tags metadata with actor_kind=admin", async () => {
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: adminActor,
        targetTable: "conversations",
        targetId: "conv-1",
        metadata: { channel: "sms", patient_id: "p-1" },
      });

      expect(logAuditMock).toHaveBeenCalledTimes(1);
      expect(logAuditMock).toHaveBeenCalledWith({
        action: "messaging.reminder.sent",
        adminEmail: "ops@penn.example.com",
        adminUserId: "user_abc123",
        targetTable: "conversations",
        targetId: "conv-1",
        metadata: {
          channel: "sms",
          patient_id: "p-1",
          actor_kind: "admin",
        },
        ip: "10.0.0.1",
        userAgent: "vitest/1.0",
      });
    });

    it("does not leak job_id into admin metadata", async () => {
      await safeAuditFromActor({
        action: "messaging.reply.sent",
        actor: adminActor,
        targetTable: "conversations",
        targetId: "conv-2",
        metadata: { channel: "email" },
      });

      const call = logAuditMock.mock.calls[0]![0] as {
        metadata: Record<string, unknown>;
      };
      expect(call.metadata).not.toHaveProperty("job_id");
      expect(call.metadata.actor_kind).toBe("admin");
    });

    it("preserves caller-provided metadata fields verbatim", async () => {
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: adminActor,
        targetTable: "conversations",
        targetId: "conv-3",
        metadata: {
          channel: "sms",
          patient_id: "p-9",
          episode_id: "ep-9",
          conversation_id: "conv-3",
          status: "ok",
          twilio_message_sid: "SM123",
        },
      });

      const call = logAuditMock.mock.calls[0]![0] as {
        metadata: Record<string, unknown>;
      };
      expect(call.metadata).toMatchObject({
        channel: "sms",
        patient_id: "p-9",
        episode_id: "ep-9",
        conversation_id: "conv-3",
        status: "ok",
        twilio_message_sid: "SM123",
        actor_kind: "admin",
      });
    });

    it("forwards null admin envelope fields when admin identity is partial", async () => {
      // adminEmail/adminUserId can legitimately be null — e.g. a system
      // verb invoked through an admin route where we don't have the
      // operator's email yet (auth middleware degraded). The translator
      // must propagate the nulls rather than substituting placeholders.
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: {
          kind: "admin",
          adminEmail: null,
          adminUserId: null,
          ip: null,
          userAgent: null,
        },
        targetTable: "conversations",
        targetId: "conv-4",
        metadata: {},
      });

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          adminEmail: null,
          adminUserId: null,
          ip: null,
          userAgent: null,
          metadata: { actor_kind: "admin" },
        }),
      );
    });
  });

  describe("system actor", () => {
    it("nulls admin envelope fields and includes job_id in metadata", async () => {
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: { kind: "system", jobId: "job_xyz" },
        targetTable: "conversations",
        targetId: "conv-5",
        metadata: { channel: "sms", patient_id: "p-2" },
      });

      expect(logAuditMock).toHaveBeenCalledTimes(1);
      expect(logAuditMock).toHaveBeenCalledWith({
        action: "messaging.reminder.sent",
        adminEmail: null,
        adminUserId: null,
        targetTable: "conversations",
        targetId: "conv-5",
        metadata: {
          channel: "sms",
          patient_id: "p-2",
          actor_kind: "system",
          job_id: "job_xyz",
        },
        ip: null,
        userAgent: null,
      });
    });

    it("propagates a null jobId rather than dropping the field", async () => {
      // pg-boss does not always provide a job id (e.g. eager local
      // invocation in tests). The audit row should still surface that
      // a system actor wrote it; we explicitly set job_id=null instead
      // of omitting the property so admins can distinguish "system run
      // with unknown job" from "metadata field missing".
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: { kind: "system", jobId: null },
        targetTable: "conversations",
        targetId: "conv-6",
        metadata: { channel: "email" },
      });

      const call = logAuditMock.mock.calls[0]![0] as {
        metadata: Record<string, unknown>;
      };
      expect(call.metadata).toEqual({
        channel: "email",
        actor_kind: "system",
        job_id: null,
      });
    });
  });

  describe("structural-only audits", () => {
    it("forwards null targetTable and targetId without coercion", async () => {
      // messaging.phone_lookup.conflict is the canonical structural
      // audit — it points at no single row.
      await safeAuditFromActor({
        action: "messaging.phone_lookup.conflict",
        actor: { kind: "system", jobId: "job_1" },
        targetTable: null,
        targetId: null,
        metadata: { reason: "phone_in_use_by_other_patient" },
      });

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          targetTable: null,
          targetId: null,
        }),
      );
    });
  });

  describe("metadata isolation", () => {
    it("does not mutate the caller's metadata object", async () => {
      const meta = { channel: "sms" as const, patient_id: "p-3" };
      const before = { ...meta };

      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: { kind: "system", jobId: "job_keep" },
        targetTable: "conversations",
        targetId: "conv-7",
        metadata: meta,
      });

      // The helper composes via spread; the caller's reference must
      // be untouched so it can be reused / inspected after the call.
      expect(meta).toEqual(before);
      expect(meta).not.toHaveProperty("actor_kind");
      expect(meta).not.toHaveProperty("job_id");
    });

    it("caller's actor_kind in metadata is overridden by the translator", async () => {
      // If a caller (incorrectly) supplies actor_kind themselves, the
      // translator's value must win — otherwise a buggy caller could
      // forge a "system" row from an admin actor (or vice versa).
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: {
          kind: "admin",
          adminEmail: "a@b.com",
          adminUserId: "u",
          ip: null,
          userAgent: null,
        },
        targetTable: "conversations",
        targetId: "conv-8",
        metadata: { actor_kind: "system" as unknown as string },
      });

      const call = logAuditMock.mock.calls[0]![0] as {
        metadata: Record<string, unknown>;
      };
      expect(call.metadata.actor_kind).toBe("admin");
    });
  });

  describe("error swallowing (ADR 008)", () => {
    it("resolves without throwing when logAudit rejects", async () => {
      logAuditMock.mockRejectedValueOnce(new Error("pg connection refused"));

      // The promise must RESOLVE — vendor SDKs retry on any thrown
      // exception, which would multi-audit if we surfaced this.
      await expect(
        safeAuditFromActor({
          action: "messaging.reminder.sent",
          actor: { kind: "system", jobId: "job_err" },
          targetTable: "conversations",
          targetId: "conv-9",
          metadata: { channel: "sms" },
        }),
      ).resolves.toBeUndefined();
    });

    it("resolves without throwing when logAudit throws synchronously", async () => {
      logAuditMock.mockImplementationOnce(() => {
        throw new Error("sync boom");
      });

      await expect(
        safeAuditFromActor({
          action: "messaging.reminder.sent",
          actor: {
            kind: "admin",
            adminEmail: "a@b.com",
            adminUserId: "u",
            ip: null,
            userAgent: null,
          },
          targetTable: "conversations",
          targetId: "conv-10",
          metadata: {},
        }),
      ).resolves.toBeUndefined();
    });

    it("still calls logAudit exactly once even when it fails", async () => {
      logAuditMock.mockRejectedValueOnce(new Error("transient"));

      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor: { kind: "system", jobId: "j" },
        targetTable: null,
        targetId: null,
        metadata: {},
      });

      // No retry inside the helper — retry policy belongs to the
      // separate audit-rate alert path, not to the writer.
      expect(logAuditMock).toHaveBeenCalledTimes(1);
    });
  });
});
