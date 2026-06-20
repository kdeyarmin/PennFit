import * as React from "react";

import { Autocomplete } from "@/components/ui/autocomplete";
import { CPAP_MANUFACTURERS } from "@/lib/cpap-manufacturers";

export interface ManufacturerAutocompleteProps extends Omit<
  React.ComponentProps<typeof Autocomplete>,
  "options" | "onValueChange"
> {
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * Manufacturer/brand text input backed by the known CPAP/DME manufacturer
 * list. Typing "res" surfaces "ResMed". Free text is still accepted for
 * brands outside the curated list.
 */
export function ManufacturerAutocomplete({
  value,
  onValueChange,
  ...rest
}: ManufacturerAutocompleteProps) {
  return (
    <Autocomplete
      value={value}
      onValueChange={onValueChange}
      options={CPAP_MANUFACTURERS}
      {...rest}
    />
  );
}
