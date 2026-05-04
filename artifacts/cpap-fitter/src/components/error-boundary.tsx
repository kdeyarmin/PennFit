import React from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level React error boundary.
 *
 * Without this, a thrown render error anywhere in the tree leaves the user
 * staring at a blank white page with no way to recover except hitting the
 * browser back button. We wrap the entire patient-facing app so that any
 * runtime crash falls back to a recoverable, on-brand "something went wrong"
 * screen with two clear actions: reload the current page, or jump to the home
 * route. The full error is logged to the console for diagnosis.
 *
 * This is a class component because React still requires class components for
 * `getDerivedStateFromError` / `componentDidCatch` — the function-component
 * equivalent does not exist.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] caught a render error:", error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="min-h-[100dvh] flex items-center justify-center bg-background p-6"
        data-testid="error-boundary-fallback"
      >
        <div className="glass-card rounded-2xl p-8 max-w-lg text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
            <AlertTriangle
              className="h-6 w-6 text-amber-700"
              aria-hidden="true"
            />
          </div>
          <h1 className="text-2xl font-semibold mb-2">Something went wrong</h1>
          <p className="text-muted-foreground mb-6">
            The page hit an unexpected error. Reloading usually fixes it. If
            this keeps happening, please call us at Penn Home Medical Supply and
            we'll help you finish what you were doing.
          </p>
          {/*
            Development-only diagnostic. We print the thrown error's message
            inline so a developer reproducing the bug doesn't have to dig
            into DevTools to find the cause. Kept out of production builds
            because raw stack messages are confusing to patients and may
            inadvertently leak internal details.
          */}
          {import.meta.env.DEV && this.state.error && (
            <pre
              className="mb-6 text-left text-xs text-destructive bg-destructive/5 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words"
              data-testid="error-boundary-debug"
            >
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
            </pre>
          )}
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={this.handleReload} data-testid="error-reload-btn">
              Reload page
            </Button>
            <Button variant="outline" asChild>
              {/*
                Use import.meta.env.BASE_URL (always trailing-slash, e.g.
                "/" or "/cpap-fitter/") so the recovery link works whether
                the artifact is deployed at the domain root or behind the
                shared proxy on a sub-path. A bare href="/" would land
                outside the artifact mount in sub-path deployments.
              */}
              <a href={import.meta.env.BASE_URL} data-testid="error-home-link">
                Back to home
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
