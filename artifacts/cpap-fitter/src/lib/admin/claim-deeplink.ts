// Deep-linking a specific insurance claim (Pattern D from the domain
// workflow review). The billing worklists link to the claim workbench with
// ?claim=<id>; the workbench reads that param on mount, opens the claim, and
// strips the param so a refresh / drawer-close doesn't force it back open.

export interface ConsumedClaimParam {
  /** The claim id to open, or null when ?claim= is absent. */
  claimId: string | null;
  /**
   * The search string to leave in the URL after removing ?claim= — e.g.
   * "?tab=x", or "" when nothing else remains. Includes the leading "?".
   */
  nextSearch: string;
}

/**
 * Parse a location search string, extracting the `claim` param to open and
 * returning the search string that should remain once it is consumed.
 */
export function consumeClaimParam(search: string): ConsumedClaimParam {
  const params = new URLSearchParams(search);
  const raw = params.get("claim");
  // Always strip the param (even a valueless ?claim=) so it never lingers.
  params.delete("claim");
  const qs = params.toString();
  return { claimId: raw ? raw : null, nextSearch: qs ? `?${qs}` : "" };
}
