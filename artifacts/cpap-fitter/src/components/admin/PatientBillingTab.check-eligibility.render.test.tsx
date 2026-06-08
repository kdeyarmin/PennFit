// @vitest-environment jsdom
//
// Render test for the one-click "Check eligibility" action added to the
// patient billing tab. Mocks react-query (so the six data queries resolve
// deterministically) and the eligibility API so we can assert the button
// runs a 270/271 for the patient's primary coverage and surfaces the
// real-time result inline.

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

vi.mock("@/lib/admin/clinical-tabs-api", () => ({
  listInsuranceCoverages: vi.fn(),
  verifyEligibility: vi.fn(),
}));

import { verifyEligibility } from "@/lib/admin/clinical-tabs-api";

import { PatientBillingTab } from "./PatientBillingTab";

function defaultQueryData(): Record<string, unknown> {
  return {
    "patient-claims": { claims: [] },
    "patient-eligibility": { checks: [] },
    "patient-prior-auths": { priorAuthorizations: [] },
    "patient-statements": { statements: [] },
    "patient-doc-packets": { packets: [] },
    "patient-coverages": {
      coverages: [
        { id: "cov-1", rank: "primary", payerName: "Aetna" },
        { id: "cov-2", rank: "secondary", payerName: "Medicare" },
      ],
    },
  };
}

beforeEach(() => {
  cleanup();
  queryData.current = defaultQueryData();
  vi.mocked(verifyEligibility).mockReset();
  vi.mocked(verifyEligibility).mockResolvedValue({
    eligibilityCheckId: "eli-1",
    isaControlNumber: "000000001",
    traceReference: "trace",
    uploadOk: true,
    errorMessage: null,
    realtime: true,
    status: "parsed",
    latencyMs: 1200,
  });
});

describe("PatientBillingTab — check eligibility", () => {
  it("runs a 270/271 for the primary coverage and shows the real-time result", async () => {
    render(<PatientBillingTab patientId="p-1" />);

    const btn = screen.getByTestId("patient-billing-check-eligibility");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(vi.mocked(verifyEligibility)).toHaveBeenCalledWith("p-1", "cov-1");
    });
    expect(await screen.findByText(/Verified in real time/)).toBeTruthy();
    expect(screen.getByText(/1\.2s/)).toBeTruthy();
  });

  it("disables the button when the patient has no coverage on file", () => {
    queryData.current["patient-coverages"] = { coverages: [] };
    render(<PatientBillingTab patientId="p-1" />);
    const btn = screen.getByTestId(
      "patient-billing-check-eligibility",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("surfaces a submitted (non-real-time) result distinctly", async () => {
    vi.mocked(verifyEligibility).mockResolvedValue({
      eligibilityCheckId: "eli-2",
      isaControlNumber: "000000002",
      traceReference: "trace2",
      uploadOk: true,
      errorMessage: null,
      realtime: false,
      status: "submitted",
      latencyMs: null,
    });
    render(<PatientBillingTab patientId="p-1" />);
    fireEvent.click(screen.getByTestId("patient-billing-check-eligibility"));
    expect(await screen.findByText(/270 submitted/)).toBeTruthy();
  });
});
