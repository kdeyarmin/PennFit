// Minimal PKPass PNG assets bundled as base64 constants.
//
// Why these are inline (not in a file)
// ------------------------------------
// PKPass spec requires icon.png + logo.png to be present in the
// bundle. Reading them from disk at request time would force us to
// resolve a path relative to dist/ at runtime, which complicates
// the bundler step. Two small PNGs as base64 add ~2KB to the
// resupply-api bundle and Just Work.
//
// Replacement plan
// ----------------
// The current assets are 1x1 transparent placeholders — they
// satisfy the spec but render as blank squares in Wallet. Before
// any real customer-facing rollout, replace with the branded
// PennPaps icon + logo at the three required @1x/@2x/@3x sizes
// (29×29, 58×58, 87×87 for icon; 160×50, 320×100, 480×150 for
// logo). For a v1 the single-size variants below are acceptable;
// Wallet falls back to scaling.

const TRANSPARENT_PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==";

function decode(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

/**
 * Placeholder icon for PassKit. Real branded asset is a TODO; the
 * 1×1 transparent satisfies the spec's "icon.png MUST exist" rule
 * so the pass validates and adds to Wallet.
 */
export function defaultIconPng(): Buffer {
  return decode(TRANSPARENT_PNG_1x1_BASE64);
}

export function defaultLogoPng(): Buffer {
  return decode(TRANSPARENT_PNG_1x1_BASE64);
}
