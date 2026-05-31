// Minimal reverse proxy for talking to a STANDALONE PostgREST with a
// real `@supabase/supabase-js` client (in tests / CI, without Docker
// or the full Supabase stack).
//
// supabase-js prepends the gateway path segments that Supabase's Kong
// router strips before reaching the backing service:
//   * `/rest/v1/...`     -> PostgREST
//   * `/auth/v1/...`     -> GoTrue   (not proxied here; no upstream)
//   * `/storage/v1/...`  -> Storage  (not proxied here; no upstream)
// A bare PostgREST serves tables at `/<table>`, so we strip those
// prefixes and forward the remainder, preserving method, headers
// (apikey / Authorization / Accept-Profile / Content-Profile / Prefer)
// and body.
//
// Env:
//   PROXY_PORT  (default 54321)  — what SUPABASE_URL points at
//   PGRST_PORT  (default 33001)  — the standalone PostgREST port
//
// This is a TEST/CI harness helper only. It is never imported by the
// application and must not be used as a production gateway (no auth,
// no TLS, no rate limiting — that is Kong's job on real Supabase).

import http from "node:http";

const UPSTREAM = {
  host: "127.0.0.1",
  port: Number(process.env.PGRST_PORT || 33001),
};
const LISTEN = Number(process.env.PROXY_PORT || 54321);

const server = http.createServer((req, res) => {
  let p = req.url || "/";
  if (/^\/auth\/v1(?:\/|$)/.test(p) || /^\/storage\/v1(?:\/|$)/.test(p)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("rest-v1-proxy only supports /rest/v1");
    return;
  }
  p = p.replace(/^\/rest\/v1/, "");
  if (p === "") p = "/";

  const upstream = http.request(
    {
      host: UPSTREAM.host,
      port: UPSTREAM.port,
      method: req.method,
      path: p,
      headers: req.headers,
    },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`rest-v1-proxy upstream error: ${e.message}`);
  });
  req.pipe(upstream);
});

server.listen(LISTEN, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    `[rest-v1-proxy] listening on 127.0.0.1:${LISTEN} -> PostgREST 127.0.0.1:${UPSTREAM.port}`,
  );
});
