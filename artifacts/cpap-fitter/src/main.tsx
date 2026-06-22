// Boot sequence.
//
// Demo mode is a CLIENT-ONLY sandbox whose router pulls in a large set
// of in-browser fixtures (hundreds of seeded API routes). To keep that
// weight out of live traffic, the demo sandbox is loaded LAZILY — only
// when the demo flag is active — via a dynamic `./demo/boot` import that
// Vite splits into its own chunk. Live storefront/admin visitors never
// download or parse it.
//
// Ordering matters: the demo fetch interceptor must replace window.fetch
// BEFORE the auth client (a transitive import of <App>) binds
// globalThis.fetch at module-load time. So we `await import("./demo/boot")`
// first, and only then dynamically import <App>. Resolving the flag uses
// the dependency-light demo/state module, which does NOT drag in the
// demo router/fixtures.
import "./index.css";
import { createRoot } from "react-dom/client";
import { resolveDemoActive } from "./demo/state";

async function bootstrap(): Promise<void> {
  if (resolveDemoActive()) {
    // Installs the fetch interceptor (and pulls the demo chunk) only in
    // demo mode — before <App> evaluates its auth-client import.
    await import("./demo/boot");
  }

  const { default: App } = await import("./App");
  const { reportWebVitals } = await import("./lib/web-vitals-reporter");

  createRoot(document.getElementById("root")!).render(<App />);
  reportWebVitals();
}

void bootstrap();
