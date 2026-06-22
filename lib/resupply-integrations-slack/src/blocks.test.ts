import { describe, expect, it } from "vitest";

import { buildAlertBlocks, buildFallbackText, severityEmoji } from "./blocks";

describe("buildAlertBlocks", () => {
  it("builds header + section + actions + context", () => {
    const blocks = buildAlertBlocks({
      title: "🔴 SLA breach",
      lines: ["Conversation PENN-123", "Overdue 45m"],
      context: "critical · just now",
      actions: [
        { kind: "link", text: "Open in admin", url: "https://x/admin/c/1" },
        {
          kind: "button",
          text: "Escalate",
          actionId: "escalate_conversation",
          value: "conv-1",
          style: "danger",
        },
      ],
    }) as Array<Record<string, unknown>>;

    expect(blocks[0]?.type).toBe("header");
    expect(blocks[1]?.type).toBe("section");
    const actions = blocks[2] as { type: string; elements: unknown[] };
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(2);
    expect(blocks[3]?.type).toBe("context");
  });

  it("omits the section when there are no non-empty lines", () => {
    const blocks = buildAlertBlocks({ title: "t", lines: ["", "  "] }) as Array<
      Record<string, unknown>
    >;
    expect(blocks.some((b) => b.type === "section")).toBe(false);
  });

  it("omits the actions block when no actions are given", () => {
    const blocks = buildAlertBlocks({ title: "t", lines: ["a"] }) as Array<
      Record<string, unknown>
    >;
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("does not leak callback button value into a link button", () => {
    const blocks = buildAlertBlocks({
      title: "t",
      lines: ["a"],
      actions: [{ kind: "link", text: "Open", url: "https://x" }],
    }) as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<Record<string, unknown>>;
    };
    expect(actions.elements[0]).not.toHaveProperty("action_id");
    expect(actions.elements[0]).toHaveProperty("url", "https://x");
  });
});

describe("buildFallbackText", () => {
  it("joins title and lines", () => {
    expect(buildFallbackText({ title: "T", lines: ["a", "b"] })).toBe(
      "T — a — b",
    );
  });
});

describe("severityEmoji", () => {
  it("maps each severity", () => {
    expect(severityEmoji("info")).toBe("🔵");
    expect(severityEmoji("warning")).toBe("🟠");
    expect(severityEmoji("critical")).toBe("🔴");
  });
});
