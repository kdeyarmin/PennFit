// Bundled PKPass PNG assets as base64 constants.
//
// Why these are inline (not in a file)
// ------------------------------------
// PKPass spec requires icon.png + logo.png to be present in the
// bundle. Reading them from disk at request time would force us to
// resolve a path relative to dist/ at runtime, which complicates
// the bundler step. Two small PNGs as base64 add ~2KB to the
// resupply-api bundle and Just Work.
//
// The assets
// ----------
// A gold "PennPaps" P-monogram, rendered with anti-aliasing to match
// the pass styling in `pkpass.ts` (backgroundColor rgb 15,29,58;
// labelColor / accent rgb 204,184,121):
//   - icon.png — 87×87, gold P on the pass navy. A self-contained
//     "app icon" (iOS rounds the corners) shown in the lock-screen
//     glance + notifications.
//   - logo.png — 120×120, gold P on a transparent background. The
//     mark that sits beside the "PennPaps" logoText on the pass face.
//
// Single-size variants are intentional — Wallet scales them to the
// @1x/@2x/@3x slots it needs. To regenerate (e.g. to swap in a
// professionally-designed mark), edit and re-run the committed
// generator and paste its output back here:
//
//   node artifacts/resupply-api/src/lib/apple-wallet/gen-assets.mjs

const ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAFcAAABXCAYAAABxyNlsAAACOklEQVR42u3cvUoDQRTF8byBDyDWacUyRQoRi4AWFhEEiwgWIgqCFmnsBNvUYmlhY2Vh6QP4TitnYUAkCO7uZM+d/IuDhRDxx82dna8dbGyNKpInAxDABZeACy64BFxwwSXgggsuARdccP+TzeG4Gu9NWgfcJRHM18e8k7y/3FSLx/NqenxUDbd3we0S93den65qaHAz5vPtrrq+PKlbELiZorYxOTgEN2fUl6NUcTjcVMU7o31wc/Zid+CwuBGAQ+O6A4fHTcCOg1wRuMrz4gLcnDmbTcHN2R6c1iV6wdVXeH57Wv8USJfAD/ez9cbVWsHPz9FoL5SugF2q1wI3RSiq5lKq1wo3Rb9v23vB/SMa+dsAO6wF2+IqbfqwQ2uwxtWsq+nThENrsMZt2x76fmqwx1X1NsXte+fCHlfR7sMq/s5a4jZ9NAM38zQbXHDBLRJXs62IE4kQuFqeZEDL9E/r3FjEnQl7XK31Np1E9H081R636QRCYW0h0x6dWgm4GVbEHAYzW1zBNh3EUhxO4djh6jPb7gg7tAQrXK29drUD7HLcvzfcdBNIz6JtngiWnd3lxE2mOF1SKQrX7TBeMbhu58SKwnW8s1YErtPhu6JwXWHD4wrW+U5aWFznig2N63Y8vwhcrRlEuDkZClfPsFGqNQyu1gmivg7AEldVqsEq2vV/G1xVpNYBUlSdmmFF6qfFbK2DCy64xb9XrJRXW/FGPHDBJeCCCy4BF1xwCbjgEnDBBZeAu8J8Aw63MVN/VqohAAAAAElFTkSuQmCC";

const LOGO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAYAAAA5ZDbSAAACmUlEQVR42u3dwW2DMBiGYUbwCIzACIyQERiBKzc2yAgZIVduLICUERiBEdJG+ZFQ20itioP9/e/hVU9tqjyKA8aYYhq6gnTjTQCYACaACWACmAAmgAEmgAlgApgAJoAJYIAJYAKYACaAKX3g+vNnv3Mn+7uPAnjHAj9A7m9onIbubPigCwJ/7TYNXTsNXQmuJvC2qw3nAIsCb4fxGmBd4C10BbAu8FoPsDbwejBWAawL/GiZhq4BWBfYxZAN8LMLwNrAssgAiyMD/L0GYG3gu9IpFMCvT6ECwLrA68UKgIWB73adGWBh4Dn3oToH4MWuBM3MdGkCjz+s92rtggEHXILA2yqbnOBTLAq8/VTPkb+LAT4QuLBh9MIMly7w2oXzYm3gmMgB4DSAC/s998O0MnBppziuLycqA8eYUZsBTgs4RPgUB4DTAS7s5rQ9gWuA0wKuPM9qeQAudh6mAU4Q+JrY/wPwzm9oDzDAAAMMMMAAAwwwR9EA/7E9V3ucAU4LuGQmSxu4ZS5aG3jvxXglwOkANxHWSHM9OBHgEOHTewU4HeAYC+9agNMAbiKtqiwBPh44Fu6NddHHA7fc2aAJHHaejpS5wzB34GCvtUTEzXp7pVyBT/amx4bN9uAqJ+DZJvjHN970LbM5Gnt0iG+nBLDYxAbA4ue9AP9+aK4A1gWW2ZAUYPEthQEW3J8S4NcHVQFgTeCb6sMtAX5+58o+udQ78FkV1jvworAXNMCvr065eb6wJ2AXj7LzCLzY/+PyEfDKwLNnWFXgxU57Tp5R1YBHe70a0HyX7PSbWsOsAOTmM4ABBhhggAH2Blx/OTD6Tw1Q6QETwAQwAUwAA0wAE8AEMAFMABPABDDABDABTAATwAQwAQwwyfUBTSjX2D84kdYAAAAASUVORK5CYII=";

function decode(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

/**
 * Branded PassKit icon — a gold "PennPaps" P-monogram on the pass
 * navy. Satisfies the spec's "icon.png MUST exist" rule and renders
 * as a recognizable card icon in the Wallet glance + notifications.
 */
export function defaultIconPng(): Buffer {
  return decode(ICON_PNG_BASE64);
}

/**
 * Branded PassKit logo — the gold P-monogram on a transparent
 * background, sized to sit beside the "PennPaps" logoText on the
 * pass face.
 */
export function defaultLogoPng(): Buffer {
  return decode(LOGO_PNG_BASE64);
}
