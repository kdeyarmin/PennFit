import type { QueryClient } from "@tanstack/react-query";

const generations = new WeakMap<QueryClient, number>();

/** Capture before an async write; its old response must not update a new session. */
export function captureSessionCacheGuard(client: QueryClient): () => boolean {
  const generation = generations.get(client) ?? 0;
  return () => (generations.get(client) ?? 0) === generation;
}

/** Drop account data when the shared session cookie changes. */
export async function clearSessionCache(client: QueryClient): Promise<void> {
  generations.set(client, (generations.get(client) ?? 0) + 1);
  const isCurrent = captureSessionCacheGuard(client);
  // Cancel first: a response belonging to the old account must not refill
  // its cache after the next account signs in on this workstation.
  await client.cancelQueries();
  if (!isCurrent()) return;
  client.removeQueries({
    predicate: ({ queryKey }) =>
      !(queryKey[0] === "auth" && queryKey[1] === "me"),
  });
  client.getMutationCache().clear();
  // Keep mounted session observers subscribed, but remove their old identity
  // on both surfaces because admin and storefront share the same cookie.
  client.setQueriesData({ queryKey: ["auth", "me"] }, null);
}
