import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Autocomplete,
  type AutocompleteOption,
} from "@/components/ui/autocomplete";
import {
  listProviders,
  type ProviderListItem,
} from "@/lib/admin/providers-api";

export interface ProviderNameAutocompleteProps extends Omit<
  React.ComponentProps<typeof Autocomplete>,
  "options" | "onValueChange" | "filterOptions" | "onSelectOption"
> {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Fired when a registry provider is chosen, so the caller can also fill
   * dependent fields (NPI, practice). Free-typed names don't fire this.
   */
  onSelectProvider?: (provider: ProviderListItem) => void;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Prescriber/provider-name input backed by the provider registry. Typing a
 * name (or NPI) runs a debounced `listProviders` search; choosing a result
 * fills the name and lets the caller auto-fill the NPI via `onSelectProvider`.
 * Free text is still accepted for providers not yet in the registry.
 */
export function ProviderNameAutocomplete({
  value,
  onValueChange,
  onSelectProvider,
  ...rest
}: ProviderNameAutocompleteProps) {
  const debounced = useDebounced(value.trim(), 250);
  const enabled = debounced.length >= 2;

  const providersQuery = useQuery({
    queryKey: ["admin-providers-search", debounced],
    queryFn: () => listProviders(debounced, { limit: 8 }),
    enabled,
    staleTime: 60 * 1000,
  });

  const providers = React.useMemo(
    () => providersQuery.data?.providers ?? [],
    [providersQuery.data],
  );

  const options = React.useMemo<AutocompleteOption[]>(
    () =>
      providers.map((p) => ({
        value: p.legalName,
        label: p.legalName,
        description: [p.npi ? `NPI ${p.npi}` : null, p.practiceName || null]
          .filter(Boolean)
          .join(" · "),
      })),
    [providers],
  );

  // legalName → provider, so an explicit pick can surface the full record.
  const byName = React.useMemo(() => {
    const map = new Map<string, ProviderListItem>();
    for (const p of providers) map.set(p.legalName, p);
    return map;
  }, [providers]);

  return (
    <Autocomplete
      value={value}
      onValueChange={onValueChange}
      options={options}
      filterOptions={false}
      minChars={2}
      onSelectOption={(opt) => {
        const provider = byName.get(opt.value);
        if (provider) onSelectProvider?.(provider);
      }}
      {...rest}
    />
  );
}
