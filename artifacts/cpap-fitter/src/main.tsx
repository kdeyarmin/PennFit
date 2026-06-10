// `./demo/boot` MUST be the first import: it installs the demo-mode
// fetch interceptor, which has to replace window.fetch before any other
// module (notably the auth client, which binds globalThis.fetch at
// load time) is evaluated. In live mode the interceptor is a
// transparent passthrough.
import "./demo/boot";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { reportWebVitals } from "./lib/web-vitals-reporter";
import { installStaleChunkRecovery } from "./lib/stale-chunk-recovery";

// Must be registered before the first lazy route can fail, i.e. before
// render. See stale-chunk-recovery.ts for the deploy-invalidates-chunks
// failure mode this absorbs.
installStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(<App />);
reportWebVitals();
