// Tests for the pure work-item deep-link mapping (CSR #10).

import { describe, it, expect } from "vitest";

import { workItemHref, KIND_META } from "./admin-work-queue";
import type { WorkItem, WorkItemKind } from "@/lib/admin/work-items-api";

function item(kind: WorkItemKind, refId = "abc"): WorkItem {
  return {
    kind,
    refId,
    createdAt: "2026-05-01T00:00:00Z",
    dueAt: null,
    sortAt: "2026-05-01T00:00:00Z",
    overdueHours: null,
  };
}

describe("workItemHref", () => {
  it("routes a conversation to its detail page by refId", () => {
    expect(workItemHref(item("conversation", "c123"))).toBe(
      "/admin/conversations/c123",
    );
  });

  it("routes each non-conversation kind to its handling surface", () => {
    expect(workItemHref(item("return"))).toBe("/admin/shop/returns");
    expect(workItemHref(item("review"))).toBe("/admin/shop/reviews");
    expect(workItemHref(item("patient_document"))).toBe(
      "/admin/patient-documents/retention",
    );
    expect(workItemHref(item("followup"))).toBe("/admin/followups");
    expect(workItemHref(item("fax"))).toBe("/admin/inbound-faxes");
  });

  it("has a label + variant for every kind", () => {
    const kinds: WorkItemKind[] = [
      "conversation",
      "followup",
      "return",
      "review",
      "patient_document",
      "fax",
    ];
    for (const k of kinds) {
      expect(KIND_META[k].label.length).toBeGreaterThan(0);
      expect(KIND_META[k].variant).toBeTruthy();
    }
  });
});
