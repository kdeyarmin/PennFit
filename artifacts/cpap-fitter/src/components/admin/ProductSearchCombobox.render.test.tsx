// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { listShopInventory } = vi.hoisted(() => ({
  listShopInventory: vi.fn(),
}));

vi.mock("@/lib/admin/shop-inventory-api", () => ({ listShopInventory }));

import { ProductSearchCombobox } from "./ProductSearchCombobox";
import type { InventoryProductRow } from "@/lib/admin/shop-inventory-api";

const PRODUCT: InventoryProductRow = {
  id: "prod_abc",
  name: "AirFit P10 Nasal Pillow",
  category: "masks",
  priceId: "price_xyz",
  priceCents: 4599,
  currency: "usd",
  stockCount: 5,
  lowStockThreshold: null,
};

function renderPicker(value: InventoryProductRow | null = null) {
  const onChange = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ProductSearchCombobox
        value={value}
        onChange={onChange}
        aria-label="Product"
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("ProductSearchCombobox", () => {
  beforeEach(() => {
    listShopInventory.mockReset();
    listShopInventory.mockResolvedValue({
      previewMode: false,
      products: [PRODUCT],
    });
  });
  afterEach(cleanup);

  it("filters the catalog and yields the chosen product with its Stripe ids", async () => {
    const { onChange } = renderPicker();
    const input = screen.getByTestId("product-search-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "airfit" } });

    const option = await screen.findByTestId("product-search-option-prod_abc");
    expect(option.textContent).toContain("AirFit P10");

    fireEvent.click(option);
    // The caller receives the whole product — incl. the price id needed to
    // issue a replacement — not pasted strings.
    expect(onChange).toHaveBeenCalledWith(PRODUCT);
    expect(onChange.mock.calls[0]![0].priceId).toBe("price_xyz");
  });

  it("renders the selected product with a Change affordance", () => {
    const { onChange } = renderPicker(PRODUCT);
    expect(screen.getByTestId("product-search-selected").textContent).toContain(
      "AirFit P10",
    );
    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
