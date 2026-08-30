// Which of the two asks /fit-request is serving, read from the URL.
//
// Shared because the ROUTE GUARD and the PAGE must agree on it, and they
// live on opposite sides of a lazy-loaded chunk boundary: `App.tsx`
// decides whether the page may render at all (a callback needs no
// fitting; "send us your fitting" does), and the page decides what to
// ask for. Reading the same literal in two files is how those two
// answers drift apart, and the failure would be silent — a guard that
// admits a patient onto a form that then demands what they don't have.
//
// `entry` is separate and deliberately NOT sent to the server: the
// request body is `.strict()`, and where the patient came from is
// context for the notes field and the funnel, not a queue column.

import type { FitRequestType } from "./fit-request-api";

/** Where the patient reached the request form from. */
export type FitRequestEntry = "camera" | "scan" | null;

function params(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search);
}

/**
 * `?mode=callback` asks a person to make contact; anything else is the
 * full "here is my fitting" submission. Defaults to `full_details` so a
 * malformed or absent mode never silently downgrades a real fitting.
 */
export function readFitRequestMode(): FitRequestType {
  return params()?.get("mode") === "callback" ? "callback" : "full_details";
}

/**
 * `?source=camera|scan` — the capture failure that sent them here, used
 * to seed an editable note so the CSR knows to plan an in-person fit
 * rather than waiting for a scan that is never coming.
 */
export function readFitRequestEntry(): FitRequestEntry {
  const raw = params()?.get("source");
  return raw === "camera" || raw === "scan" ? raw : null;
}
