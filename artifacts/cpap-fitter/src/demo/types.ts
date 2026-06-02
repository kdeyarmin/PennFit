// Shared types + the `route()` helper used by every demo handler
// module. A handler matches on HTTP method + a path pattern (with
// `:param` placeholders) and returns a `Response`.

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** A normalized view of an intercepted request, handed to handlers. */
export interface DemoRequest {
  method: HttpMethod;
  /** Full request URL as a string. */
  url: string;
  /** Pathname only (no query, no origin). */
  pathname: string;
  /** Parsed query string. */
  query: URLSearchParams;
  /** Request headers (used e.g. to detect an SSE `Accept`). */
  headers: Headers;
  /** Raw request body text, if any. */
  rawBody: string | null;
  /** Parsed JSON body, or undefined when absent / unparseable. */
  json<T = unknown>(): T | undefined;
}

export type RouteParams = Record<string, string>;

export interface DemoHandler {
  method: HttpMethod;
  /** Returns captured params when the path matches, else null. */
  match(pathname: string): RouteParams | null;
  handle(req: DemoRequest, params: RouteParams): Response | Promise<Response>;
}

/**
 * Compile a path pattern like `/resupply-api/shop/orders/:id` into a
 * matcher. `:param` segments capture a single non-slash run. A
 * trailing `*` (e.g. `/admin/*`) matches the rest of the path under
 * the `rest` param.
 */
function compile(pattern: string): (pathname: string) => RouteParams | null {
  const names: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg === "*") {
        names.push("rest");
        return "(.*)";
      }
      if (seg.startsWith(":")) {
        names.push(seg.slice(1));
        return "([^/]+)";
      }
      // Escape regex-special characters in literal segments.
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const re = new RegExp(`^${source}/?$`);
  return (pathname: string) => {
    const m = re.exec(pathname);
    if (!m) return null;
    const params: RouteParams = {};
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    return params;
  };
}

/** Define a demo route concisely. */
export function route(
  method: HttpMethod,
  pattern: string,
  handle: (
    req: DemoRequest,
    params: RouteParams,
  ) => Response | Promise<Response>,
): DemoHandler {
  return { method, match: compile(pattern), handle };
}
