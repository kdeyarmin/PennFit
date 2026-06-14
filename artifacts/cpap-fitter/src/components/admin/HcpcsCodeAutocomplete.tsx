import * as React from "react";

import {
  Autocomplete,
  type AutocompleteOption,
} from "@/components/ui/autocomplete";
import { CPAP_HCPCS_CODES } from "@/lib/cpap-hcpcs-codes";

const HCPCS_OPTIONS: AutocompleteOption[] = CPAP_HCPCS_CODES.map((c) => ({
  value: c.code,
  label: c.code,
  description: c.description,
}));

export interface HcpcsCodeAutocompleteProps extends Omit<
  React.ComponentProps<typeof Autocomplete>,
  "options" | "onValueChange"
> {
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * HCPCS-code text input backed by the common CPAP/DME resupply code list.
 * Matches on the code ("a7030") or the description ("tubing" → A7037);
 * choosing a suggestion fills the canonical code. Free text is still accepted
 * for codes outside the curated list.
 */
export function HcpcsCodeAutocomplete({
  value,
  onValueChange,
  ...rest
}: HcpcsCodeAutocompleteProps) {
  return (
    <Autocomplete
      value={value}
      onValueChange={onValueChange}
      options={HCPCS_OPTIONS}
      {...rest}
    />
  );
}
