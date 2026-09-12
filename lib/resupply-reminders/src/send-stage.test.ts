import { describe, expect, it } from "vitest";
import { isReminderPreSendError, withReminderSendStage } from "./send-stage";

describe("reminder send-stage signal", () => {
  it("preserves frozen error objects without altering their fields", async () => {
    const error = Object.freeze({ code: "08006", message: "Connection lost" });
    await expect(
      withReminderSendStage(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(isReminderPreSendError(error)).toBe(true);
    expect(Object.keys(error)).toEqual(["code", "message"]);
  });

  it("does not carry a prior pre-send marker onto a reused provider exception", async () => {
    const error = new Error("Reused transport error");
    await withReminderSendStage(async () => {
      throw error;
    }).catch(() => undefined);
    expect(isReminderPreSendError(error)).toBe(true);
    await expect(
      withReminderSendStage(async (stage) => {
        stage.markProviderAttempted();
        throw error;
      }),
    ).rejects.toBe(error);
    expect(isReminderPreSendError(error)).toBe(false);
  });
});
