// Minimal ambient shim for @capacitor/cli.
//
// @capacitor/cli is an optional per-developer devDependency (see
// CAPACITOR.md). When it isn't installed, TypeScript uses this shim so
// capacitor.config.ts type-checks in CI. When the real package IS
// installed, TypeScript prefers the package's own types over this shim
// automatically — no manual cleanup required.
//
// Keep the shape in sync with CapacitorConfig from the @capacitor/cli
// package. Only the fields used in capacitor.config.ts are declared here;
// the catch-all index signature handles any future additions.

declare module "@capacitor/cli" {
  interface CapacitorConfig {
    appId?: string;
    appName?: string;
    /** Path to the built web assets, relative to the project root. */
    webDir?: string;
    ios?: {
      contentInset?: "always" | "never" | "scrollableAxes";
      [key: string]: unknown;
    };
    android?: {
      allowMixedContent?: boolean;
      [key: string]: unknown;
    };
    plugins?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  }
}
