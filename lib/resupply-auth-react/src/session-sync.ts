import type { QueryClient } from "@tanstack/react-query";
import { clearSessionCache, onSessionCacheChange } from "./session-cache";

const CHANNEL = "caremetric:session-change:v1";

/** Broadcast invalidation only; identities, cookies and patient data never leave memory. */
export function connectSessionCacheAcrossTabs(
  client: QueryClient,
  target: Window | undefined = typeof window === "undefined"
    ? undefined
    : window,
): () => void {
  if (!target) return () => {};
  const browser = target as Window & typeof globalThis;
  let channel: BroadcastChannel | undefined;
  let disposed = false;
  const seen = new Set<string>();
  const refresh = () => {
    if (!disposed) void client.invalidateQueries({ queryKey: ["auth", "me"] });
  };
  const remember = (nonce: string) => {
    seen.add(nonce);
    if (seen.size > 64) seen.delete(seen.values().next().value!);
  };
  const receive = (nonce: unknown) => {
    if (
      disposed ||
      typeof nonce !== "string" ||
      !nonce ||
      nonce.length > 128 ||
      seen.has(nonce)
    )
      return;
    remember(nonce);
    void clearSessionCache(client, undefined, { broadcast: false }).then(
      (current) => {
        if (current) refresh();
      },
    );
  };
  const onMessage = (event: MessageEvent<unknown>) => receive(event.data);
  try {
    if (browser.BroadcastChannel) {
      channel = new browser.BroadcastChannel(CHANNEL);
      channel.addEventListener("message", onMessage);
    }
  } catch {
    /* Storage events and focus checks remain available. */
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === CHANNEL) receive(event.newValue);
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) refresh();
  };
  target.addEventListener("storage", onStorage);
  target.addEventListener("focus", refresh);
  target.addEventListener("pageshow", onPageShow);
  const unsubscribe = onSessionCacheChange(client, () => {
    const nonce =
      browser.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    remember(nonce);
    try {
      channel?.postMessage(nonce);
    } catch {
      /* Try storage below. */
    }
    try {
      target.localStorage.setItem(CHANNEL, nonce);
    } catch {
      /* Private/storage-disabled mode. */
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    target.removeEventListener("storage", onStorage);
    target.removeEventListener("focus", refresh);
    target.removeEventListener("pageshow", onPageShow);
  };
}
