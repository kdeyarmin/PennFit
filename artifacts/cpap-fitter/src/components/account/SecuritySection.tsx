// /account → Account tab → "Sign-in & security" section.
//
// Lets a signed-in customer change their password WITHOUT logging out and
// running the email "forgot password" round-trip (which was the only path
// before — the chatbot literally answered "How do I change my password?"
// with "-> /forgot-password"). Wraps the existing, tested
// POST /api/auth/change-password endpoint via authHooks.useChangePassword
// (CSRF-injecting React Query mutation). The server re-verifies the
// current password and enforces the real strength rule; the client checks
// here are just fast, friendly guards.

import { useState } from "react";

import { AlertTriangle, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { authErrorMessage } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { AccountApiError, closeAccount } from "@/lib/account-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Friendly client-side floor. The server is the source of truth; this just
// avoids an obviously-doomed round-trip and gives instant feedback.
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Pure client-side validation for the change-password form. Returns a
 * human-readable error string, or null when the input is acceptable to
 * submit. Exported so the logic is unit-tested directly (no DOM render).
 * The SERVER re-verifies the current password and enforces the real
 * strength rule — these checks only catch the obvious cases fast.
 */
export function validatePasswordChange(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): string | null {
  const { currentPassword, newPassword, confirmPassword } = input;
  if (!currentPassword || !newPassword) {
    return "Please fill in every field.";
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (newPassword !== confirmPassword) {
    return "The new passwords don't match.";
  }
  if (newPassword === currentPassword) {
    return "Your new password must be different from the current one.";
  }
  return null;
}

/**
 * Map a close-account failure to a friendly message. Pure; unit-tested.
 * Server error codes: invalid_password, password_unavailable, invalid_body.
 */
export function closeAccountErrorMessage(err: unknown): string {
  const code =
    err instanceof AccountApiError ? (err.payload?.error ?? null) : null;
  switch (code) {
    case "invalid_password":
      return "That password is incorrect. Please try again.";
    case "password_unavailable":
      return "We couldn't verify your password. Please contact support.";
    case "invalid_body":
      return "Please enter your password to confirm.";
    default:
      return "We couldn't close your account just now. Please try again.";
  }
}

export function SecuritySection() {
  const changePassword = authHooks.useChangePassword();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const submitting = changePassword.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setClientError(null);
    setServerError(null);
    setSavedAt(null);

    const validationError = validatePasswordChange({
      currentPassword,
      newPassword,
      confirmPassword,
    });
    if (validationError) {
      setClientError(validationError);
      return;
    }

    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      // Clear the fields so the new password isn't left sitting in the DOM.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSavedAt(Date.now());
    } catch (err) {
      setServerError(
        authErrorMessage(err, {
          action: "change your password",
          subject: "password",
          fallback:
            "We couldn't change your password just now. Please try again.",
        }),
      );
    }
  };

  return (
    <>
      <section
        className="glass-card rounded-2xl p-6 space-y-4"
        aria-labelledby="security-section-heading"
        data-testid="account-security-section"
      >
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h2 id="security-section-heading" className="font-semibold">
            Sign-in &amp; security
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Change your password. You&apos;ll stay signed in on this device.
        </p>

        <form onSubmit={onSubmit} className="space-y-4 max-w-md">
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              data-testid="account-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              data-testid="account-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              data-testid="account-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
            />
          </div>

          {clientError && (
            <p role="alert" className="text-sm text-rose-700">
              {clientError}
            </p>
          )}
          {serverError && (
            <p role="alert" className="text-sm text-rose-700">
              {serverError}
            </p>
          )}
          {savedAt !== null && (
            <p
              role="status"
              className="text-sm text-emerald-700 inline-flex items-center gap-1.5"
            >
              <CheckCircle2 className="h-4 w-4" />
              Your password has been updated.
            </p>
          )}

          <Button
            type="submit"
            disabled={submitting}
            data-testid="account-change-password-btn"
          >
            {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Update password
          </Button>
        </form>
      </section>
      <CloseAccountControl />
    </>
  );
}

/**
 * "Danger zone" — self-serve account closure. Two-step (button → password
 * confirm) for a destructive, irreversible action. On success the server
 * has anonymized the account + revoked the session, so we hard-navigate to
 * a signed-out state rather than leave stale authed UI on screen.
 */
function CloseAccountControl() {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClose = async () => {
    if (!password) {
      setError("Please enter your password to confirm.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await closeAccount(password);
      // Session is dead + login disabled. Hard-navigate so no stale authed
      // UI lingers and the dead session resolves to signed-out.
      window.location.assign("/");
    } catch (err) {
      setError(closeAccountErrorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4 border border-rose-200"
      aria-labelledby="close-account-heading"
      data-testid="account-close-section"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-rose-600" />
        <h2 id="close-account-heading" className="font-semibold">
          Close your account
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        This permanently closes your account and removes your personal details
        (name, email, phone, and addresses). For accounting and legal reasons we
        keep a record of your past orders, with the personal details removed.
        You won&apos;t be able to sign in afterwards, and this can&apos;t be
        undone.
      </p>

      {!confirming ? (
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          data-testid="account-close-start"
        >
          Close account
        </Button>
      ) : (
        <div className="space-y-3 max-w-md">
          <div className="space-y-1.5">
            <Label htmlFor="close-password">
              Enter your password to confirm
            </Label>
            <Input
              id="close-password"
              data-testid="account-close-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="destructive"
              onClick={onClose}
              disabled={submitting}
              data-testid="account-close-confirm"
            >
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Permanently close account
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setPassword("");
                setError(null);
              }}
              disabled={submitting}
            >
              Keep my account
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
