// errors.ts — one vocabulary for "the vendor said no", shared by every
// therapy-cloud adapter.
//
// WHY THE OLD VOCABULARY WAS NOT ENOUGH
// -------------------------------------
// Five categories — auth_failed, not_found, rate_limited, unavailable,
// unknown_error — collapsed distinctions that decide what an operator
// does next:
//
//   * A 403 means the credentials are FINE and this account has not been
//     granted access to this resource. Reported as `auth_failed`, it
//     sends someone to rotate a perfectly good secret. It is almost
//     always a missing partnership agreement or an un-provisioned scope.
//   * A 404 on a PATIENT path means the vendor has no such patient. A 404
//     on the collection path means our URL shape is wrong. Every endpoint
//     in these clients is an unverified placeholder written against
//     published docs, so the second is the likeliest failure on day one —
//     and reported identically to the first, it reads as "no data".
//   * A 5xx is the vendor being down. A timeout might be the vendor, or
//     us, or the network. Both were `unavailable`.
//   * A 200 carrying an empty payload is the vendor telling us there IS
//     no data. That is not an error at all, and counting it as one makes
//     a working connection look broken.
//   * A response we cannot map is a CONTRACT change — the failure mode a
//     nightly sync absorbs most quietly, dropping one field at a time
//     while the counts only look a bit low.
//
// "Do not translate all failures into no data" is the rule this file
// exists to make mechanically true.
//
// PHI / SECRETS: classification reads a status code and, at most, a
// vendor error CODE. Response bodies never reach these values.

/**
 * Every way a vendor call can fail, in the terms an operator acts on.
 *
 * The first five are the historical vocabulary and keep their exact
 * meanings, so a stored value or a switch statement written against them
 * is unchanged.
 */
export const ADAPTER_ERRORS = [
  /** The vendor rejected our credentials outright (401). Rotate them. */
  "auth_failed",
  /** The vendor has no such patient. Not an error with the connection. */
  "not_found",
  /** The vendor asked us to slow down (429). */
  "rate_limited",
  /** No response: network failure, DNS, connection refused. */
  "unavailable",
  /** Anything we could not classify. */
  "unknown_error",
  /**
   * Credentials accepted, access denied (403). The account is not
   * entitled to this resource — nearly always a missing partnership
   * agreement or an un-provisioned scope, NOT a bad secret.
   */
  "forbidden",
  /**
   * A 404 on a path that must exist regardless of the patient. Our URL
   * shape is wrong for this vendor instance.
   */
  "endpoint_not_found",
  /** The vendor rejected the request itself (400/422). Our shape is wrong. */
  "bad_request",
  /** The vendor errored (5xx). Their problem, and it will pass. */
  "server_error",
  /** We gave up waiting. */
  "timeout",
  /**
   * The response arrived and could not be mapped onto the contract. A
   * silent schema drift, which is the failure a nightly sync hides best.
   */
  "mapping_failed",
  /**
   * The vendor answered successfully and has nothing for this patient in
   * this window. Deliberately NOT an error condition — it is the answer.
   */
  "no_data",
] as const;

export type AdapterError = (typeof ADAPTER_ERRORS)[number];

/**
 * How an operator should read a failure. Drives retry, alerting, and
 * whether a connector is marked unhealthy.
 */
export type AdapterErrorClass =
  /** Ours to fix: credentials, agreements, request shape, mapping. */
  | "configuration"
  /** Theirs, and transient: retry is appropriate. */
  | "transient"
  /** Neither — a true, successful negative answer. */
  | "no_data";

/** Which class each error belongs to. */
export const ADAPTER_ERROR_CLASS: Record<AdapterError, AdapterErrorClass> = {
  auth_failed: "configuration",
  forbidden: "configuration",
  endpoint_not_found: "configuration",
  bad_request: "configuration",
  mapping_failed: "configuration",
  not_found: "no_data",
  no_data: "no_data",
  rate_limited: "transient",
  unavailable: "transient",
  server_error: "transient",
  timeout: "transient",
  unknown_error: "transient",
};

/**
 * Retrying a configuration failure is not just useless — it is how a
 * wrong client secret turns into thousands of rejected auth attempts and
 * a vendor-side lockout. Only transient classes are retried.
 */
export function isRetryable(error: AdapterError): boolean {
  return ADAPTER_ERROR_CLASS[error] === "transient";
}

/**
 * Does this failure mean the connector itself is unhealthy? A patient the
 * vendor has never heard of does not, however many times it happens.
 */
export function indicatesUnhealthyConnector(error: AdapterError): boolean {
  return ADAPTER_ERROR_CLASS[error] !== "no_data";
}

/** What an operator should do, in one sentence. Safe to display. */
export const ADAPTER_ERROR_REMEDY: Record<AdapterError, string> = {
  auth_failed:
    "The vendor rejected these credentials. Re-enter the client id and secret; check they are for the right environment (production vs sandbox).",
  forbidden:
    "The credentials are valid but this account is not entitled to that resource. This is almost always a missing partnership agreement or an un-provisioned scope — ask the vendor to enable it. Do NOT rotate the secret.",
  endpoint_not_found:
    "The API path does not exist on this vendor instance. Confirm the base URL and path shape against the spec for THIS instance; every path in these clients is a placeholder until a partnership ships a final spec.",
  bad_request:
    "The vendor rejected the request itself. Our parameters or path shape are wrong for this instance.",
  not_found:
    "The vendor has no patient with that identifier. Check the partner patient id on the link, not the connection.",
  no_data:
    "The vendor answered and has nothing for this patient in this window. The connection is working.",
  rate_limited:
    "The vendor asked us to slow down. The sync backs off automatically; if it persists, ask the vendor about the account's rate limit.",
  unavailable:
    "No response from the vendor — network, DNS, or a refused connection. Retry; if it persists, check egress rules.",
  server_error:
    "The vendor returned a server error. Theirs to fix; the sync will retry.",
  timeout: "The vendor did not respond in time. The sync will retry.",
  mapping_failed:
    "The response no longer matches the contract we map from. The vendor changed their schema — this needs a code change, and until then the sync is silently dropping fields.",
  unknown_error:
    "The failure could not be classified. Check the connector's last error category and the vendor's status page.",
};

/**
 * Classify an HTTP response into the vocabulary above.
 *
 * `pathKind` is the distinction the old code could not make: a 404 on a
 * patient-scoped path means the patient is unknown; a 404 on anything
 * else means our URL is wrong. Reported identically, the second one reads
 * as "the vendor has no data", which is exactly how a wrong endpoint
 * survives a nightly sync.
 *
 * @param status - HTTP status code.
 * @param pathKind - Whether the URL identified a specific patient.
 * @returns The classified error, or null when the response was a success.
 */
export function classifyHttpStatus(
  status: number,
  pathKind: "patient" | "collection" | "auth" = "collection",
): AdapterError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "auth_failed";
  if (status === 403) return pathKind === "auth" ? "auth_failed" : "forbidden";
  if (status === 404) {
    return pathKind === "patient" ? "not_found" : "endpoint_not_found";
  }
  if (status === 400 || status === 422) return "bad_request";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unknown_error";
}

/**
 * Classify a thrown network-level failure.
 *
 * @param err - Whatever `fetch` rejected with.
 * @returns `timeout` for an abort/deadline, `unavailable` otherwise.
 */
export function classifyNetworkError(err: unknown): AdapterError {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT"
  ) {
    return "timeout";
  }
  return "unavailable";
}

/**
 * Infer whether a request path identified a specific patient.
 *
 * Every vendor client here builds patient-scoped paths as
 * `…/patients/<id>[/sub-resource]`, so the presence of an id segment
 * after the collection is the whole signal. Getting this right is what
 * separates "the vendor has no such patient" from "our URL is wrong",
 * and those two look identical in a nightly sync.
 *
 * Errs toward `collection` — the CONSERVATIVE direction. Calling a
 * patient 404 `endpoint_not_found` produces a loud, investigable
 * configuration error about a real 404; calling a wrong-endpoint 404
 * `not_found` produces silence.
 *
 * @param path - Request path, with or without a leading slash.
 * @returns Which kind of path this is.
 */
export function inferPathKind(path: string): "patient" | "collection" {
  return /\/(patients|members|subjects)\/[^/]+/i.test(path)
    ? "patient"
    : "collection";
}
