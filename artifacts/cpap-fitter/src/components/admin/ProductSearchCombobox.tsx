// Shared catalog-product picker — search the shop catalog by name and select
// one, yielding the full product (including its Stripe product + price ids).
// Lets admin surfaces that need "pick a catalog product" (e.g. issuing a
// return replacement) stop asking staff to paste raw Stripe prod_/price_ ids.
//
// Controlled: `value` is the selected product (or null) and `onChange` fires
// with the chosen product — callers read product.id / product.priceId — or
// null when cleared. The catalog is a small static list, so it is fetched
// once and filtered client-side.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  listShopInventory,
  type InventoryProductRow,
} from "@/lib/admin/shop-inventory-api";
import { Button } from "@/components/admin/Button";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";

export interface ProductSearchComboboxProps {
  value: InventoryProductRow | null;
  onChange: (product: InventoryProductRow | null) => void;
  placeholder?: string;
  "aria-label"?: string;
  testId?: string;
}

const MAX_RESULTS = 10;

export function ProductSearchCombobox({
  value,
  onChange,
  placeholder = "Search products by name",
  "aria-label": ariaLabel,
  testId = "product-search",
}: ProductSearchComboboxProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const catalog = useQuery({
    queryKey: ["product-search-combobox-catalog"],
    queryFn: listShopInventory,
    staleTime: 5 * 60_000,
  });

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const products = catalog.data?.products ?? [];
    const filtered =
      q.length === 0
        ? products
        : products.filter((p) =>
            `${p.name} ${p.category}`.toLowerCase().includes(q),
          );
    return filtered.slice(0, MAX_RESULTS);
  }, [search, catalog.data]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function select(p: InventoryProductRow) {
    onChange(p);
    setOpen(false);
    setSearch("");
  }

  if (value) {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid={`${testId}-selected`}
      >
        <span className="text-sm font-medium">{value.name}</span>
        <Button
          intent="secondary"
          onClick={() => {
            onChange(null);
            setOpen(true);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        data-testid={`${testId}-input`}
      />
      {open && (
        <div className="absolute z-50 mt-1 w-full">
          {catalog.isError ? (
            <div
              className="rounded-md border bg-white p-2 shadow-lg"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <ErrorPanel
                error={catalog.error}
                onRetry={() => void catalog.refetch()}
              />
            </div>
          ) : catalog.isPending ? (
            <div
              className="rounded-md border bg-white px-3 py-2 shadow-lg"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <Spinner label="Loading catalog…" />
            </div>
          ) : matches.length === 0 ? (
            <div
              className="rounded-md border bg-white px-3 py-2 text-sm shadow-lg"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--ink-3))",
              }}
              data-testid={`${testId}-empty`}
            >
              No products match.
            </div>
          ) : (
            <ul
              className="max-h-60 overflow-auto rounded-md border bg-white shadow-lg"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => select(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    data-testid={`${testId}-option-${p.id}`}
                  >
                    <span className="font-medium">{p.name}</span>
                    <span
                      className="ml-2 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {p.category}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
