import React, { useEffect, useState } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { Home } from "@/pages/home";
import { Consent } from "@/pages/consent";
import { Capture } from "@/pages/capture";
import { Measure } from "@/pages/measure";
import { Questionnaire } from "@/pages/questionnaire";
import { Results } from "@/pages/results";
import { Order } from "@/pages/order";
import { OrderSuccess } from "@/pages/order-success";
import { Masks } from "@/pages/masks";
import { Privacy } from "@/pages/privacy";
import { HowItWorks } from "@/pages/how-it-works";
import { FitterProvider, useFitterStore } from "@/hooks/use-fitter-store";

const queryClient = new QueryClient();

/**
 * Guard helpers — each is rendered as the function-child of a Wouter
 * <Route>. We can't use a custom <ProtectedRoute> wrapper here because
 * Wouter's <Switch> only inspects its direct <Route> children's `path`
 * prop and would otherwise fall through to NotFound.
 *
 * Each guard:
 *   1. Reads from the in-memory fitter store (which lives in a context),
 *   2. If the precondition fails, returns <Redirect> — the URL changes
 *      and the protected page never mounts (no flash of intermediate UI),
 *   3. Otherwise mounts the page.
 *
 * This replaces the older per-page useEffect+setLocation+`return null`
 * pattern, which left the URL out of sync with rendered content during
 * the redirect tick.
 */
function GuardedMeasure() {
  const { capturedImage } = useFitterStore();
  if (!capturedImage) return <Redirect to="/capture" />;
  return <Measure />;
}
function GuardedQuestionnaire() {
  const { measurements } = useFitterStore();
  if (!measurements) return <Redirect to="/capture" />;
  return <Questionnaire />;
}
function GuardedResults() {
  const { measurements } = useFitterStore();
  if (!measurements) return <Redirect to="/" />;
  return <Results />;
}
function GuardedOrder() {
  const { chosenMask } = useFitterStore();
  if (!chosenMask) return <Redirect to="/results" />;
  return <Order />;
}

/**
 * Order-success has its own gating: the order confirmation lives in
 * sessionStorage (so a refresh after order doesn't re-submit) rather
 * than in the in-memory fitter store. We check it here at route-mount
 * time so a deep link to /order-success either renders cleanly or
 * redirects.
 */
function GuardedOrderSuccess() {
  const [state, setState] = useState<"checking" | "ok" | "deny">("checking");
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("fitter_order_confirmation");
      setState(stored ? "ok" : "deny");
    } catch {
      setState("deny");
    }
  }, []);
  if (state === "checking") return null;
  if (state === "deny") return <Redirect to="/" />;
  return <OrderSuccess />;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/consent" component={Consent} />
        <Route path="/capture" component={Capture} />
        <Route path="/masks" component={Masks} />
        <Route path="/how-it-works" component={HowItWorks} />
        <Route path="/privacy" component={Privacy} />

        {/* Guarded routes — see GuardedXxx components above. */}
        <Route path="/measure" component={GuardedMeasure} />
        <Route path="/questionnaire" component={GuardedQuestionnaire} />
        <Route path="/results" component={GuardedResults} />
        <Route path="/order" component={GuardedOrder} />
        <Route path="/order-success" component={GuardedOrderSuccess} />

        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <FitterProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </FitterProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
