// "Add to Apple Wallet" section on /account.
//
// Behavior
// --------
// On mount, HEAD /shop/me/wallet-pass.pkpass to probe whether the
// feature is configured server-side. The endpoint returns 503 with
// {error:"wallet_not_configured"} in environments without Apple
// Developer certs; in that case the whole section hides itself
// (additive surface — no point dangling a button that always
// 503's). When the server is configured, we render the canonical
// Apple "Add to Apple Wallet" badge styling + an explanatory
// caption.
//
// We don't auto-download — the patient taps the button which
// triggers a same-tab navigation to the .pkpass URL. iOS Safari +
// macOS Safari recognize the MIME and prompt Wallet. Other browsers
// download the file (and the user can open it on their phone if
// they want, or ignore it).

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";

const PROBE_URL = "/resupply-api/shop/me/wallet-pass.pkpass";

type Availability = "checking" | "available" | "unavailable";

export function WalletPassSection() {
  const [state, setState] = useState<Availability>("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // HEAD probes whether the route is wired and configured.
        // Express + the route's requireSignedIn middleware respond
        // to HEAD by running the same code path WITHOUT the body —
        // so we get a 503/200 without paying the .pkpass build cost.
        const res = await fetch(PROBE_URL, {
          method: "HEAD",
          credentials: "include",
        });
        if (cancelled) return;
        // 503 = not configured → hide. 401 = signed out → hide
        // (parent /account already gates on auth, but be defensive).
        // 200 = configured → show.
        setState(res.ok ? "available" : "unavailable");
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== "available") return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-3"
      data-testid="account-wallet-section"
    >
      <div className="flex items-center gap-2">
        <Wallet className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">PennPaps Wallet card</h2>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        Add a PennPaps member card to Apple Wallet so support and one-tap
        reorder are always a swipe away from your lock screen.
      </p>
      <a
        href={PROBE_URL}
        data-testid="wallet-pass-download"
        className="inline-block"
      >
        <Button
          type="button"
          className="rounded-full bg-black text-white hover:bg-black/85 px-5"
        >
          <Wallet className="h-4 w-4 mr-2" />
          Add to Apple Wallet
        </Button>
      </a>
      <p className="text-xs text-muted-foreground">
        Open this on your iPhone for one-tap install. On other devices the
        pass downloads as a file you can move to your phone.
      </p>
    </section>
  );
}
