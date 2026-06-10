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

vi.mock("@/lib/admin/billing-api", () => ({
  quickCheckEligibility: vi.fn(),
}));

vi.mock("@/lib/admin/billing-config-api", () => ({
  fetchPayerProfiles: vi.fn(),
}));

import { quickCheckEligibility } from "@/lib/admin/billing-api";
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
    "billing-verify-payers": {
      payerProfiles: [
        {
          id: "payer-1",
          displayName: "Acme Health",
          officeAllyPayerId: "OA123",
          paperOnly: false,
          memberIdFormatHint: "Starts with W, 9 digits",
        },
        {
          id: "payer-2",
          displayName: "Paper Mutual",
          officeAllyPayerId: null,
          paperOnly: true,
          memberIdFormatHint: null,
        },
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
    latencyMs: 900,
  });
  vi.mocked(quickCheckEligibility).mockReset();
  vi.mocked(quickCheckEligibility).mockResolvedValue({
    status: "parsed",
    payerName: "Acme Health",
    traceReference: "TRACE-1",
    latencyMs: 850,
    benefits: {
      isActive: true,
      inNetwork: true,
      deductibleCents: 50000,
      deductibleMetCents: 10000,
      deductibleRemainingCents: 40000,
      oopMaxCents: 200000,
      oopMetCents: 25000,
      oopRemainingCents: 175000,
      copayCents: null,
      coinsurancePct: 20,
      requiresPriorAuth: false,
      messages: ["CPAP SUPPLIES COVERED"],
    },
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

function fillQuickForm() {
  fireEvent.change(screen.getByTestId("quick-payer"), {
    target: { value: "payer-1" },
  });
  fireEvent.change(screen.getByTestId("quick-member-id"), {
    target: { value: "W123456789" },
  });
  fireEvent.change(screen.getByTestId("quick-first-name"), {
    target: { value: "Alice" },
  });
  fireEvent.change(screen.getByTestId("quick-last-name"), {
    target: { value: "Walkin" },
  });
  fireEvent.change(screen.getByTestId("quick-dob"), {
    target: { value: "1965-04-12" },
  });
}

describe("AdminBillingVerifyPage — quick check (no patient record)", () => {
  it("hides the patient search and offers only electronic payers", () => {
    render(<AdminBillingVerifyPage />);
    fireEvent.click(screen.getByTestId("verify-mode-quick"));

    expect(screen.queryByTestId("verify-patient-search")).toBeNull();
    const payerSelect = screen.getByTestId("quick-payer") as HTMLSelectElement;
    const labels = Array.from(payerSelect.options).map((o) => o.textContent);
    expect(labels).toContain("Acme Health");
    // paper_only / no-OA-id payers can't take a 270 — not offered.
    expect(labels).not.toContain("Paper Mutual");
  });

  it("keeps Run disabled until the form is complete", () => {
    render(<AdminBillingVerifyPage />);
    fireEvent.click(screen.getByTestId("verify-mode-quick"));

    const run = screen.getByTestId("quick-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fillQuickForm();
    expect(run.disabled).toBe(false);
  });

  it("runs the check with the typed subscriber and renders the parsed benefits", async () => {
    render(<AdminBillingVerifyPage />);
    fireEvent.click(screen.getByTestId("verify-mode-quick"));

    fillQuickForm();
    fireEvent.change(screen.getByTestId("quick-hcpcs"), {
      target: { value: "e0601" },
    });
    fireEvent.click(screen.getByTestId("quick-run"));

    await waitFor(() => {
      expect(vi.mocked(quickCheckEligibility)).toHaveBeenCalledWith({
        payerProfileId: "payer-1",
        firstName: "Alice",
        lastName: "Walkin",
        memberId: "W123456789",
        dateOfBirth: "1965-04-12",
        hcpcsCode: "E0601",
      });
    });

    const result = await screen.findByTestId("quick-check-result");
    expect(result.textContent).toContain("Active coverage");
    expect(result.textContent).toContain("in-network");
    expect(result.textContent).toContain("$500.00"); // deductible
    expect(result.textContent).toContain("CPAP SUPPLIES COVERED");
    expect(result.textContent).toContain("Nothing was saved");
  });

  it("passes the selected sex through as gender", async () => {
    render(<AdminBillingVerifyPage />);
    fireEvent.click(screen.getByTestId("verify-mode-quick"));

    fillQuickForm();
    fireEvent.change(screen.getByTestId("quick-sex"), {
      target: { value: "F" },
    });
    fireEvent.click(screen.getByTestId("quick-run"));

    await waitFor(() => {
      expect(vi.mocked(quickCheckEligibility)).toHaveBeenCalledWith(
        expect.objectContaining({ gender: "F" }),
      );
    });
  });

  it("surfaces the structured server reason when the check fails", async () => {
    const apiErr = Object.assign(new Error("HTTP 409 Conflict"), {
      data: {
        error: "realtime_not_configured",
        message: "Real-time eligibility is not configured",
      },
    });
    vi.mocked(quickCheckEligibility).mockRejectedValue(apiErr);

    render(<AdminBillingVerifyPage />);
    fireEvent.click(screen.getByTestId("verify-mode-quick"));
    fillQuickForm();
    fireEvent.click(screen.getByTestId("quick-run"));

    const error = await screen.findByTestId("quick-check-error");
    expect(error.textContent).toContain(
      "Real-time eligibility is not configured",
    );
    expect(screen.queryByTestId("quick-check-result")).toBeNull();
  });

  it("renders an inactive-coverage result distinctly", async () => {
    vi.mocked(quickCheckEligibility).mockResolvedValue({
      status: "parsed",
      payerName: "Acme Health",
      traceReference: "TRACE-2",
      latencyMs: 700,
      benefits: {
        isActive: false,
        inNetwork: null,
        deductibleCents: null,
        deductibleMetCents: null,
        deductibleRemainingCents: null,
        oopMaxCents: null,
        oopMetCents: null,
        oopRemainingCents: null,
        copayCents: null,
        coinsurancePct: null,
        requiresPriorAuth: false,
        messages: [],
      },
    });

    render(<AdminBillingVerifyPage />);
    fireEvent.click(screen.getByTestId("verify-mode-quick"));
    fillQuickForm();
    fireEvent.click(screen.getByTestId("quick-run"));

    const result = await screen.findByTestId("quick-check-result");
    expect(result.textContent).toContain("Coverage inactive");
  });
});
