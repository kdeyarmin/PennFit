# Capacitor mobile build (Phase D / feature #6)

This artifact ships to web (PennPaps.com) AND iOS / Android via
Capacitor. The same Vite bundle runs in all three; native is a thin
shell that hosts the web view + a few plugins for hardware-only bits
(biometric login, push notifications, secure storage).

## Why Capacitor (not React Native)

- Single codebase. The web SPA is the source of truth.
- Older patient demographic — UI iterates on web AND mobile at the same
  cadence with no platform-specific divergence.
- Lightweight plugin model for the few native bits we need.

## What's in the repo today

- `capacitor.config.ts` — declarative config (appId, webDir, etc).
- `src/lib/native-runtime.ts` — feature-detection helpers
  (`isNativeApp()`, `promptBiometric()`). All Capacitor imports are
  dynamic so the same bundle still loads on plain web when the
  native packages aren't installed.
- `src/hooks/use-biometric-signin.ts` — React abstraction the sign-in
  page composes.

## What's NOT in the repo today

- `/ios` and `/android` platform projects. These are large
  auto-generated trees, and committing them ties the repo to whoever
  ran `npx cap add` first. They're produced on-demand by the build
  pipeline below.
- The `@capacitor/*` and `@capacitor-community/biometric-auth` deps
  in `package.json`. Adding them to the workspace lockfile in this
  PR would change install behavior for every contributor; they get
  added when a developer first runs `pnpm cap add ios`.

## First-time mobile build (per developer)

```bash
# From artifacts/cpap-fitter:

# 1. Install Capacitor + plugins. Adds to package.json + lockfile.
pnpm add @capacitor/core @capacitor/ios @capacitor/android
pnpm add -D @capacitor/cli
pnpm add @capacitor-community/biometric-auth

# 2. Build the SPA so dist/ is up to date.
pnpm build

# 3. Add the iOS platform project. Generates /ios/.
pnpm cap add ios

# 4. (Optional) Add the Android platform project. Generates /android/.
pnpm cap add android

# 5. Sync the dist/ output into both platforms.
pnpm cap sync

# 6. Open Xcode (or Android Studio) and run.
pnpm cap open ios
# or
pnpm cap open android
```

After the first run, subsequent iterations are:

```bash
pnpm build && pnpm cap sync && pnpm cap open ios
```

## Adding the recommended package.json scripts

Once Capacitor is installed locally, add these to `package.json`:

```json
"scripts": {
  "cap:sync": "pnpm build && cap sync",
  "cap:ios": "cap open ios",
  "cap:android": "cap open android"
}
```

## Plugin checklist (subsequent phases)

- [x] `@capacitor-community/biometric-auth` — Touch / Face ID via
      `promptBiometric()`. Wired today, no-ops on web.
- [ ] `@capacitor/push-notifications` — replaces the W3C Web Push
      flow on native (Phase C.1 covers web). Future phase.
- [ ] `@capacitor/preferences` — replaces `localStorage` for any
      data we want to survive cache clears.
- [ ] `@capacitor/app` — deep-link handling for SMS reorder magic
      links (Phase 10 SMS "Reply YES" flow).
