// Native-runtime feature detection (Phase D / feature #6).
//
// The same Vite bundle ships to both web (PennPaps.com) and the
// Capacitor-wrapped iOS / Android apps. Rather than scatter
// `if (Capacitor)` checks across the codebase, this module:
//
//   1. Detects whether we're inside a Capacitor shell (vs vanilla
//      browser).
//   2. Lazily imports the Capacitor APIs so a vanilla web bundle
//      that doesn't have @capacitor/* installed still loads.
//   3. Surfaces a tiny biometric-prompt abstraction that returns
//      a typed Result, no platform-specific exceptions to catch
//      at every callsite.
//
// All imports here are dynamic. Static imports of @capacitor/core
// would crash a web-only bundle if the package isn't installed —
// which is the working state until a deployer runs `pnpm cap add ios`
// (or android) and the install pulls the deps.

export type BiometricResult =
  | { kind: "ok" }
  | { kind: "not-supported"; reason: "web" | "no-plugin" | "no-hardware" }
  | { kind: "denied"; reason: "user-cancel" | "lockout" | "permission" }
  | { kind: "error"; message: string };

/**
 * Returns true when the SPA is running inside a Capacitor-wrapped
 * native shell (iOS or Android), false on plain web.
 */
export async function isNativeApp(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Capacitor injects a `Capacitor` global on the platform side
  // before the JS bundle runs. Cheap synchronous check first.
  const cap = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  if (!cap?.isNativePlatform) return false;
  try {
    return cap.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Prompt the OS for a biometric authentication. Returns immediately
 * with `kind: "not-supported"` on web or when the BiometricAuth
 * plugin isn't installed — callers should fall back to the standard
 * password sign-in UI in that case.
 *
 * `reason` is a static label rendered to the user when the prompt
 * appears (e.g. "Unlock PennPaps"). Keep it short — Face ID and
 * Touch ID truncate aggressively.
 */
export async function promptBiometric(
  reason: string,
): Promise<BiometricResult> {
  if (!(await isNativeApp())) {
    return { kind: "not-supported", reason: "web" };
  }
  try {
    // Dynamic import via `Function` so TypeScript doesn't try to
    // statically resolve a package that may or may not be installed
    // at compile time. When the plugin isn't installed, the import
    // throws and we treat that as "no-plugin" rather than a hard
    // crash. Once a deployer runs `pnpm install` with the plugin
    // listed in package.json, this branch becomes the happy path.
    //
    // Plugin: @capacitor-community/biometric-auth
    //   https://github.com/aparajita/capacitor-biometric-auth
    const importer = new Function("m", "return import(m)") as (
      m: string,
    ) => Promise<unknown>;
    const mod: unknown = await importer(
      "@capacitor-community/biometric-auth",
    ).catch(() => null);
    if (!mod) {
      return { kind: "not-supported", reason: "no-plugin" };
    }
    const BiometricAuth = (
      mod as {
        BiometricAuth?: {
          authenticate?: (opts: { reason: string }) => Promise<unknown>;
        };
      }
    ).BiometricAuth;
    if (!BiometricAuth?.authenticate) {
      return { kind: "not-supported", reason: "no-plugin" };
    }
    await BiometricAuth.authenticate({ reason });
    return { kind: "ok" };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // The plugin's documented error codes. Map to our typed result
    // so callers only handle a small union.
    if (e.code === "userCancel") {
      return { kind: "denied", reason: "user-cancel" };
    }
    if (e.code === "biometryLockout") {
      return { kind: "denied", reason: "lockout" };
    }
    if (e.code === "biometryNotAvailable") {
      return { kind: "not-supported", reason: "no-hardware" };
    }
    if (e.code === "noPermission") {
      return { kind: "denied", reason: "permission" };
    }
    return { kind: "error", message: e.message ?? String(err) };
  }
}
