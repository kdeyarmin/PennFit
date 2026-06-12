# Runbook: verify the X-Forwarded-For chain (P1-5 prerequisite)

**Why.** The app review
([`docs/app-review-2026-06-10.md`](../app-review-2026-06-10.md), P1-5)
identified that a plain `trust proxy = 1` is one hop short behind Cloudflare:
on the custom domain (`pennpaps.com` → Cloudflare → Railway edge → app),
`req.ip` can resolve to a Cloudflare colo IP, so IP-keyed rate limiters can
bucket all custom-domain visitors together.

The current code uses a `trust proxy` predicate (see
`artifacts/resupply-api/src/lib/trusted-proxies.ts`) to address this safely.
This runbook captures the live proxy-chain facts needed to validate the
deployment and to decide if any follow-up trust-proxy adjustments are needed.

This runbook captures the facts the fix depends on. It uses the
super-admin diagnostics endpoint `GET /admin/diagnostics/proxy-chain`,
which echoes — for the calling request only — the immediate TCP peer,
the raw forwarding headers, and Express's `req.ip` resolution under the
current `trust proxy` setting. Nothing is logged or persisted.

## Step 1 — get a super-admin session cookie

Sign in at `https://pennpaps.com/admin/sign-in` as a super-admin, then
copy the `pf_session` cookie value (browser dev tools → Application →
Cookies). You need one cookie per host: the cookie is host-scoped, so
also sign in at `https://pennfit.up.railway.app/admin/sign-in` and copy
that one. Export them:

```bash
export CF_COOKIE='pf_session=<value copied from pennpaps.com>'
export RW_COOKIE='pf_session=<value copied from pennfit.up.railway.app>'
```

## Step 2 — capture the four requests

```bash
# A. Custom domain (Cloudflare-fronted), clean request
curl -sS -H "Cookie: $CF_COOKIE" \
  https://pennpaps.com/resupply-api/admin/diagnostics/proxy-chain | jq .

# B. Custom domain, FORGED client XFF
curl -sS -H "Cookie: $CF_COOKIE" -H "X-Forwarded-For: 9.9.9.9" \
  https://pennpaps.com/resupply-api/admin/diagnostics/proxy-chain | jq .

# C. Railway host (no Cloudflare), clean request
curl -sS -H "Cookie: $RW_COOKIE" \
  https://pennfit.up.railway.app/resupply-api/admin/diagnostics/proxy-chain | jq .

# D. Railway host, FORGED client XFF
curl -sS -H "Cookie: $RW_COOKIE" -H "X-Forwarded-For: 9.9.9.9" \
  https://pennfit.up.railway.app/resupply-api/admin/diagnostics/proxy-chain | jq .
```

Save all four JSON bodies into the P1-5 follow-up issue/PR. Note your
own public IP (`curl -s https://ifconfig.me`) so you can recognize it
in the chains.

## Step 3 — interpret

| Question the fix depends on                                      | Where to look                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Does Railway strip or append a client-supplied XFF?**          | In **D**, does `headers["x-forwarded-for"]` start with `9.9.9.9`? If yes, Railway **appends** → a plain `trust proxy = 2` is spoofable on the Railway host and must NOT be used. If `9.9.9.9` is gone and only your real IP remains, Railway **strips** → hop-count trust is viable.                                                                                                                                      |
| **How many hops on each host?**                                  | Count the entries in `headers["x-forwarded-for"]` in **A** vs **C** (clean requests). Expected: custom domain = 2 (you, then Cloudflare's egress), Railway host = 1 (just you). If the counts vary across repeated runs, hop-count trust is not viable at all.                                                                                                                                                            |
| **Does Cloudflare's `CF-Connecting-IP` survive Railway's edge?** | In **A**, `headers["cf-connecting-ip"]` should equal your real IP. In **C** it should be `null`. In **B**/**D**, check whether a _client-forged_ `CF-Connecting-IP` would also pass through (repeat with `-H "CF-Connecting-IP: 9.9.9.9"` if you want this explicitly) — it will on the Railway host, which is why CF-Connecting-IP must only ever be trusted after validating the request actually traversed Cloudflare. |
| **What is the immediate peer?**                                  | `socket.remoteAddress` in all four — Railway's internal proxy address. If it's a stable documented range, a `trust proxy` _function_ can pin it.                                                                                                                                                                                                                                                                          |
| **What does today's code resolve?**                              | `expressResolution.ip` in **A** should be your real public IP when `trust proxy` is configured correctly; if it resolves to a Cloudflare colo IP, the custom-domain hop is still being trusted incorrectly. In **C** it should also be your real IP. |

## Step 4 — what to ask Railway support (the guarantee layer)

The captures above tell you the _observed_ behavior; Railway support
tells you whether it's _guaranteed_. Ask:

1. Does Railway's edge proxy **strip/sanitize a client-supplied
   `X-Forwarded-For`** header, or append to it? Is this documented and
   stable across regions and IPv4/IPv6?
2. **Exactly how many proxy hops** does Railway insert between the
   public edge and the app container? Fixed, or can it vary (internal
   LBs, regional edges)?
3. What does the app see as the **immediate TCP peer** — is it a
   documented/stable internal address range?
4. Are upstream headers (**`CF-Connecting-IP`**, `CF-Ray`, Cloudflare's
   own XFF entry) **forwarded untouched** to the app?
5. Is the behavior **identical** for `*.up.railway.app` and a custom
   domain pointed at the service?

## Step 5 — write the fix

With the answers in hand, the fix lands in
`artifacts/resupply-api/src/app.ts` (currently `app.set("trust proxy", createTrustProxyFn())`),
choosing between:

- **Railway strips client XFF, fixed single hop** → a `trust proxy`
  _function_ (or hop-count) that trusts Railway's hop always and
  Cloudflare's hop only when the immediate XFF entry is inside
  [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/).
  A bare `trust proxy = 2` is still wrong even here: Railway-host
  traffic has only one hop, so 2 would trust the _client's_ own header.
- **Railway appends, or hop count varies** → ignore XFF arithmetic
  entirely; derive the client from `CF-Connecting-IP` **only after**
  validating the request traversed Cloudflare (immediate forwarded hop
  inside CF ranges), falling back to today's behavior otherwise.

Then re-test every auth limiter (sign-in 30/15min, forgot/reset/verify)
from both hosts, per the fix-order note in the app review (§Recommended
fix order, item 7).
