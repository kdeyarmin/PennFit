// Public surface of the client-side demo sandbox.
//
//   * installDemoFetchInterceptor() — call ONCE in main.tsx, before
//     <App> is imported, so the fetch wrapper is in place before any
//     module binds globalThis.fetch.
//   * <DemoModeProvider> / useDemoMode — the React glue mounted near the
//     root of the tree. The demo/live toggle lives on the admin Settings
//     page (see admin-settings.tsx).
//   * isDemoActive() — synchronous flag read for non-React callers.

export { installDemoFetchInterceptor } from "./install";
export { DemoModeProvider, useDemoMode } from "./DemoModeProvider";
export { isDemoActive, setDemoActive, reloadIntoMode } from "./state";
