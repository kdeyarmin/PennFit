// Shared SKU autocomplete input.
//
// Backorders and the substitution catalog both key off a catalog
// `shop_sku`. Staff used to type these codes by hand into a bare text
// field — and a single typo silently breaks the link (a substitution
// rule keyed off a SKU that doesn't exist simply never fires). This
// suggests matching catalog SKUs as you type via a native `<datalist>`,
// which:
//   * keeps FREE ENTRY — an archived or not-yet-catalogued SKU is still
//     a valid backorder/substitution target, so this is a suggester, not
//     a strict picker; whatever the operator commits is reported verbatim;
//   * is never clipped by an `overflow-hidden` ancestor (the Card wrapper
//     is) the way an absolutely-positioned dropdown would be — the native
//     popup escapes overflow exactly like a `<select>`;
//   * needs no click-outside / z-index / portal plumbing and is keyboard-
//     and screen-reader-accessible for free.
//
// Yields the raw SKU string. Width is controlled by the caller's wrapper
// (the base Input is `w-full`), so this component takes no width prop.

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";

import { listShopInventory } from "@/lib/admin/shop-inventory-api";
import { Input } from "@/components/admin/Input";

export interface SkuComboboxInputProps {
  value: string;
  onChange: (sku: string) => void;
  placeholder?: string;
  "aria-label"?: string;
  testId?: string;
  /** Forwarded to the underlying input (e.g. to focus the next SKU). */
  inputRef?: React.Ref<HTMLInputElement>;
}

export function SkuComboboxInput({
  value,
  onChange,
  placeholder,
  "aria-label": ariaLabel,
  testId = "sku-combobox",
  inputRef,
}: SkuComboboxInputProps) {
  const listId = useId();

  // The catalog is a small static list, so fetch once and share across
  // every SKU input on the page (same query key → one request).
  const catalog = useQuery({
    queryKey: ["sku-combobox-catalog"],
    queryFn: listShopInventory,
    staleTime: 5 * 60_000,
  });

  // Only products that actually carry a shop_sku are suggestable. A
  // product without one (preview fixtures, a mis-tagged Stripe product)
  // is simply omitted — free entry still covers it.
  const options = (catalog.data?.products ?? []).flatMap((p) =>
    typeof p.sku === "string" && p.sku.length > 0
      ? [{ id: p.id, sku: p.sku, name: p.name }]
      : [],
  );

  return (
    <>
      <Input
        ref={inputRef}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className="font-mono"
        data-testid={`${testId}-input`}
      />
      <datalist id={listId} data-testid={`${testId}-list`}>
        {options.map((o) => (
          <option key={o.id} value={o.sku}>
            {o.name}
          </option>
        ))}
      </datalist>
    </>
  );
}
