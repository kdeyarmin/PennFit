// CaregiverSection — designated authorized contact UI on /account.
//
// What this is
// ------------
// Lets the patient nominate one named person (spouse, adult child,
// home-health aide) who receives a separate, correctly-addressed
// copy of supplies-status emails — shipped + delivered. We
// deliberately do NOT extend this to claims / EOB / billing detail
// without an explicit second opt-in surface.
//
// Consent
// -------
// Pressing Save is the affirmation. We require a one-time checkbox
// ("I'm authorized to share supplies-status with this person") in
// the form so the consent is explicit rather than implicit-by-typing.
// The server stamps caregiver_consent_at when the row is created or
// the email changes; that timestamp is our written record.

import { useEffect, useState } from "react";
import { UserPlus, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AccountApiError,
  fetchCaregiver,
  revokeCaregiver,
  setCaregiver,
  type CaregiverView,
} from "@/lib/account-api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CaregiverSection() {
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<CaregiverView | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchCaregiver();
        if (!cancelled) setCurrent(r.caregiver);
      } catch {
        // Additive surface — failure here just renders the empty state.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openForm(seed?: CaregiverView | null) {
    setName(seed?.name ?? "");
    setEmail(seed?.email ?? "");
    setConsented(false);
    setError(null);
    setEditing(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || !EMAIL_RE.test(trimmedEmail) || !consented) return;
    setSaving(true);
    try {
      const r = await setCaregiver({ name: trimmedName, email: trimmedEmail });
      setCurrent(r.caregiver);
      setEditing(false);
    } catch (err) {
      if (err instanceof AccountApiError && err.payload?.error === "caregiver_is_self") {
        setError("That's your account email. Use a different email for your contact.");
      } else {
        setError("Something went wrong saving the contact. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    if (!confirm("Remove this designated contact?")) return;
    try {
      await revokeCaregiver();
      setCurrent(null);
    } catch {
      setError("Couldn't remove the contact. Please try again.");
    }
  }

  if (loading) return null;
  // Treat a revoked row as "no caregiver" for UI purposes; the server
  // keeps the row for audit reconstruction.
  const active = current && !current.revokedAt ? current : null;

  return (
    <section
      id="caregiver"
      className="glass-card rounded-2xl p-6 space-y-3"
      data-testid="account-caregiver-section"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Designated contact</h2>
        </div>
        {active && !editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openForm(active)}
            data-testid="account-caregiver-edit"
          >
            Edit
          </Button>
        )}
      </div>

      {!editing ? (
        active ? (
          <div className="space-y-2">
            <div className="rounded-xl glass-panel p-4">
              <p className="font-medium">{active.name}</p>
              <p className="text-sm text-muted-foreground">{active.email}</p>
              <p
                className="text-xs text-muted-foreground mt-2"
                data-testid="account-caregiver-consent-at"
              >
                Added {new Date(active.consentAt).toLocaleDateString()}
              </p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We&apos;ll send {active.name.split(" ")[0]} a separate email
              when your supplies ship and when they arrive. Claims and billing
              detail stay private to your account.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRevoke}
              className="gap-1.5"
              data-testid="account-caregiver-revoke"
            >
              <X className="h-3.5 w-3.5" />
              Remove contact
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Add one person — a spouse, adult child, or home-health aide —
              who should receive a copy of shipped &amp; delivered notifications
              along with you.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openForm()}
              data-testid="account-caregiver-add"
            >
              <UserPlus className="h-4 w-4 mr-1.5" />
              Add a designated contact
            </Button>
            <p className="text-xs text-muted-foreground">
              Their email is only used for supplies-status updates — never
              claims, EOB, or billing detail.
            </p>
          </div>
        )
      ) : (
        <form onSubmit={handleSave} className="space-y-3" data-testid="account-caregiver-form">
          <div className="space-y-2">
            <Label htmlFor="caregiver-name">Their name</Label>
            <Input
              id="caregiver-name"
              data-testid="caregiver-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Anna Reyes"
              autoComplete="name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="caregiver-email">Their email</Label>
            <Input
              id="caregiver-email"
              data-testid="caregiver-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={200}
              placeholder="anna@example.com"
              autoComplete="email"
              required
            />
          </div>
          <div
            className="flex flex-row items-start space-x-3 space-y-0 pt-1 cursor-pointer"
            onClick={() => setConsented(!consented)}
          >
            <Checkbox
              id="caregiver-consent"
              checked={consented}
              onCheckedChange={(c) => setConsented(c as boolean)}
            />
            <div className="space-y-1 leading-none">
              <label
                htmlFor="caregiver-consent"
                className="text-sm font-medium cursor-pointer"
              >
                I&apos;m authorized to share supplies-status with this person
              </label>
              <p className="text-xs text-muted-foreground">
                Required by HIPAA. You can remove them anytime.
              </p>
            </div>
          </div>

          {error && (
            <p
              className="text-sm text-destructive"
              data-testid="account-caregiver-error"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              type="submit"
              size="sm"
              disabled={
                saving ||
                !name.trim() ||
                !EMAIL_RE.test(email.trim()) ||
                !consented
              }
              data-testid="account-caregiver-save"
              className="gap-1.5"
            >
              <ShieldCheck className="h-4 w-4" />
              {saving ? "Saving…" : "Save contact"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
