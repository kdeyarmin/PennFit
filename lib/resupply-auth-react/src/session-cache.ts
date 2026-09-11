import {
  MutationCache,
  hashKey,
  type Mutation,
  type MutationObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { AuthMe } from "./client";

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
const changeListeners = new WeakMap<QueryClient, Set<() => void>>();

export function onSessionCacheChange(
  client: QueryClient,
  listener: () => void,
) {
  const listeners = changeListeners.get(client) ?? new Set();
  listeners.add(listener);
  changeListeners.set(client, listeners);
  return () => {
    listeners.delete(listener);
  };
}

/** Confirm identity before returning a refreshed session to its mounted gates. */
export async function readSession(
  client: QueryClient,
  queryKey: QueryKey,
  fetchMe: () => Promise<AuthMe | null>,
  signal?: AbortSignal,
): Promise<AuthMe | null> {
  const isCurrent = captureSessionCacheGuard(client);
  const session = await fetchMe();
  // Other surfaces may have confirmed an identity while this request awaited.
  // Compare at completion, including when this particular /me key is new.
  const previous = client
    .getQueriesData<AuthMe | null>({ queryKey: ["auth", "me"] })
    .map(([, value]) => value)
    .filter((value): value is AuthMe => !!value);
  if (
    isCurrent() &&
    !signal?.aborted &&
    previous.some(
      (value) =>
        !session || value.id !== session.id || value.role !== session.role,
    )
  ) {
    // Do not cancel the /me read that discovered the change. Other session
    // queries and private requests are obsolete, including their callbacks.
    const cleared = await clearSessionCache(client, undefined, {
      preserveQueryKey: queryKey,
      // Observing a cookie is not a new auth operation. Its originating sign-in
      // may still be reading its response; let that operation finish/navigation
      // run and broadcast when it completes, without a feedback invalidation.
      broadcast: false,
      preserveAuthTransitions: true,
    });
    if (cleared && !signal?.aborted) {
      // Other mounted gates were reset too. Keep them checking the current
      // cookie instead of stranding them on an idle, cached signed-out result.
      void client.invalidateQueries({
        queryKey: ["auth", "me"],
        predicate: (query) => query.queryHash !== hashKey(queryKey),
      });
    }
  }
  return session;
}

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
  options: {
    broadcast?: boolean;
    preserveQueryKey?: QueryKey;
    preserveAuthTransitions?: boolean;
  } = {},
): Promise<boolean> {
  generations.set(client, (generations.get(client) ?? 0) + 1);
  const isCurrent = captureSessionCacheGuard(client);
  const cache = client.getMutationCache();
  // Invalidate synchronously, before awaiting query cancellation. Clearing the
  // cache alone does not stop a pending mutation's callbacks or queued retries.
  for (const mutation of cache.getAll()) {
    if (options.preserveAuthTransitions && mutation.meta?.sessionTransition)
      continue;
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
  if (options.broadcast !== false) {
    for (const notify of changeListeners.get(client) ?? []) {
      try {
        notify();
      } catch {
        /* A blocked browser API must not prevent cleanup. */
      }
    }
  }
  // Cancel first: a response belonging to the old account must not refill
  // its cache after the next account signs in on this workstation.
  const preservedHash = options.preserveQueryKey
    ? hashKey(options.preserveQueryKey)
    : undefined;
  await client.cancelQueries({
    predicate: (query) => query.queryHash !== preservedHash,
  });
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
