import React from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { getCompanyContact } from "@/lib/contact";

interface Props {
  children: React.ReactNode;
  /**
   * `fullscreen` (default) centers the fallback in the whole viewport — use it
   * at the top of the app where a crash means the entire tree is gone.
   * `inline` renders a non-full-height card that sits inside surrounding chrome
   * (header/nav/footer), so a single page crash doesn't strand the user without
   * navigation.
   */
  variant?: "fullscreen" | "inline";
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React error boundary.
 *
 * Without this, a thrown render error anywhere in the tree leaves the user
 * staring at a blank white page with no way to recover except hitting the
 * browser back button. The top-level instance wraps the entire patient-facing
 * app; a second `inline` instance nested inside the patient Layout isolates
 * per-page crashes so the header/nav/footer stay usable and the customer can
 * navigate away (the inline boundary is re-keyed on route change so moving to
 * another page clears the error). Both fall back to a recoverable, on-brand
 * "something went wrong" card with clear actions: reload, jump home, or call
 * support. The full error is logged to the console for diagnosis.
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

    const inline = this.props.variant === "inline";
    // Class component (no hooks) — a point-in-time snapshot is fine
    // for a crash screen.
    const contact = getCompanyContact();

    return (
      <div
        role="alert"
        aria-live="assertive"
        className={
          inline
            ? "flex items-center justify-center px-6 py-16"
            : "min-h-[100dvh] flex items-center justify-center bg-background p-6"
        }
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
            this keeps happening, please call us at {contact.name} at{" "}
            <a
              href={`tel:${contact.phoneE164}`}
              className="font-medium text-foreground underline underline-offset-2"
            >
              {contact.phoneDisplay}
            </a>{" "}
            and we'll help you finish what you were doing.
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
