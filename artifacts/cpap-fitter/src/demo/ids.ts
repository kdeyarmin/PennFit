// Demo id helpers. Use the Web Crypto CSPRNG (like the real
// startCheckout in src/lib/shop-api.ts) rather than Math.random — the
// values land in `sessionId`-shaped fields, and a non-crypto RNG there
// trips CodeQL's js/insecure-randomness rule. These ids are cosmetic
// (client-side demo lookup keys, never a security boundary), but using
// crypto keeps the static analysis clean and matches the codebase.

/** `demo_sess_<8 hex>` — a fake checkout/session id for the demo. */
export function demoSessionId(): string {
  return `demo_sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** `PENN-DEMO-<4 digits>` — a fake order reference for the demo. */
export function demoOrderReference(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 9000;
  return `PENN-DEMO-${2000 + n}`;
}
