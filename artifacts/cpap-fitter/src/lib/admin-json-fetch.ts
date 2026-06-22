// Shared fetch wrapper for the hand-rolled admin API clients under
// `artifacts/cpap-fitter/src/lib/admin/*-api.ts`.
//
// Background: every one of those ~49 files used to carry its own
// near-identical `jsonFetch` helper. They had drifted — some forced
// `Content-Type: application/json`, some never set it; some spread the
// caller's `init` before the defaults (so `credentials`/headers could be
// overridden), some after; a few omitted `credentials`/`csrfHeader`
// entirely. The differences were almost all accidental. This module is
// the single source of truth those wrappers now delegate to.
//
// Behaviour (a superset that is safe for every previous caller):
//   * Prefixes `path` with `/resupply-api` (every admin route lives under
//     that mount).
//   * `credentials: "include"` so the `pf_session` cookie rides along.
//   * `Accept` + `Content-Type` default to `application/json`. All admin
//     request bodies are JSON strings (there is no FormData/multipart
//     caller), so a default `Content-Type` is correct and lets the server's
//     JSON body parser run — previously a latent bug in the wrappers that
//     omitted it on mutations.
//   * `csrfHeader()` is merged in — the app-level
//     `requireCsrfOnAdminMutations` middleware rejects state-changing
//     requests without it. It is a no-op on GETs (and when no cookie is
//     present), so adding it unconditionally is harmless.
//   * Caller-supplied `headers` win over every default above, so a caller
//     can still override `Content-Type` (or any header) when it needs to.
//   * Non-OK responses throw `ApiError` (carrying the parsed JSON body when
//     present, else null) so `<ErrorPanel>` and friends can decode them.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "./csrf";

/** Mount prefix shared by every admin API route. */
const ADMIN_API_PREFIX = "/resupply-api";

/**
 * Fetch JSON from an admin API route. `path` is everything after
 * `/resupply-api` (e.g. `/admin/alerts`). Returns the parsed JSON body on a
 * 2xx response; throws {@link ApiError} on any non-OK status.
 */
export async function adminJsonFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `${ADMIN_API_PREFIX}${path}`;
  const res = await fetch(url, {
    ...rest,
    // After `...rest` so a caller's `init` cannot override it — the
    // `pf_session` cookie must always ride along (this was one of the
    // accidental drifts the wrapper exists to eliminate).
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
      ...(headers ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Response body was not JSON — leave `data` null; ApiError formats
      // from status alone.
    }
    throw new ApiError(res, data, { method, url });
  }
  // 204 No Content has an empty body — skip the JSON parse rather than
  // letting it throw (DELETE endpoints resolve this way).
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
