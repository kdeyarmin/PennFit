import { Switch, Route, Router as WouterRouter } from "wouter";
import NotFound from "./pages/not-found";

// Penn Resupply Operator Console — Phase 0 placeholder.
//
// This is the operator-facing console. The Phase 0 deliverable is a
// minimal Penn-branded shell so contributors can confirm the artifact
// boots and the brand bar renders. Real screens (queue, episode
// detail, conversation viewer, fulfillment screen) land in Phase 4+.
function Home() {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "#f7f8fb" }}>
      <header
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ backgroundColor: "#0a1f44", borderColor: "#0a1f44" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 rounded flex items-center justify-center font-bold"
            style={{ backgroundColor: "#c9a24a", color: "#0a1f44" }}
            aria-hidden="true"
          >
            P
          </div>
          <div className="leading-tight">
            <div className="text-white font-semibold tracking-tight">
              Penn Resupply Console
            </div>
            <div className="text-xs" style={{ color: "#c9a24a" }}>
              Operator workstation
            </div>
          </div>
        </div>
        <div className="text-xs uppercase tracking-wider" style={{ color: "#c9a24a" }}>
          Phase 0 · Scaffold
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div
          className="max-w-xl w-full bg-white border rounded-lg p-8 shadow-sm"
          style={{ borderColor: "#e5e7eb" }}
        >
          <p
            className="text-xs uppercase tracking-[0.2em] mb-3 font-semibold"
            style={{ color: "#c9a24a" }}
          >
            CPAP Resupply Automation
          </p>
          <h1 className="text-2xl font-semibold mb-3" style={{ color: "#0a1f44" }}>
            Operator console placeholder
          </h1>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#374151" }}>
            This is the resupply dashboard scaffold. Real operator screens —
            patient queue, episode detail, conversation viewer, fulfillment —
            land in Phase 4. For Phase 0, this page exists only to confirm
            the artifact boots, the brand bar renders, and the routing shell
            is wired correctly.
          </p>
          <p className="text-sm leading-relaxed" style={{ color: "#374151" }}>
            See <code className="text-xs px-1 py-0.5 bg-gray-100 rounded">docs/resupply/README.md</code>{" "}
            for an onboarding tour and the phased build plan.
          </p>
        </div>
      </main>

      <footer
        className="text-xs px-6 py-3 border-t text-center"
        style={{ color: "#6b7280", backgroundColor: "#ffffff", borderColor: "#e5e7eb" }}
      >
        Penn Home Medical Supply · Internal tooling · Not for patient use
      </footer>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Router />
    </WouterRouter>
  );
}

export default App;
