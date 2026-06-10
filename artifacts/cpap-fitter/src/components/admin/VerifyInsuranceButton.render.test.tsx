// @vitest-environment jsdom
//
// Render test for the patient Quick-actions "Verify insurance" button.
// Mirrors PatientBillingTab.check-eligibility.render.test.tsx: mocks
// react-query (so the coverage query resolves deterministically) and the
// eligibility API so we can assert the button runs a 270/271 for the
// patient's primary coverage and surfaces the real-time result inline.

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

vi.mock("@/lib/admin/clinical-tabs-api", () => ({
  listInsuranceCoverages: vi.fn(),
  verifyEligibility: vi.fn(),
}));

import { verifyEligibility } from "@/lib/admin/clinical-tabs-api";

import { VerifyInsuranceButton } from "./VerifyInsuranceButton";

beforeEach(() => {
  cleanup();
  queryData.current = {
    "patient-coverages": {
      coverages: [
        { id: "cov-2", rank: "secondary", payerName: "Medicare" },
        { id: "cov-1", rank: "primary", payerName: "Aetna" },
      ],
    },
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
    latencyMs: 1200,
  });
});

describe("VerifyInsuranceButton", () => {
  it("runs a 270/271 for the primary coverage and shows the real-time result", async () => {
    render(<VerifyInsuranceButton patientId="p-1" />);

    fireEvent.click(screen.getByTestId("patient-verify-insurance"));

    await waitFor(() => {
      expect(vi.mocked(verifyEligibility)).toHaveBeenCalledWith("p-1", "cov-1");
    });
    expect(await screen.findByText(/Verified in real time/)).toBeTruthy();
    expect(screen.getByText(/1\.2s/)).toBeTruthy();
  });

  it("labels the button with the coverage it will run against", () => {
    render(<VerifyInsuranceButton patientId="p-1" />);
    expect(screen.getByText(/Aetna · primary/)).toBeTruthy();
  });

  it("disables the button and explains when the patient has no coverage", () => {
    queryData.current["patient-coverages"] = { coverages: [] };
    render(<VerifyInsuranceButton patientId="p-1" />);
    const btn = screen.getByTestId(
      "patient-verify-insurance",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/No insurance coverage on file/)).toBeTruthy();
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
    render(<VerifyInsuranceButton patientId="p-1" />);
    fireEvent.click(screen.getByTestId("patient-verify-insurance"));
    expect(await screen.findByText(/270 submitted/)).toBeTruthy();
  });

  it("shows the error message when the check fails", async () => {
    vi.mocked(verifyEligibility).mockRejectedValue(
      new Error("clearinghouse unreachable"),
    );
    render(<VerifyInsuranceButton patientId="p-1" />);
    fireEvent.click(screen.getByTestId("patient-verify-insurance"));
    expect(await screen.findByText(/clearinghouse unreachable/)).toBeTruthy();
  });
});
