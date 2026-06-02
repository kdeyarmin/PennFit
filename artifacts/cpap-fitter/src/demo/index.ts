// Public surface of the client-side demo sandbox.
//
//   * installDemoFetchInterceptor() — call ONCE in main.tsx, before
//     <App> is imported, so the fetch wrapper is in place before any
//     module binds globalThis.fetch.
//   * <DemoModeProvider> / <DemoBanner> / useDemoMode — the React glue
//     mounted near the root of the tree.
//   * isDemoActive() — synchronous flag read for non-React callers.

export { installDemoFetchInterceptor } from "./install";
export { DemoModeProvider, useDemoMode } from "./DemoModeProvider";
export { DemoBanner } from "./DemoBanner";
export { isDemoActive, setDemoActive, reloadIntoMode } from "./state";
