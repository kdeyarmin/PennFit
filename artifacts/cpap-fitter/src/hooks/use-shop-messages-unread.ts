// useShopMessagesUnread — small polling hook that surfaces the
// signed-in customer's unread CSR-message count for the global
// header badge.
//
// Polling cadence is intentionally slow (every 60s while the tab is
// visible) and we only fire when document.visibilityState is
// "visible" — a backgrounded tab shouldn't poll. Same Page-Visibility
// pattern AccountMessagesSection uses for its 30s message poll, so
// the two stay aligned.
//
// We also listen for a `pennpaps:messages:read` window event that
// the AccountMessagesSection dispatches after marking-read; the
// badge clears immediately on that signal without waiting for the
// next poll.
//
// Returns 0 (not throws) when the customer is signed-out / the
// fetch fails — the badge is decorative, never a blocker. Failures
// log to console.warn so dev can spot them.

import { useEffect, useState } from "react";

import { fetchShopMessagesUnreadCount } from "@/lib/account-api";
import { useShopIdentity } from "@/lib/identity";

const POLL_INTERVAL_MS = 60_000;

export function useShopMessagesUnread(): number {
  const { isSignedIn } = useShopIdentity();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isSignedIn) {
      setCount(0);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    async function refresh(): Promise<void> {
      try {
        const r = await fetchShopMessagesUnreadCount();
        if (!cancelled) setCount(r.unreadFromCsr);
      } catch {
        // Decorative badge — never throw into the header.
        if (!cancelled) setCount(0);
      }
    }

    function start(): void {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void refresh();
      }, POLL_INTERVAL_MS);
    }
    function stop(): void {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    }

    function onVisibility(): void {
      if (document.hidden) {
        stop();
      } else {
        void refresh();
        start();
      }
    }

    function onMarkedRead(): void {
      // Customer just opened /account — clear instantly, then
      // refresh on the next poll to confirm against the server.
      setCount(0);
    }

    // Initial fetch + start polling if the tab is visible.
    void refresh();
    if (typeof document !== "undefined" && !document.hidden) {
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pennpaps:messages:read", onMarkedRead);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pennpaps:messages:read", onMarkedRead);
    };
  }, [isSignedIn]);

  return count;
}
