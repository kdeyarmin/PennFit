// FHIR ClaimResponse parser — extracts the PA decision from the
// payer's response Bundle (or naked ClaimResponse).
//
// Per Da Vinci PAS IG v2.2 §3.5:
//   ClaimResponse.outcome      = 'queued' | 'complete' | 'error' | 'partial'
//   ClaimResponse.disposition  = human-readable text
//   ClaimResponse.preAuthRef   = the payer's PA reference number (the
//                                "auth number" we put on subsequent claims)
//   ClaimResponse.item[].adjudication[].category.coding.code =
//                                'approved' | 'denied' | 'pended' | ...
//   ClaimResponse.error[]      = denial reasons (when outcome != complete)
//
// We surface a flat shape:
//   { decision: 'approved' | 'denied' | 'pended' | 'cancelled',
//     authNumber, denialReason, dispositionText }

export interface ParsedClaimResponse {
  decision: "approved" | "denied" | "pended" | "cancelled";
  authNumber: string | null;
  denialReason: string | null;
  dispositionText: string | null;
  /**
   * The payer's echo of the original request identifier — pulled
   * from ClaimResponse.request.identifier.value first, then from
   * ClaimResponse.identifier[0].value as a fallback. The caller
   * MUST compare this against the local claimIdentifier we sent
   * before applying any state change; without that guard a
   * misrouted / replayed / cached / compromised payer response can
   * overwrite the wrong PA. Null when neither field is present —
   * the caller should treat that as a transport failure.
   */
  requestIdentifier: string | null;
}

export function parseClaimResponse(payload: unknown): ParsedClaimResponse {
  const cr = extractClaimResponse(payload);
  if (!cr) {
    return {
      decision: "pended",
      authNumber: null,
      denialReason: null,
      dispositionText: "No ClaimResponse in payload — pending",
      requestIdentifier: null,
    };
  }
  const dispositionText =
    typeof cr.disposition === "string" ? cr.disposition : null;
  const authNumber =
    typeof cr.preAuthRef === "string"
      ? cr.preAuthRef
      : Array.isArray(cr.preAuthRef) && typeof cr.preAuthRef[0] === "string"
        ? (cr.preAuthRef[0] as string)
        : null;

  // Per Da Vinci PAS IG: payer echoes back the original Claim
  // identifier in ClaimResponse.request.identifier.value AND/OR
  // ClaimResponse.identifier[0].value. We surface either so the
  // caller can match.
  let requestIdentifier: string | null = null;
  const request = cr.request;
  if (request && typeof request === "object") {
    const reqObj = request as { identifier?: { value?: unknown } };
    if (typeof reqObj.identifier?.value === "string") {
      requestIdentifier = reqObj.identifier.value;
    }
  }
  if (!requestIdentifier && Array.isArray(cr.identifier)) {
    const first = (cr.identifier as Array<{ value?: unknown }>)[0];
    if (first && typeof first.value === "string") {
      requestIdentifier = first.value;
    }
  }

  // Walk item[].adjudication looking for the first concrete decision code.
  let decision: ParsedClaimResponse["decision"] = "pended";
  const items = Array.isArray(cr.item)
    ? (cr.item as Record<string, unknown>[])
    : [];
  for (const item of items) {
    const adjs = Array.isArray(item.adjudication)
      ? (item.adjudication as Record<string, unknown>[])
      : [];
    for (const adj of adjs) {
      const code = extractAdjudicationCode(adj);
      if (code) {
        decision = code;
        break;
      }
    }
    if (decision !== "pended") break;
  }

  // Outcome-level fallback for non-item-bearing responses.
  if (decision === "pended" && typeof cr.outcome === "string") {
    if (cr.outcome === "error") decision = "denied";
    // 'complete' without item-level decision stays pended (rare).
  }

  // Denial reason: walk error[] when present; fall back to disposition.
  let denialReason: string | null = null;
  const errors = Array.isArray(cr.error)
    ? (cr.error as Record<string, unknown>[])
    : [];
  if (errors.length > 0) {
    denialReason = errors
      .map((e) => extractCodingDisplay(e.code) ?? null)
      .filter((s): s is string => Boolean(s))
      .join("; ")
      .slice(0, 2000);
  }
  if (!denialReason && decision === "denied" && dispositionText) {
    denialReason = dispositionText;
  }

  return {
    decision,
    authNumber,
    denialReason,
    dispositionText,
    requestIdentifier,
  };
}

function extractClaimResponse(
  payload: unknown,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.resourceType === "ClaimResponse") return p;
  if (p.resourceType === "Bundle" && Array.isArray(p.entry)) {
    for (const entry of p.entry as Array<Record<string, unknown>>) {
      const r = entry?.resource as Record<string, unknown> | undefined;
      if (r?.resourceType === "ClaimResponse") return r;
    }
  }
  return null;
}

function extractAdjudicationCode(
  adj: Record<string, unknown>,
): ParsedClaimResponse["decision"] | null {
  const category = adj.category as Record<string, unknown> | undefined;
  const coding = category?.coding as Array<Record<string, unknown>> | undefined;
  if (!coding) return null;
  for (const c of coding) {
    const code = typeof c.code === "string" ? c.code.toLowerCase() : "";
    // Only an explicit `approved` adjudication code is an approval.
    // `submitted` is the FHIR financial category for the billed amount
    // (it rides along on essentially every adjudicated item, including
    // denials), and `complete` is a `ClaimResponse.outcome` value
    // ("processing finished", not "authorized"). Treating either as
    // approved would auto-approve a denied/pended prior auth.
    if (code === "approved") {
      return "approved";
    }
    if (code === "denied" || code === "rejected") return "denied";
    if (code === "pended" || code === "pending") return "pended";
    if (code === "cancelled") return "cancelled";
  }
  return null;
}

function extractCodingDisplay(field: unknown): string | null {
  if (!field || typeof field !== "object") return null;
  const f = field as Record<string, unknown>;
  const coding = f.coding as Array<Record<string, unknown>> | undefined;
  if (!coding) return null;
  for (const c of coding) {
    if (typeof c.display === "string" && c.display.length > 0) return c.display;
    if (typeof c.code === "string" && c.code.length > 0) return c.code;
  }
  return null;
}
