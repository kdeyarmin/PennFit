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
}));

vi.mock("@/lib/admin/billing-config-api", () => ({
  fetchPayerProfiles: vi.fn(),
  importPayerFeeScheduleCms: vi.fn(),
}));

import { AdminBillingConfigCmsImportPage } from "./admin-billing-config-cms-import";

beforeEach(() => cleanup());

describe("AdminBillingConfigCmsImportPage", () => {
  it("renders the import form (admin-root scoped)", () => {
    render(<AdminBillingConfigCmsImportPage />);
    const root = screen.getByTestId("admin-billing-config-cms-import");
    expect(root).toBeTruthy();
    expect(root.classList.contains("admin-root")).toBe(true);
    expect(
      screen.getByRole("heading", { name: /cms fee-schedule import/i }),
    ).toBeTruthy();
    expect(screen.getByTestId("cms-import-submit")).toBeTruthy();
    expect(screen.getByLabelText("State")).toBeTruthy();
  });
});
