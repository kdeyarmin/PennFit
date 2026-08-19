// @vitest-environment jsdom
//
// Render test for /admin/documents/retention — the retention worklist.
// Pins the three safety-relevant behaviours of the page:
//   1. The destroy affordance renders for role=admin ONLY (the server's
//      requireAdminOnly gate, mirrored client-side for legibility).
//   2. Destroy is type-to-confirm: the button stays disabled until the
//      operator types the exact DESTROY token the API validates.
//   3. A legal hold requires a non-empty reason and posts hold=!current.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";

const { queryData, adminRole } = vi.hoisted(() => ({
  queryData: { current: {} as Record<string, unknown> },
  adminRole: { current: "admin" as string },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: () => ({
    data: queryData.current["retention"] ?? null,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  }),
  useMutation: ({
    mutationFn,
    onSuccess,
    onError,
  }: {
    mutationFn: (input: unknown) => Promise<unknown>;
    onSuccess?: (r: unknown) => void;
    onError?: (e: unknown) => void;
  }) => ({
    mutate: (input: unknown) => {
      void mutationFn(input).then(
        (r) => onSuccess?.(r),
        (e) => onError?.(e),
      );
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@workspace/api-client-react/admin", () => ({
  useGetAdminMe: () => ({ data: { role: adminRole.current } }),
}));

vi.mock("@/lib/admin/document-retention-api", () => ({
  listRetentionDocuments: vi.fn(),
  setLegalHold: vi.fn().mockResolvedValue({ ok: true, legalHold: true }),
  destroyDocument: vi
    .fn()
    .mockResolvedValue({ ok: true, destroyedAt: "2026-08-19T00:00:00Z" }),
}));

import {
  destroyDocument,
  setLegalHold,
} from "@/lib/admin/document-retention-api";

import { AdminDocumentRetentionPage } from "./admin-document-retention";

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pd-1",
    patientId: "p-1",
    documentType: "prescription",
    filename: "rx-sample.pdf",
    contentType: "application/pdf",
    sizeBytes: 184320,
    createdAt: "2020-01-01T00:00:00Z",
    retentionUntilAt: "2026-08-01T00:00:00Z",
    legalHold: false,
    retentionMarkedAt: null,
    destroyedAt: null,
    bucket: "due_now",
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  adminRole.current = "admin";
  queryData.current = {
    retention: { count: 1, documents: [docRow()] },
  };
});

describe("AdminDocumentRetentionPage", () => {
  it("renders the queue row with its bucket", () => {
    render(<AdminDocumentRetentionPage />);
    expect(screen.getByTestId("admin-document-retention-page")).toBeTruthy();
    const row = screen.getByTestId("retention-row");
    expect(within(row).getByText("rx-sample.pdf")).toBeTruthy();
    expect(within(row).getByText("Due now")).toBeTruthy();
    expect(screen.getByTestId("retention-destroy-toggle")).toBeTruthy();
  });

  it("hides the destroy affordance for non-admin roles", () => {
    adminRole.current = "supervisor";
    render(<AdminDocumentRetentionPage />);
    expect(screen.getByTestId("retention-hold-toggle")).toBeTruthy();
    expect(screen.queryByTestId("retention-destroy-toggle")).toBeNull();
  });

  it("hides the destroy affordance while a legal hold is on", () => {
    queryData.current = {
      retention: {
        count: 1,
        documents: [docRow({ legalHold: true, bucket: "legal_hold" })],
      },
    };
    render(<AdminDocumentRetentionPage />);
    expect(screen.queryByTestId("retention-destroy-toggle")).toBeNull();
  });

  it("arms destroy only after the exact DESTROY token is typed", async () => {
    render(<AdminDocumentRetentionPage />);
    fireEvent.click(screen.getByTestId("retention-destroy-toggle"));
    const submit = screen.getByTestId(
      "retention-destroy-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = screen.getByLabelText("Type DESTROY to confirm");
    fireEvent.change(input, { target: { value: "destroy" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "DESTROY" } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(destroyDocument).toHaveBeenCalledWith("pd-1"));
  });

  it("requires a reason before a legal hold posts, then sends hold=true", async () => {
    render(<AdminDocumentRetentionPage />);
    fireEvent.click(screen.getByTestId("retention-hold-toggle"));
    const submit = screen.getByTestId(
      "retention-hold-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(
      screen.getByLabelText(/Reason \(placing the hold/, { exact: false }),
      { target: { value: "litigation hold — Smith v. Co" } },
    );
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() =>
      expect(setLegalHold).toHaveBeenCalledWith("pd-1", {
        hold: true,
        reason: "litigation hold — Smith v. Co",
      }),
    );
  });

  it("releasing an existing hold posts hold=false", async () => {
    queryData.current = {
      retention: {
        count: 1,
        documents: [docRow({ legalHold: true, bucket: "legal_hold" })],
      },
    };
    render(<AdminDocumentRetentionPage />);
    fireEvent.click(screen.getByTestId("retention-hold-toggle"));
    fireEvent.change(
      screen.getByLabelText(/Reason \(releasing the hold/, { exact: false }),
      { target: { value: "hold lifted by counsel" } },
    );
    fireEvent.click(screen.getByTestId("retention-hold-submit"));
    await waitFor(() =>
      expect(setLegalHold).toHaveBeenCalledWith("pd-1", {
        hold: false,
        reason: "hold lifted by counsel",
      }),
    );
  });
});
