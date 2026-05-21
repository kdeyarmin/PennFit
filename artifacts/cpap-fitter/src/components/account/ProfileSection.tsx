// /account → "Profile & shipping" section.
//
// Patient-editable display name + default shipping address. The
// save flow validates the address against the shop's heuristic
// probe and surfaces "address looks unusual" warnings before
// committing -- a CSR override path is one click away.
//
// "Unsaved changes" beforeunload prompt + visible warning hook is
// scoped to this section since it's the primary write surface on
// the page.

import { useState } from "react";

import {
  CheckCircle2,
  Loader2,
  MapPin,
  User as UserIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  updateShopMe,
  type SavedShippingAddress,
  type ShopMeResponse,
} from "@/lib/account-api";

export function ProfileSection({
  profile,
  onSaved,
}: {
  profile: NonNullable<ShopMeResponse["profile"]>;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [addr, setAddr] = useState<SavedShippingAddress>(
    profile.shippingAddress ?? {
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    },
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addrWarnings, setAddrWarnings] = useState<string[]>([]);
  // When the user has been warned about a suspicious address and
  // clicks Save a second time, we let it through. Cleared whenever
  // any address field changes so a stale "override" doesn't ride
  // forward into a new edit.
  const [overrideAddrWarning, setOverrideAddrWarning] = useState(false);

  // Field-by-field comparison against the original profile snapshot
  // tells us whether the form has unsaved changes. We use trimmed
  // values to mirror what would actually be persisted (so adding
  // trailing whitespace to your name doesn't trigger the warning).
  // `addr.line2` falls back to "" because the original profile
  // stores nullable line2 as null and the input always returns "".
  const initialAddr = profile.shippingAddress ?? null;
  const dirty =
    (displayName.trim() || null) !== (profile.displayName ?? null) ||
    (addr.line1?.trim() ?? "") !== (initialAddr?.line1 ?? "") ||
    (addr.line2?.trim() ?? "") !== (initialAddr?.line2 ?? "") ||
    (addr.city?.trim() ?? "") !== (initialAddr?.city ?? "") ||
    (addr.state?.trim().toUpperCase() ?? "") !== (initialAddr?.state ?? "") ||
    (addr.postalCode?.trim() ?? "") !== (initialAddr?.postalCode ?? "");

  // Surface the browser's native "unsaved changes" prompt when the
  // user tries to close / reload the tab with edits in flight.
  // Cleared automatically once `dirty` flips false (after save).
  useUnsavedChangesWarning(dirty);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cleanAddr: SavedShippingAddress = {
        line1: addr.line1.trim(),
        line2: addr.line2?.trim() || null,
        city: addr.city.trim(),
        state: addr.state.trim().toUpperCase(),
        postalCode: addr.postalCode.trim(),
        country: "US",
      };
      const hasAnyField =
        cleanAddr.line1 ||
        cleanAddr.city ||
        cleanAddr.state ||
        cleanAddr.postalCode;
      const allRequiredFilled =
        cleanAddr.line1 &&
        cleanAddr.city &&
        cleanAddr.state &&
        cleanAddr.postalCode;
      if (hasAnyField && !allRequiredFilled) {
        setError(
          "Fill in street, city, state, and ZIP — or clear all four to remove the saved address.",
        );
        setSaving(false);
        return;
      }
      if (hasAnyField && allRequiredFilled && !overrideAddrWarning) {
        try {
          const probe = await fetch("/resupply-api/shop/validate-address", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              line1: cleanAddr.line1,
              line2: cleanAddr.line2,
              city: cleanAddr.city,
              state: cleanAddr.state,
              postalCode: cleanAddr.postalCode,
              country: cleanAddr.country,
            }),
          });
          const json = (await probe.json()) as {
            ok: boolean;
            reasons?: string[];
          };
          if (!json.ok && Array.isArray(json.reasons) && json.reasons.length > 0) {
            setAddrWarnings(json.reasons);
            setSaving(false);
            return;
          }
        } catch {
          // Validation probe is advisory only — never block a save.
        }
      }
      await updateShopMe({
        displayName: displayName.trim() || null,
        shippingAddress: hasAnyField ? cleanAddr : null,
      });
      setAddrWarnings([]);
      setOverrideAddrWarning(false);
      setSavedAt(Date.now());
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6"
      data-testid="account-profile-section"
    >
      <div className="flex items-center gap-2 mb-4">
        <UserIcon className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Profile & shipping</h2>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Full name">
          <input
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setOverrideAddrWarning(false);
            }}
            placeholder="Jane Doe"
            className="form-input"
            data-testid="account-name"
            autoComplete="name"
          />
        </Field>

        <div className="pt-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground mb-3 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" /> Default shipping address
          </p>
          <div className="space-y-3">
            <Field label="Street address">
              <input
                type="text"
                value={addr.line1}
                onChange={(e) => {
                  setAddr({ ...addr, line1: e.target.value });
                  setOverrideAddrWarning(false);
                }}
                placeholder="123 Main St"
                className="form-input"
                data-testid="account-addr-line1"
                autoComplete="address-line1"
              />
            </Field>
            <Field label="Apt, suite, etc. (optional)">
              <input
                type="text"
                value={addr.line2 ?? ""}
                onChange={(e) => {
                  setAddr({ ...addr, line2: e.target.value });
                  setOverrideAddrWarning(false);
                }}
                placeholder="Apt 4B"
                className="form-input"
                data-testid="account-addr-line2"
                autoComplete="address-line2"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="City">
                <input
                  type="text"
                  value={addr.city}
                  onChange={(e) => {
                    setAddr({ ...addr, city: e.target.value });
                    setOverrideAddrWarning(false);
                  }}
                  className="form-input"
                  data-testid="account-addr-city"
                  autoComplete="address-level2"
                />
              </Field>
              <Field label="State">
                <input
                  type="text"
                  value={addr.state}
                  onChange={(e) => {
                    setAddr({
                      ...addr,
                      state: e.target.value.toUpperCase().slice(0, 2),
                    });
                    setOverrideAddrWarning(false);
                  }}
                  maxLength={2}
                  placeholder="CA"
                  className="form-input"
                  data-testid="account-addr-state"
                  autoComplete="address-level1"
                />
              </Field>
              <Field label="ZIP">
                <input
                  type="text"
                  value={addr.postalCode}
                  onChange={(e) => {
                    setAddr({ ...addr, postalCode: e.target.value });
                    setOverrideAddrWarning(false);
                  }}
                  inputMode="numeric"
                  className="form-input"
                  data-testid="account-addr-zip"
                  autoComplete="postal-code"
                />
              </Field>
            </div>
          </div>
        </div>

        {error && (
          <p
            className="text-sm text-destructive"
            data-testid="account-save-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {addrWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-semibold mb-1">Address looks unusual:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {addrWarnings.map((r) => (
                <li key={r}>{r.replace(/_/g, " ")}</li>
              ))}
            </ul>
            <p className="mt-2">
              Fix it above, or{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setOverrideAddrWarning(true)}
              >
                save anyway
              </button>
              .
            </p>
          </div>
        )}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            disabled={saving}
            data-testid="account-save-btn"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span
              className="text-sm text-emerald-700 inline-flex items-center gap-1.5"
              data-testid="account-save-success"
            >
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          )}
          {/* Visible cue when there are unsaved changes. Pairs with
              the beforeunload prompt — the prompt only fires on tab
              close, this hint reassures the user (or warns them)
              while they're still on the page. Hidden during the
              brief post-save flash so we don't show "Unsaved" right
              next to "Saved". */}
          {dirty && !(savedAt && Date.now() - savedAt < 4000) && (
            <span
              className="text-xs text-amber-700"
              data-testid="account-profile-dirty"
            >
              Unsaved changes
            </span>
          )}
        </div>
      </form>

      <style>{`
        .form-input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border-radius: 0.5rem;
          border: 1px solid hsl(var(--border) / 0.6);
          background: white;
          font-size: 0.95rem;
          color: hsl(var(--foreground));
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: hsl(var(--penn-navy) / 0.6);
          box-shadow: 0 0 0 3px hsl(var(--penn-navy) / 0.12);
        }
      `}</style>
    </section>
  );
}

/**
 * Renders a labeled form field wrapper.
 *
 * @param label - Visible label text shown above the field content
 * @param children - Field input or other inline content to render beneath the label
 * @returns A JSX element containing the label and its associated children
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}
