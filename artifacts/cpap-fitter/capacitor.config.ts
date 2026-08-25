// Capacitor wrapper config (Phase D / feature #6).
//
// Capacitor packages the existing Vite SPA as native iOS + Android
// shells without rewriting in React Native. The webDir below is the
// production Vite build output; running `pnpm cap sync` after a
// build copies that into the iOS / Android Xcode / Gradle projects.
//
// Why Capacitor (vs React Native, Expo, etc):
//   * Single codebase. The web SPA is the source of truth; native
//     is a thin shell. No drift between platforms.
//   * Older patient demographic — UI changes mean web AND mobile
//     refresh at the same cadence.
//   * Lightweight plugin model for the few native bits we need
//     (biometric login, push, secure storage).
//
// The actual iOS + Android project files live in /ios and
// /android once a developer runs `pnpm cap add ios` /
// `pnpm cap add android` locally. We don't commit those today
// because they're large auto-generated trees and bind us to the
// Xcode / Android Studio versions of whoever ran the command. See
// CAPACITOR.md for the full build flow.

import type { CapacitorConfig } from "@capacitor/cli";

// The native shell is the PLATFORM's app, not a tenant's: one store
// listing, one bundle, and the SPA inside resolves the operating tenant's
// brand from the host it loads (see src/lib/branding.ts). Naming it after a
// single tenant would put that tenant's name on every other tenant's home
// screen — so the app id and display name are CareMetric Breathe.
const config: CapacitorConfig = {
  appId: "com.caremetric.breathe",
  appName: "CareMetric Breathe",
  // Vite build output. Make sure `pnpm build` runs before
  // `pnpm cap sync`.
  webDir: "dist/public",
  // Native splash + status-bar treatment is intentionally minimal —
  // we lean on the SPA's CSS for branding so the splash <→> SPA
  // hand-off doesn't flash a different background color.
  ios: {
    contentInset: "always",
  },
  android: {
    allowMixedContent: false,
  },
  // Future plugin config slots (BiometricAuth, PushNotifications,
  // etc) land here as we wire them in. Empty for the scaffold PR
  // so we don't ship dead config for plugins that aren't installed
  // yet.
  plugins: {},
};

export default config;
