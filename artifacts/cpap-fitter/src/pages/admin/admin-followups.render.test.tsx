// @vitest-environment jsdom
//
// Render tests for the unified /admin/followups queue: bucket routing,
// subject links, patient/customer completion dispatch, and Undo.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AdminFollowupRow } from "@/lib/admin/followups-list-api";

const {
  rows,
  toastSpy,
  invalidateQueriesSpy,
  completeCustomerSpy,
  completePatientSpy,
  reopenCustomerSpy,
  reopenPatientSpy,
} = vi.hoisted(() => ({
  rows: { current: [] as AdminFollowupRow[] },
  toastSpy: vi.fn(),
  invalidateQueriesSpy: vi.fn(),
  completeCustomerSpy: vi.fn(async () => ({ id: "done", completedAt: null })),
  completePatientSpy: vi.fn(async () => ({ id: "done", completedAt: null })),
  reopenCustomerSpy: vi.fn(async () => ({ id: "open", completedAt: null })),
  reopenPatientSpy: vi.fn(async () => ({ id: "open", completedAt: null })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: invalidateQueriesSpy,
  }),
  useQuery: () => ({
    data: { followups: rows.current },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMutation: ({
    mutationFn,
    onSuccess,
    onError,
  }: {
    mutationFn: (row: AdminFollowupRow) => Promise<unknown>;
    onSuccess?: (result: unknown, row: AdminFollowupRow) => void;
    onError?: (error: unknown) => void;
  }) => ({
    mutate: (row: AdminFollowupRow) => {
      void mutationFn(row).then(
        (result) => onSuccess?.(result, row),
        (error) => onError?.(error),
      );
    },
    isPending: false,
    variables: null,
  }),
}));

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => {
    if (isValidElement(children)) {
      return cloneElement(children as ReactElement<{ href?: string }>, {
        href,
      });
    }
    return <a href={href}>{children}</a>;
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/lib/admin/followups-list-api", () => ({
  listAllAdminFollowups: vi.fn(),
}));

vi.mock("@/lib/admin/customer-followups-api", () => ({
  completeAdminCustomerFollowup: completeCustomerSpy,
  reopenAdminCustomerFollowup: reopenCustomerSpy,
}));

vi.mock("@/lib/admin/patient-followups-api", () => ({
  completeAdminPatientFollowup: completePatientSpy,
  reopenAdminPatientFollowup: reopenPatientSpy,
}));

import { AdminFollowupsPage } from "./admin-followups";

const PATIENT_ROW: AdminFollowupRow = {
  kind: "patient",
  id: "patient-fu",
  subjectId: "11111111-1111-4111-8111-111111111111",
  subjectDisplayName: "Pat Smith",
  subjectEmail: null,
  body: "Call about mask leak",
  dueAt: "2026-06-13T18:00:00.000Z",
  createdByEmail: "csr@example.com",
  createdAt: "2026-06-12T12:00:00.000Z",
};

const CUSTOMER_ROW: AdminFollowupRow = {
  kind: "shop_customer",
  id: "customer-fu",
  subjectId: "shop-customer-1",
  subjectDisplayName: "Jordan Rivera",
  subjectEmail: "jordan@example.com",
  body: "Confirm replacement cushion",
  dueAt: "2026-06-13T13:00:00.000Z",
  createdByEmail: "csr@example.com",
  createdAt: "2026-06-12T12:00:00.000Z",
};

const UPCOMING_ROW: AdminFollowupRow = {
  ...CUSTOMER_ROW,
  id: "upcoming-fu",
  body: "Check in tomorrow",
  dueAt: "2026-06-14T15:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-13T16:00:00.000Z"));
  rows.current = [PATIENT_ROW, CUSTOMER_ROW, UPCOMING_ROW];
  toastSpy.mockClear();
  invalidateQueriesSpy.mockClear();
  completeCustomerSpy.mockClear();
  completePatientSpy.mockClear();
  reopenCustomerSpy.mockClear();
  reopenPatientSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AdminFollowupsPage", () => {
  it("buckets overdue, due-today, and upcoming rows", () => {
    render(<AdminFollowupsPage />);
    expect(
      screen.getByTestId("admin-followups-bucket-overdue").textContent,
    ).toContain("Overdue (1)");
    expect(
      screen.getByTestId("admin-followups-bucket-due-today").textContent,
    ).toContain("Due today (1)");
    expect(
      screen.getByTestId("admin-followups-bucket-upcoming").textContent,
    ).toContain("Upcoming (1)");
  });

  it("routes patient and customer subject links to their owning pages", () => {
    render(<AdminFollowupsPage />);
    expect(
      screen
        .getByTestId("admin-followup-subject-link-patient-fu")
        .getAttribute("href"),
    ).toBe("/admin/patients/11111111-1111-4111-8111-111111111111");
    expect(
      screen
        .getByTestId("admin-followup-subject-link-customer-fu")
        .getAttribute("href"),
    ).toBe("/admin/shop/customers/shop-customer-1");
  });

  it("dispatches completion to the patient endpoint and exposes Undo", async () => {
    render(<AdminFollowupsPage />);
    fireEvent.click(screen.getByTestId("admin-followup-complete-patient-fu"));

    await Promise.resolve();
    await Promise.resolve();
    expect(completePatientSpy).toHaveBeenCalledWith(
      PATIENT_ROW.subjectId,
      PATIENT_ROW.id,
    );
    expect(completeCustomerSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Follow-up completed" }),
    );

    const toastArg = toastSpy.mock.calls[0]?.[0] as {
      action: { props: { onClick: () => void } };
    };
    toastArg.action.props.onClick();

    await Promise.resolve();
    await Promise.resolve();
    expect(reopenPatientSpy).toHaveBeenCalledWith(
      PATIENT_ROW.subjectId,
      PATIENT_ROW.id,
    );
  });

  it("dispatches completion to the customer endpoint", async () => {
    render(<AdminFollowupsPage />);
    fireEvent.click(screen.getByTestId("admin-followup-complete-customer-fu"));

    await Promise.resolve();
    await Promise.resolve();
    expect(completeCustomerSpy).toHaveBeenCalledWith(
      CUSTOMER_ROW.subjectId,
      CUSTOMER_ROW.id,
    );
    expect(completePatientSpy).not.toHaveBeenCalled();
  });
});
