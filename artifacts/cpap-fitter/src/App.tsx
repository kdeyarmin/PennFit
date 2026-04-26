import { Switch, Route, Router as WouterRouter } from "wouter";
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
import { FitterProvider } from "@/hooks/use-fitter-store";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/consent" component={Consent} />
        <Route path="/capture" component={Capture} />
        <Route path="/measure" component={Measure} />
        <Route path="/questionnaire" component={Questionnaire} />
        <Route path="/results" component={Results} />
        <Route path="/order" component={Order} />
        <Route path="/order-success" component={OrderSuccess} />
        <Route path="/masks" component={Masks} />
        <Route path="/how-it-works" component={HowItWorks} />
        <Route path="/privacy" component={Privacy} />
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
