// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { listShopInventory } = vi.hoisted(() => ({
  listShopInventory: vi.fn(),
}));

vi.mock("@/lib/admin/shop-inventory-api", () => ({ listShopInventory }));

import { SkuComboboxInput } from "./SkuComboboxInput";

function renderInput(value = "") {
  const onChange = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <SkuComboboxInput
        value={value}
        onChange={onChange}
        aria-label="SKU"
        testId="sku"
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("SkuComboboxInput", () => {
  beforeEach(() => {
    listShopInventory.mockReset();
    listShopInventory.mockResolvedValue({
      previewMode: false,
      products: [
        {
          id: "prod_1",
          name: "AirFit P10 Nasal",
          category: "mask",
          sku: "AF20-S",
          priceCents: null,
          currency: null,
          stockCount: null,
          lowStockThreshold: null,
        },
        {
          id: "prod_2",
          name: "ClimateLineAir Tube",
          category: "tubing",
          sku: "CLA-11",
          priceCents: null,
          currency: null,
          stockCount: null,
          lowStockThreshold: null,
        },
        {
          id: "prod_3",
          name: "Unlabelled product",
          category: "accessory",
          sku: null,
          priceCents: null,
          currency: null,
          stockCount: null,
          lowStockThreshold: null,
        },
      ],
    });
  });
  afterEach(cleanup);

  it("suggests catalog SKUs as datalist options, skipping products with none", async () => {
    renderInput();
    await waitFor(() => {
      expect(
        screen.getByTestId("sku-list").querySelectorAll("option").length,
      ).toBe(2);
    });
    const values = Array.from(
      screen.getByTestId("sku-list").querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    // The product with no shop_sku (prod_3) is not offered as a suggestion.
    expect(values).toEqual(["AF20-S", "CLA-11"]);
  });

  it("wires the input to its datalist so the browser surfaces the suggestions", async () => {
    renderInput();
    await waitFor(() => {
      expect(
        screen.getByTestId("sku-list").querySelectorAll("option").length,
      ).toBe(2);
    });
    const input = screen.getByTestId("sku-input");
    const list = screen.getByTestId("sku-list");
    expect(input.getAttribute("list")).toBe(list.getAttribute("id"));
    expect(input.getAttribute("list")).toBeTruthy();
  });

  it("reports free-typed input verbatim (archived / non-catalog SKUs stay enterable)", () => {
    const { onChange } = renderInput();
    // A SKU that isn't in the catalog at all — selecting a datalist option
    // does the same thing (sets value + fires change), so this also covers
    // the suggestion-pick path the native popup can't simulate in jsdom.
    fireEvent.change(screen.getByTestId("sku-input"), {
      target: { value: "CUSTOM-99" },
    });
    expect(onChange).toHaveBeenCalledWith("CUSTOM-99");
  });
});
