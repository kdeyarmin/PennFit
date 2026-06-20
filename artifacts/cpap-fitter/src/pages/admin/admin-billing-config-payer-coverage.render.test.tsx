// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: () => ({
    data: null,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
  useMutation: ({ mutationFn }: { mutationFn: () => Promise<unknown> }) => ({
    mutate: () => void mutationFn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/lib/admin/billing-config-api", () => ({
  fetchPayerProfiles: vi.fn(),
  fetchPayerCoverageDiagnoses: vi.fn(),
  createPayerCoverageDiagnosis: vi.fn(),
  deletePayerCoverageDiagnosis: vi.fn(),
}));

import { AdminBillingConfigPayerCoveragePage } from "./admin-billing-config-payer-coverage";

beforeEach(() => cleanup());

describe("AdminBillingConfigPayerCoveragePage", () => {
  it("renders the page with the payer selector (admin-root scoped)", () => {
    render(<AdminBillingConfigPayerCoveragePage />);
    const root = screen.getByTestId("admin-billing-config-payer-coverage");
    expect(root).toBeTruthy();
    expect(root.classList.contains("admin-root")).toBe(true);
    expect(
      screen.getByRole("heading", { name: /coverage overrides/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Payer")).toBeTruthy();
  });
});
