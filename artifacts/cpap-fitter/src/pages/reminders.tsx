import React, { useState } from "react";
import { Link } from "wouter";
import {
  useSubscribeToReminders,
  ApiError,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Bell, CheckCircle2, MailCheck, Sparkles } from "lucide-react";
import { REMINDER_ITEMS, todayIso, type ReminderSku } from "@/lib/reminder-defaults";
import { TechBackdrop } from "@/components/tech-backdrop";

const PAGE_TITLE = "Supply replacement reminders";

interface ItemState {
  enabled: boolean;
  lastReplacedAt: string;
  intervalDays: number;
}

function buildInitialState(): Record<ReminderSku, ItemState> {
  const today = todayIso();
  const out = {} as Record<ReminderSku, ItemState>;
  for (const def of REMINDER_ITEMS) {
    out[def.sku] = {
      enabled: def.defaultEnabled,
      lastReplacedAt: today,
      intervalDays: def.defaultIntervalDays,
    };
  }
  return out;
}

interface SuccessState {
  /**
   * The capability token, present only when this was a brand-new
   * subscription. When the email was already on file, the server
   * deliberately withholds this — to prevent email-enumeration takeover —
   * and instead emails the manage link directly to the registered owner.
   */
  manageToken?: string;
  alreadySubscribed: boolean;
  emailStatus: "sent" | "skipped" | "failed";
  message: string;
}

export function Reminders() {
  useDocumentTitle(PAGE_TITLE);
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [items, setItems] = useState(buildInitialState);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const { mutate, isPending, error } = useSubscribeToReminders();

  function toggleItem(sku: ReminderSku, checked: boolean) {
    setItems((prev) => ({ ...prev, [sku]: { ...prev[sku], enabled: checked } }));
  }
  function updateItem(sku: ReminderSku, patch: Partial<ItemState>) {
    setItems((prev) => ({ ...prev, [sku]: { ...prev[sku], ...patch } }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const enabledItems = REMINDER_ITEMS.filter((d) => items[d.sku].enabled).map((d) => ({
      sku: d.sku,
      lastReplacedAt: items[d.sku].lastReplacedAt,
      intervalDays: items[d.sku].intervalDays,
    }));

    if (enabledItems.length === 0) {
      setValidationError("Pick at least one supply to be reminded about.");
      return;
    }
    if (!email.trim()) {
      setValidationError("Enter the email where you want reminders sent.");
      return;
    }

    mutate(
      { data: { email: email.trim(), items: enabledItems, website: website || undefined } },
      {
        onSuccess: (resp) => {
          setSuccess({
            manageToken: resp.manageToken,
            alreadySubscribed: resp.alreadySubscribed ?? false,
            emailStatus: resp.emailStatus,
            message: resp.message,
          });
          // Scroll the success card into view on mobile so the user
          // notices the confirmation rather than thinking nothing happened.
          window.scrollTo({ top: 0, behavior: "smooth" });
        },
      },
    );
  }

  if (success) {
    // Two distinct success shapes:
    //  - new subscription: token was returned, show in-page manage link.
    //  - already-subscribed: token withheld for security; tell the user to
    //    check their inbox.
    const manageHref = success.manageToken
      ? `/reminders/manage?token=${encodeURIComponent(success.manageToken)}`
      : null;

    return (
      <>
        <TechBackdrop />
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 container max-w-2xl mx-auto px-4 py-12"
        >
          <Card className="border-0 glass-card rounded-2xl">
          <CardHeader className="text-center space-y-3">
            <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-navy flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <CardTitle className="text-2xl tracking-tight">
              {success.alreadySubscribed ? "Check your inbox" : "You're signed up"}
            </CardTitle>
            <CardDescription>{success.message}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {success.alreadySubscribed && success.emailStatus !== "sent" && (
              <Alert>
                <MailCheck className="w-4 h-4" />
                <AlertTitle>Could not send the manage email</AlertTitle>
                <AlertDescription>
                  Email delivery isn't configured here — please reach out to
                  Penn Home Medical Supply directly so we can update your
                  reminder preferences.
                </AlertDescription>
              </Alert>
            )}

            {!success.alreadySubscribed && success.emailStatus !== "sent" && (
              <Alert>
                <MailCheck className="w-4 h-4" />
                <AlertTitle>Confirmation email not sent</AlertTitle>
                <AlertDescription>
                  Save the manage link below — it's the easiest way to update
                  your dates or unsubscribe later.
                </AlertDescription>
              </Alert>
            )}

            {manageHref && (
              <div className="rounded-xl border bg-muted/40 p-4">
                <p className="text-sm font-medium mb-2">Your manage link</p>
                <Link
                  href={manageHref}
                  className="text-sm text-[hsl(var(--penn-navy))] underline break-all"
                  data-testid="link-manage-subscription"
                >
                  {window.location.origin}
                  {manageHref}
                </Link>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {manageHref && (
                <Link href={manageHref}>
                  <Button variant="outline" data-testid="button-manage-now">
                    Open manage page
                  </Button>
                </Link>
              )}
              <Link href="/">
                <Button variant="ghost">Back to PennPaps</Button>
              </Link>
            </div>
          </CardContent>
          </Card>
        </main>
      </>
    );
  }

  // Type the mutation error so we can read the typed `.data.error` payload
  // without sprinkling `as any`. Mirrors the order.tsx pattern.
  const apiError = error as ApiError<{ error?: string; details?: string[] }> | null;
  const apiErrorMessage = apiError
    ? (apiError.data?.error ?? apiError.message ?? "Could not save your subscription. Please try again.")
    : null;

  return (
    <>
      <TechBackdrop />
      <main
        id="main-content"
        tabIndex={-1}
        className="relative z-10 container max-w-3xl mx-auto px-4 py-10"
      >
        <div className="text-center space-y-3 mb-8">
          <div className="mx-auto w-14 h-14 rounded-2xl icon-halo-gold flex items-center justify-center">
            <Bell className="w-6 h-6" />
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight tech-backdrop-heading">
            Never miss a CPAP refill again
          </h1>
          <p className="tech-backdrop-subtle max-w-xl mx-auto">
            Pick which supplies you want reminders for and when you last replaced
            them. We'll email you the moment each item is due — no app to install,
            no account to create.
          </p>
        </div>

      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[hsl(var(--penn-gold))]" />
            Sign up for free reminders
          </CardTitle>
          <CardDescription>
            Adjust the intervals if your insurance covers a different cadence —
            you can always change them later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6" noValidate>
            <div className="space-y-2">
              <Label htmlFor="reminder-email">Email</Label>
              <Input
                id="reminder-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                data-testid="input-reminder-email"
              />
            </div>

            {/* Honeypot — visually hidden, not focusable, ignored by humans. */}
            <div aria-hidden="true" className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden">
              <Label htmlFor="reminder-website">Website (leave blank)</Label>
              <Input
                id="reminder-website"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>

            <fieldset className="space-y-4">
              <legend className="text-sm font-medium mb-2">
                What should we remind you about?
              </legend>
              <div className="space-y-3">
                {REMINDER_ITEMS.map((def) => {
                  const state = items[def.sku];
                  return (
                    <div
                      key={def.sku}
                      className="rounded-xl border bg-background/60 p-4 space-y-3"
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id={`item-${def.sku}`}
                          checked={state.enabled}
                          onCheckedChange={(c) => toggleItem(def.sku, c === true)}
                          data-testid={`checkbox-${def.sku}`}
                        />
                        <div className="flex-1">
                          <Label
                            htmlFor={`item-${def.sku}`}
                            className="text-base cursor-pointer"
                          >
                            {def.label}
                          </Label>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {def.description}
                          </p>
                        </div>
                      </div>
                      {state.enabled && (
                        <div className="grid sm:grid-cols-2 gap-3 pl-7">
                          <div className="space-y-1">
                            <Label
                              htmlFor={`last-${def.sku}`}
                              className="text-xs text-muted-foreground"
                            >
                              Last replaced
                            </Label>
                            <Input
                              id={`last-${def.sku}`}
                              type="date"
                              max={todayIso()}
                              value={state.lastReplacedAt}
                              onChange={(e) =>
                                updateItem(def.sku, { lastReplacedAt: e.target.value })
                              }
                              data-testid={`input-last-${def.sku}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label
                              htmlFor={`interval-${def.sku}`}
                              className="text-xs text-muted-foreground"
                            >
                              Remind every (days)
                            </Label>
                            <Input
                              id={`interval-${def.sku}`}
                              type="number"
                              min={1}
                              max={365}
                              value={state.intervalDays}
                              onChange={(e) =>
                                updateItem(def.sku, {
                                  intervalDays: Math.max(
                                    1,
                                    Math.min(365, Number(e.target.value) || def.defaultIntervalDays),
                                  ),
                                })
                              }
                              data-testid={`input-interval-${def.sku}`}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>

            {(validationError || apiErrorMessage) && (
              <Alert variant="destructive">
                <AlertDescription>
                  {validationError ?? apiErrorMessage}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={isPending}
                data-testid="button-subscribe"
              >
                {isPending ? "Saving..." : "Sign me up"}
              </Button>
              <Link href="/">
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Link>
            </div>

            <p className="text-xs text-muted-foreground">
              We'll only use your email to send these reminders and any
              follow-ups about your supplies. Unsubscribe with one click any
              time. We never sell your email.
            </p>
          </form>
        </CardContent>
      </Card>
      </main>
    </>
  );
}
