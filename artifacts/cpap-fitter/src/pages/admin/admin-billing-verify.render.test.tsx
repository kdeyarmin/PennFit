// @vitest-environment jsdom
//
// Render test for the standalone /admin/billing/verify page: search a
// patient, the primary coverage pre-selects, run the check, see the
// real-time result. Mocks react-query, the patients list client, and
// the eligibility API following the pattern of
// PatientBillingTab.check-eligibility.render.test.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const { queryData } = vi.hoisted(() => ({
  queryData: { current: {} as Record<string, unknown> },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: queryData.current[String(queryKey[0])] ?? null,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
  useMutation: ({
    mutationFn,
    onSuccess,
    onError,
  }: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (r: unknown) => void;
    onError?: (e: unknown) => void;
  }) => ({
    mutate: () => {
      void mutationFn().then(
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
  listPatients: vi.fn(),
}));

vi.mock("@/lib/admin/clinical-tabs-api", () => ({
  listInsuranceCoverages: vi.fn(),
  listEligibilityChecks: vi.fn(),
  verifyEligibility: vi.fn(),
}));

import { verifyEligibility } from "@/lib/admin/clinical-tabs-api";

import { AdminBillingVerifyPage } from "./admin-billing-verify";

beforeEach(() => {
  cleanup();
  queryData.current = {
    "billing-verify-patient-search": {
      items: [
        {
          id: "p-1",
          pacwareId: "PW-77",
          firstName: "Pat",
          lastName: "Smith",
          status: "active",
          hasPhone: true,
          hasEmail: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
      limit: 10,
    },
    "patient-coverages": {
      coverages: [
        {
          id: "cov-2",
          rank: "secondary",
          payerName: "Medicare",
          memberId: "M-2",
          planName: null,
          verifiedAt: null,
        },
        {
          id: "cov-1",
          rank: "primary",
          payerName: "Aetna",
          memberId: "A-1",
          planName: "PPO",
          verifiedAt: null,
        },
      ],
    },
    "patient-eligibility": { checks: [] },
  };
  vi.mocked(verifyEligibility).mockReset();
  vi.mocked(verifyEligibility).mockResolvedValue({
    eligibilityCheckId: "eli-1",
    isaControlNumber: "000000001",
    traceReference: "trace",
    uploadOk: true,
    errorMessage: null,
    realtime: true,
    status: "parsed",
    latencyMs: 900,
  });
});

async function searchAndSelectPatient() {
  fireEvent.change(screen.getByTestId("verify-patient-search"), {
    target: { value: "Smith" },
  });
  // The search box debounces 300ms before results render.
  const option = await screen.findByTestId(
    "verify-patient-option-p-1",
    undefined,
    { timeout: 2000 },
  );
  fireEvent.click(option);
}

describe("AdminBillingVerifyPage", () => {
  it("searches, pre-selects the primary coverage, runs the check, and shows the result", async () => {
    render(<AdminBillingVerifyPage />);

    await searchAndSelectPatient();
    expect(screen.getByTestId("verify-patient-selected").textContent).toContain(
      "Pat Smith",
    );

    // Primary coverage pre-selected by the default-coverage effect.
    const primary = screen.getByTestId(
      "verify-coverage-cov-1",
    ) as HTMLInputElement;
    expect(primary.checked).toBe(true);

    fireEvent.click(screen.getByTestId("verify-run"));
    await waitFor(() => {
      expect(vi.mocked(verifyEligibility)).toHaveBeenCalledWith(
        "p-1",
        "cov-1",
        undefined,
      );
    });
    expect(await screen.findByTestId("verify-result")).toBeTruthy();
    expect(screen.getByText(/Verified in real time/)).toBeTruthy();
  });

  it("passes a typed HCPCS code through to the check", async () => {
    render(<AdminBillingVerifyPage />);
    await searchAndSelectPatient();

    fireEvent.change(screen.getByTestId("verify-hcpcs"), {
      target: { value: "e0601" },
    });
    fireEvent.click(screen.getByTestId("verify-run"));
    await waitFor(() => {
      expect(vi.mocked(verifyEligibility)).toHaveBeenCalledWith(
        "p-1",
        "cov-1",
        {
          hcpcsCode: "E0601",
        },
      );
    });
  });

  it("rejects a malformed HCPCS code before sending", async () => {
    render(<AdminBillingVerifyPage />);
    await searchAndSelectPatient();

    fireEvent.change(screen.getByTestId("verify-hcpcs"), {
      target: { value: "12345" },
    });
    expect(screen.getByText(/letter followed by four digits/)).toBeTruthy();
    const run = screen.getByTestId("verify-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });

  it("points to the chart when the patient has no coverage on file", async () => {
    queryData.current["patient-coverages"] = { coverages: [] };
    render(<AdminBillingVerifyPage />);
    await searchAndSelectPatient();
    expect(screen.getByText(/No insurance coverage on file/)).toBeTruthy();
  });

  it("surfaces a failed check inline", async () => {
    vi.mocked(verifyEligibility).mockRejectedValue(
      new Error("payer connection refused"),
    );
    render(<AdminBillingVerifyPage />);
    await searchAndSelectPatient();
    fireEvent.click(screen.getByTestId("verify-run"));
    expect(await screen.findByTestId("verify-error")).toBeTruthy();
    expect(screen.getByText(/payer connection refused/)).toBeTruthy();
  });
});
