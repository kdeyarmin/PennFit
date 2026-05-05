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
 * Returns the Capacitor native platform ("ios" or "android") when
 * running inside a native shell, or "web" in a plain browser.
 * Synchronous — relies on the `Capacitor` global injected before the
 * JS bundle runs.
 */
export function getNativePlatform(): "ios" | "android" | "web" {
  if (typeof window === "undefined") return "web";
  const cap = (
    window as unknown as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  if (!cap?.getPlatform) return "web";
  try {
    const p = cap.getPlatform();
    if (p === "ios" || p === "android") return p;
  } catch {
    // ignore
  }
  return "web";
}

/**
 * Checks whether the device has biometric hardware that is enrolled
 * and available. Returns false on web, when the plugin isn't
 * installed, or when the OS reports no usable biometry.
 *
 * Used by BiometricLockToggle to avoid surfacing the preference toggle
 * on devices where the gate would always fall open.
 */
// @capacitor-community/biometric-auth is an optional runtime dependency
// present only in native Capacitor builds. Storing the package name in a
// `string`-typed variable prevents TypeScript from statically resolving
// the module declarations at compile time (which would fail when the
// package isn't installed), and avoids the `new Function` / eval pattern
// that static analysis tools flag as a code-injection risk.
const BIOMETRIC_PLUGIN: string = "@capacitor-community/biometric-auth";

type BiometricPlugin = {
  BiometricAuth?: {
    authenticate?: (opts: { reason: string }) => Promise<unknown>;
    checkBiometry?: () => Promise<{ isAvailable: boolean }>;
  };
};

async function loadBiometricPlugin(): Promise<BiometricPlugin | null> {
  return (import(BIOMETRIC_PLUGIN).catch(() => null)) as Promise<BiometricPlugin | null>;
}

export async function checkBiometricAvailability(): Promise<boolean> {
  if (!(await isNativeApp())) return false;
  try {
    const mod = await loadBiometricPlugin();
    if (!mod?.BiometricAuth?.checkBiometry) return false;
    const result = await mod.BiometricAuth.checkBiometry();
    return result.isAvailable === true;
  } catch {
    return false;
  }
}

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
    // loadBiometricPlugin() uses a variable-based import so TypeScript and
    // bundler tools don't try to resolve the optional package at build time.
    // When the plugin isn't installed the import rejects and we return
    // "no-plugin". Once a deployer runs `pnpm install` with the plugin
    // listed in package.json this branch becomes the happy path.
    //
    // Plugin: @capacitor-community/biometric-auth
    //   https://github.com/aparajita/capacitor-biometric-auth
    const mod = await loadBiometricPlugin();
    if (!mod?.BiometricAuth?.authenticate) {
      return { kind: "not-supported", reason: "no-plugin" };
    }
    await mod.BiometricAuth.authenticate({ reason });
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
