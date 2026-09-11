import { describe, expect, it, vi } from "vitest";
import {
  buildOutboundDisableQuery,
  disablePreviewOutbound,
  OUTBOUND_FEATURE_KEYS,
  parseDisableArgs,
} from "./disable-outbound.mjs";

const seed = "10000000-0000-0000-0000-000000000001";
const tenant = "10000000-0000-0000-0000-000000000002";
const rows = [
  { id: seed, slug: "penn-home-medical", status: "active" },
  { id: tenant, slug: "preview-synthetic", status: "active" },
];

function harness({
  organizations = rows,
  updateError = null,
  shortWrite = false,
} = {}) {
  const statements = [];
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (query, values) => {
      const text = typeof query === "string" ? query : query.text;
      statements.push({ text, values: values ?? query.values });
      if (text.includes("SELECT id, slug")) return { rows: organizations };
      if (text.startsWith("INSERT")) {
        if (updateError) throw updateError;
        return {
          rowCount: shortWrite ? 1 : rows.length * OUTBOUND_FEATURE_KEYS.length,
        };
      }
      return {};
    }),
  };
  const assertIdentity = vi
    .fn()
    .mockResolvedValue({ projectRef: "synthetic-ref" });
  const createClient = vi.fn(() => client);
  return { client, assertIdentity, createClient, statements };
}

describe("preview outbound setup", () => {
  it("never connects when the shared identity guard rejects", async () => {
    const h = harness();
    h.assertIdentity.mockRejectedValue(new Error("not an isolated preview"));
    await expect(
      disablePreviewOutbound({ orgIds: [seed, tenant], apply: true }, h),
    ).rejects.toThrow("not an isolated preview");
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it("dry runs with a read-only transaction and no feature writes", async () => {
    const h = harness();
    const result = await disablePreviewOutbound({ orgIds: [seed, tenant] }, h);
    expect(result.applied).toBe(false);
    expect(h.statements[0].text).toBe("BEGIN READ ONLY");
    expect(h.statements.some((q) => q.text.startsWith("INSERT"))).toBe(false);
    expect(h.statements.at(-1).text).toBe("ROLLBACK");
    expect(h.client.end).toHaveBeenCalledOnce();
  });

  it("passes confirmation to the guard and commits only the explicit outbound set", async () => {
    const h = harness();
    const result = await disablePreviewOutbound(
      {
        orgIds: [seed, tenant],
        apply: true,
        confirmDisposableProject: "synthetic-ref",
      },
      h,
    );
    expect(h.assertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: true,
        confirmDisposableProject: "synthetic-ref",
      }),
    );
    const mutation = h.statements.find((q) => q.text.startsWith("INSERT"));
    expect(mutation.values[0]).toEqual([seed, tenant]);
    expect(mutation.values[1]).toEqual(
      expect.arrayContaining([
        "sms.reminders",
        "email.reminders",
        "patient_packets.autoremind",
      ]),
    );
    expect(
      mutation.values[1].some(
        (key) => key.startsWith("module.") || key.startsWith("resupply."),
      ),
    ).toBe(false);
    expect(mutation.text).not.toContain(seed);
    expect(result.applied).toBe(true);
    expect(h.statements.at(-1).text).toBe("COMMIT");
  });

  it.each([
    { orgIds: [seed] },
    { orgIds: [tenant] },
    { orgIds: [seed, "10000000-0000-0000-0000-000000000099"] },
  ])(
    "refuses incomplete or unknown organization set $orgIds before a write",
    async ({ orgIds }) => {
      const h = harness();
      await expect(
        disablePreviewOutbound({ orgIds, apply: true }, h),
      ).rejects.toThrow();
      expect(h.statements.some((q) => q.text.startsWith("INSERT"))).toBe(false);
      expect(h.statements.at(-1).text).toBe("ROLLBACK");
    },
  );

  it("rolls back an incomplete write", async () => {
    const h = harness({ shortWrite: true });
    await expect(
      disablePreviewOutbound({ orgIds: [seed, tenant], apply: true }, h),
    ).rejects.toThrow("complete expected set");
    expect(h.statements.at(-1).text).toBe("ROLLBACK");
  });

  it("preserves the database error while rolling back and closing the client", async () => {
    const error = new Error("synthetic update failure");
    const h = harness({ updateError: error });
    await expect(
      disablePreviewOutbound({ orgIds: [seed, tenant], apply: true }, h),
    ).rejects.toBe(error);
    expect(h.statements.at(-1).text).toBe("ROLLBACK");
    expect(h.client.end).toHaveBeenCalledOnce();
  });

  it("rejects malformed org IDs and unknown options without SQL interpolation", () => {
    expect(() => buildOutboundDisableQuery(["' OR TRUE --"])).toThrow("UUID");
    expect(() => parseDisableArgs([`--org-ids=${seed}`, "--aply"])).toThrow();
    expect(parseDisableArgs([`--org-ids=${seed},${seed}`]).orgIds).toEqual([
      seed,
    ]);
  });
});
