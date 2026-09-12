import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthMe } from "./client";
import {
  captureSessionCacheGuard,
  clearSessionCache,
  readSession,
  SessionMutationCache,
} from "./session-cache";
import { connectSessionCacheAcrossTabs } from "./session-sync";

const key = ["auth", "me", "admin"] as const;
const account = (id: string, role: AuthMe["role"] = "admin"): AuthMe => ({
  id,
  role,
  email: `${id}@example.test`,
  displayName: id,
  emailVerified: true,
  mustChangePassword: false,
});
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(qc);
  return qc;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  vi.restoreAllMocks();
});

describe("session refresh identity boundaries", () => {
  it.each([null, account("b"), account("a", "agent")])(
    "purges old private data while allowing the confirming /me read to finish (%j)",
    async (next) => {
      const qc = client();
      qc.setQueryData(key, account("a"));
      qc.setQueryData(["auth", "me", "storefront"], account("a"));
      qc.setQueryData(["private"], "a's history");
      const old = captureSessionCacheGuard(qc);
      await qc.fetchQuery({
        queryKey: key,
        queryFn: () => readSession(qc, key, async () => next),
      });
      expect(qc.getQueryData(key)).toEqual(next);
      expect(qc.getQueryData(["private"])).toBeUndefined();
      expect(qc.getQueryData(["auth", "me", "storefront"])).toBeNull();
      expect(old()).toBe(false);
    },
  );

  it("preserves working data when the same identity refreshes or the endpoint is temporarily offline", async () => {
    const qc = client();
    qc.setQueryData(key, account("a"));
    qc.setQueryData(["private"], "a's history");
    const current = captureSessionCacheGuard(qc);
    await qc.fetchQuery({
      queryKey: key,
      queryFn: () => readSession(qc, key, async () => account("a")),
    });
    await expect(
      qc.fetchQuery({
        queryKey: key,
        queryFn: () =>
          readSession(qc, key, async () => {
            throw new Error("offline");
          }),
      }),
    ).rejects.toThrow("offline");
    expect(qc.getQueryData(["private"])).toBe("a's history");
    expect(current()).toBe(true);
  });

  it("a cancelled old /me response cannot clear a newer signed-in account", async () => {
    const qc = client();
    qc.setQueryData(key, account("a"));
    const response = deferred<AuthMe | null>();
    const pending = qc
      .fetchQuery({
        queryKey: key,
        queryFn: () => readSession(qc, key, () => response.promise),
      })
      .catch(() => undefined);
    await clearSessionCache(qc);
    qc.setQueryData(key, account("b"));
    qc.setQueryData(["private"], "b's history");
    response.resolve(null);
    await pending;
    expect(qc.getQueryData(key)).toEqual(account("b"));
    expect(qc.getQueryData(["private"])).toBe("b's history");
  });

  it("ignores identity side effects from an ordinary cancelled refetch", async () => {
    const qc = client();
    qc.setQueryData(key, account("a"));
    qc.setQueryData(["private"], "a's history");
    const response = deferred<AuthMe | null>();
    const finished = deferred<void>();
    const pending = qc
      .fetchQuery({
        queryKey: key,
        queryFn: async ({ signal }) => {
          const result = await readSession(
            qc,
            key,
            () => response.promise,
            signal,
          );
          finished.resolve();
          return result;
        },
      })
      .catch(() => undefined);
    await qc.cancelQueries({ queryKey: key });
    await qc.fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) =>
        readSession(qc, key, async () => account("a"), signal),
    });
    response.resolve(null);
    await finished.promise;
    await pending;
    expect(qc.getQueryData(key)).toEqual(account("a"));
    expect(qc.getQueryData(["private"])).toBe("a's history");
  });

  it("clears an old identity when a different auth surface mounts for the first time", async () => {
    const qc = client();
    qc.setQueryData(key, account("a"));
    qc.setQueryData(["private"], "a's history");
    const storefrontKey = ["auth", "me", "storefront"];
    await qc.fetchQuery({
      queryKey: storefrontKey,
      queryFn: ({ signal }) =>
        readSession(qc, storefrontKey, async () => account("b"), signal),
    });
    expect(qc.getQueryData(storefrontKey)).toEqual(account("b"));
    expect(qc.getQueryData(key)).toBeNull();
    expect(qc.getQueryData(["private"])).toBeUndefined();
  });

  it("compares identities that were first confirmed while another surface was loading", async () => {
    const qc = client();
    const response = deferred<AuthMe | null>();
    const storefrontKey = ["auth", "me", "storefront"];
    const pending = qc.fetchQuery({
      queryKey: storefrontKey,
      queryFn: ({ signal }) =>
        readSession(qc, storefrontKey, () => response.promise, signal),
    });
    await qc.fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) =>
        readSession(qc, key, async () => account("a"), signal),
    });
    qc.setQueryData(["private"], "a's history");
    response.resolve(account("b"));
    await pending;
    expect(qc.getQueryData(storefrontKey)).toEqual(account("b"));
    expect(qc.getQueryData(key)).toBeNull();
    expect(qc.getQueryData(["private"])).toBeUndefined();
  });

  it("refreshes other mounted session surfaces after discovering a changed cookie", async () => {
    const qc = client();
    const storefrontKey = ["auth", "me", "storefront"];
    qc.setQueryData(key, account("a"));
    qc.setQueryData(storefrontKey, account("a"));
    const fetchMe = vi.fn(async () => account("b"));
    const observer = new QueryObserver(qc, {
      queryKey: key,
      staleTime: Infinity,
      queryFn: ({ signal }) => readSession(qc, key, fetchMe, signal),
    });
    const unsubscribe = observer.subscribe(() => {});
    expect(fetchMe).not.toHaveBeenCalled();
    await qc.fetchQuery({
      queryKey: storefrontKey,
      queryFn: ({ signal }) =>
        readSession(qc, storefrontKey, async () => account("b"), signal),
    });
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual(account("b")),
    );
    expect(fetchMe).toHaveBeenCalledOnce();
    expect(qc.getQueryData(storefrontKey)).toEqual(account("b"));
    unsubscribe();
  });
});

function browserPair({ channel = true, storage = true } = {}) {
  const peers = new Set<FakeChannel>();
  const sent: unknown[] = [];
  class FakeChannel extends EventTarget {
    constructor(_name: string) {
      super();
      peers.add(this);
    }
    postMessage(data: unknown) {
      sent.push(data);
      for (const peer of peers)
        if (peer !== this)
          peer.dispatchEvent(new MessageEvent("message", { data }));
    }
    close() {
      peers.delete(this);
    }
  }
  const windows = [new EventTarget(), new EventTarget()];
  const tabs = windows.map(
    (eventTarget) =>
      Object.assign(eventTarget, {
        BroadcastChannel: channel ? FakeChannel : undefined,
        crypto: { randomUUID: () => `event-${sent.length}-${Math.random()}` },
        localStorage: {
          setItem: (key: string, value: string) => {
            if (!storage) throw new Error("blocked");
            sent.push(value);
            for (const peer of windows)
              if (peer !== eventTarget)
                peer.dispatchEvent(
                  new StorageEvent("storage", { key, newValue: value }),
                );
          },
        },
      }) as unknown as Window,
  );
  return { tabs, sent, peers };
}

describe("cross-tab session invalidation", () => {
  it.each(["same tab", "another tab"])(
    "an observed cookie change in %s preserves the sign-in completing its response",
    async (location) => {
      const { tabs, sent } = browserPair();
      const first = client();
      const second = client();
      const stopFirst = connectSessionCacheAcrossTabs(first, tabs[0]);
      const stopSecond = connectSessionCacheAcrossTabs(second, tabs[1]);
      const readingClient = location === "same tab" ? first : second;
      readingClient.setQueryData(key, account("a"));
      readingClient.setQueryData(["private"], "a's history");
      const response = deferred<void>();
      const navigate = vi.fn();
      const mutationFn = vi.fn(async (_input: void, context: unknown) => {
        await response.promise;
        await clearSessionCache(first, context);
      });
      const observer = new MutationObserver(first, {
        meta: { sessionTransition: true },
        onMutate: (_input, context) => context,
        mutationFn,
      });
      const unsubscribe = observer.subscribe(() => {});
      const pending = observer.mutate(undefined, { onSuccess: navigate });
      await vi.waitFor(() => expect(mutationFn).toHaveBeenCalledOnce());
      await readingClient.fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) =>
          readSession(readingClient, key, async () => account("b"), signal),
      });
      expect(readingClient.getQueryData(["private"])).toBeUndefined();
      expect(sent).toHaveLength(0);
      response.resolve();
      await pending;
      expect(navigate).toHaveBeenCalledOnce();
      stopFirst();
      stopSecond();
      unsubscribe();
    },
  );

  it.each([
    { channel: true, storage: true },
    { channel: false, storage: true },
    { channel: true, storage: false },
  ])(
    "clears another tab and suppresses late callbacks without sharing account data (%j)",
    async (transport) => {
      const { tabs, sent } = browserPair(transport);
      const first = client();
      const second = client();
      second.setQueryData(key, account("private-user"));
      second.setQueryData(["private"], "private patient history");
      const callbacks = vi.fn();
      const response = deferred<string>();
      const mutationFn = vi.fn(() => response.promise);
      const observer = new MutationObserver(second, {
        mutationFn,
        onSuccess: callbacks,
        onSettled: callbacks,
      });
      const unsubscribe = observer.subscribe(() => {});
      const pending = observer.mutate(undefined, { onSuccess: callbacks });
      await vi.waitFor(() => expect(mutationFn).toHaveBeenCalledOnce());
      const stopFirst = connectSessionCacheAcrossTabs(first, tabs[0]);
      const stopSecond = connectSessionCacheAcrossTabs(second, tabs[1]);
      const old = captureSessionCacheGuard(second);
      await clearSessionCache(first);
      await vi.waitFor(() =>
        expect(second.getQueryData(["private"])).toBeUndefined(),
      );
      expect(second.getQueryData(key)).toBeNull();
      expect(old()).toBe(false);
      response.resolve("private patient history");
      await pending;
      expect(callbacks).not.toHaveBeenCalled();
      // Only an opaque event identifier travels; duplicate channel/storage delivery
      // must not echo the event or repeatedly clear the receiving tab.
      expect(sent.length).toBe(transport.channel && transport.storage ? 2 : 1);
      expect(JSON.stringify(sent)).not.toMatch(
        /private|example|history|cookie/,
      );
      stopFirst();
      stopSecond();
      unsubscribe();
    },
  );

  it("does not echo a refreshed identity back to the sending tab", async () => {
    const { tabs, sent } = browserPair();
    const first = client();
    const second = client();
    second.setQueryData(key, account("a"));
    const stopFirst = connectSessionCacheAcrossTabs(first, tabs[0]);
    const stopSecond = connectSessionCacheAcrossTabs(second, tabs[1]);
    await clearSessionCache(first);
    await qcSettled(second);
    const sentCount = sent.length;
    await second.fetchQuery({
      queryKey: key,
      queryFn: () => readSession(second, key, async () => account("b")),
    });
    expect(sent).toHaveLength(sentCount);
    stopFirst();
    stopSecond();
  });

  it("falls back to focus validation when browser sharing APIs are blocked and removes listeners on cleanup", async () => {
    const { tabs } = browserPair({ channel: false, storage: false });
    const qc = client();
    const refresh = vi.spyOn(qc, "invalidateQueries");
    const stop = connectSessionCacheAcrossTabs(qc, tabs[0]);
    await expect(clearSessionCache(qc)).resolves.toBe(true);
    tabs[0]!.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledWith({ queryKey: ["auth", "me"] });
    stop();
    refresh.mockClear();
    tabs[0]!.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();
  });
});

async function qcSettled(qc: QueryClient) {
  await vi.waitFor(() => expect(qc.getQueryData(key)).toBeNull());
}
