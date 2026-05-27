// Selection checkboxes for admin list tables.
//
// Two variants that share the same visual treatment + event posture:
//
//   <HeaderSelectionCheckbox /> — sits in a "select" column header,
//      shows a tri-state (unchecked / indeterminate / checked) based
//      on whether none / some / all visible rows are selected.
//
//   <RowSelectionCheckbox /> — sits in each row, toggles the row's id.
//
// Both stop click propagation so a checkbox click never triggers the
// row's onRowClick navigation (which would open the detail page).

import type { CSSProperties } from "react";

const CHECKBOX_STYLE: CSSProperties = { cursor: "pointer" };

export function HeaderSelectionCheckbox({
  allSelected,
  someSelected,
  onToggle,
  ariaLabel = "Select all on this page",
}: {
  allSelected: boolean;
  someSelected: boolean;
  onToggle: () => void;
  ariaLabel?: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={allSelected}
      // `indeterminate` is a DOM property, not a React attribute — set
      // it via a ref callback. The DOM resets it whenever `checked`
      // changes, so we have to re-apply on every render.
      ref={(el) => {
        if (el) el.indeterminate = !allSelected && someSelected;
      }}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      style={CHECKBOX_STYLE}
    />
  );
}

export function RowSelectionCheckbox({
  checked,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  onToggle: () => void;
  /**
   * Required — screen readers need a per-row label to disambiguate
   * which row is being selected ("Select patient 12345").
   */
  ariaLabel: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      style={CHECKBOX_STYLE}
    />
  );
}
