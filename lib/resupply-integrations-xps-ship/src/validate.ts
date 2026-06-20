// Pre-book address validation.
//
// XPS rejects (or mis-delivers) labels with a malformed destination, and
// a rejection mid-batch is expensive to unwind. This is a cheap,
// deterministic structural check we run BEFORE staging an order — it
// catches the common data-entry faults (missing line, bad state, bad
// ZIP) without an extra network round-trip. Carrier-side correctness
// (does this address physically exist?) is still validated by XPS at
// quote/book time; this only filters out obviously-unshippable rows.

import type { XpsAddress } from "./config";

export interface AddressIssue {
  field: "name" | "address1" | "city" | "state" | "zip" | "country";
  message: string;
}

export interface AddressValidation {
  ok: boolean;
  issues: AddressIssue[];
}

const US_ZIP_RE = /^\d{5}(?:-\d{4})?$/;

/**
 * Structurally validate a destination address. Returns every issue found
 * (not just the first) so the UI can surface them all at once.
 */
export function validateReceiverAddress(addr: XpsAddress): AddressValidation {
  const issues: AddressIssue[] = [];
  const trimmed = (v: string | null | undefined): string => (v ?? "").trim();

  if (!trimmed(addr.name)) {
    issues.push({ field: "name", message: "Recipient name is required." });
  }
  if (!trimmed(addr.address1)) {
    issues.push({ field: "address1", message: "Street address is required." });
  }
  if (!trimmed(addr.city)) {
    issues.push({ field: "city", message: "City is required." });
  }

  // An unset country defaults to US (matching the adapter), so there is no
  // "country required" case to surface — it only affects the state/ZIP rules.
  const country = trimmed(addr.country) || "US";

  const state = trimmed(addr.state);
  if (!state) {
    issues.push({ field: "state", message: "State is required." });
  } else if (country === "US" && !/^[A-Za-z]{2}$/.test(state)) {
    issues.push({
      field: "state",
      message: "State must be a 2-letter code (e.g. PA).",
    });
  }

  const zip = trimmed(addr.zip);
  if (!zip) {
    issues.push({ field: "zip", message: "ZIP / postal code is required." });
  } else if (country === "US" && !US_ZIP_RE.test(zip)) {
    issues.push({
      field: "zip",
      message: "ZIP must be 5 digits or ZIP+4 (e.g. 19103 or 19103-1234).",
    });
  }

  return { ok: issues.length === 0, issues };
}
