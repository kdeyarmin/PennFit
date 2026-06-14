import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Autocomplete,
  type AutocompleteOption,
} from "@/components/ui/autocomplete";
import { fetchPayerProfiles } from "@/lib/admin/billing-config-api";

export interface PayerNameAutocompleteProps extends Omit<
  React.ComponentProps<typeof Autocomplete>,
  "options" | "onValueChange"
> {
  value: string;
  onValueChange: (value: string) => void;
}

/**
 * Payer-name text input backed by the active payer-profile catalog. Typing
 * "high" surfaces "Highmark"; choosing it fills the field. Free text is still
 * accepted for payers not yet in the catalog. The query shares its cache key
 * with the other active-payer consumers and uses a 5-minute staleTime, so the
 * catalog is typically fetched once and reused across these fields.
 */
export function PayerNameAutocomplete({
  value,
  onValueChange,
  ...rest
}: PayerNameAutocompleteProps) {
  const payersQuery = useQuery({
    queryKey: ["admin-payer-profiles-active"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60 * 1000,
  });

  const options = React.useMemo<AutocompleteOption[]>(() => {
    const profiles = payersQuery.data?.payerProfiles ?? [];
    return profiles.map((p) => ({
      value: p.displayName,
      label: p.displayName,
      description:
        p.payerLegalName && p.payerLegalName !== p.displayName
          ? p.payerLegalName
          : undefined,
    }));
  }, [payersQuery.data]);

  return (
    <Autocomplete
      value={value}
      onValueChange={onValueChange}
      options={options}
      {...rest}
    />
  );
}
