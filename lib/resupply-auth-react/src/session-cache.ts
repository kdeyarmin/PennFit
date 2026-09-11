import {
  MutationCache,
  type Mutation,
  type MutationObserver,
  type QueryClient,
} from "@tanstack/react-query";

/** Tracks public observer events so account changes also detach per-call callbacks. */
export class SessionMutationCache extends MutationCache {
  private readonly observers = new Map<Mutation, Set<MutationObserver>>();

  constructor() {
    super();
    this.subscribe((event) => {
      if (event.type === "observerAdded") {
        const observers = this.observers.get(event.mutation) ?? new Set();
        observers.add(event.observer);
        this.observers.set(event.mutation, observers);
      } else if (event.type === "observerRemoved") {
        const observers = this.observers.get(event.mutation);
        observers?.delete(event.observer);
        if (!observers?.size) this.observers.delete(event.mutation);
      }
    });
  }

  resetObservers(mutation: Mutation): void {
    for (const observer of this.observers.get(mutation) ?? []) observer.reset();
  }
}

const generations = new WeakMap<QueryClient, number>();

/** Capture before an async write; its old response must not update a new session. */
export function captureSessionCacheGuard(client: QueryClient): () => boolean {
  const generation = generations.get(client) ?? 0;
  return () => (generations.get(client) ?? 0) === generation;
}

/**
 * Drop account data when the shared session cookie changes. Use SessionMutationCache
 * on the app's QueryClient to detach mutation observers as well. The optional context
 * preserves only the auth mutation completing this transition, including navigation.
 * Already-entered async callbacks and manual await continuations still need a guard.
 * Returns false if a newer transition superseded this cleanup while it was awaiting.
 */
export async function clearSessionCache(
  client: QueryClient,
  initiatingContext?: unknown,
): Promise<boolean> {
  generations.set(client, (generations.get(client) ?? 0) + 1);
  const isCurrent = captureSessionCacheGuard(client);
  const cache = client.getMutationCache();
  // Invalidate synchronously, before awaiting query cancellation. Clearing the
  // cache alone does not stop a pending mutation's callbacks or queued retries.
  for (const mutation of cache.getAll()) {
    if (
      initiatingContext !== undefined &&
      mutation.state.context === initiatingContext
    )
      continue;
    if (cache instanceof SessionMutationCache) cache.resetObservers(mutation);
    mutation.setOptions({
      ...mutation.options,
      mutationFn: async () => {
        throw new Error("Session changed before the action could be sent.");
      },
      onMutate: undefined,
      onSuccess: undefined,
      onError: undefined,
      onSettled: undefined,
    });
    cache.remove(mutation);
  }
  // Cancel first: a response belonging to the old account must not refill
  // its cache after the next account signs in on this workstation.
  await client.cancelQueries();
  if (!isCurrent()) return false;
  client.removeQueries({
    predicate: ({ queryKey }) =>
      !(queryKey[0] === "auth" && queryKey[1] === "me"),
  });
  // Keep mounted session observers subscribed, but remove their old identity
  // on both surfaces because admin and storefront share the same cookie.
  client.setQueriesData({ queryKey: ["auth", "me"] }, null);
  return true;
}
