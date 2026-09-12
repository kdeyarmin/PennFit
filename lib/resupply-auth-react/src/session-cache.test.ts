import {
  MutationObserver,
  QueryClient,
  onlineManager,
} from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  captureSessionCacheGuard,
  clearSessionCache,
  SessionMutationCache,
} from "./session-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("session mutation lifecycle", () => {
  it("an older transition cannot purge data created by a newer transition", async () => {
    const client = new QueryClient({
      mutationCache: new SessionMutationCache(),
    });
    const cancellation = deferred<void>();
    vi.spyOn(client, "cancelQueries").mockReturnValueOnce(cancellation.promise);
    const first = clearSessionCache(client);
    expect(await clearSessionCache(client)).toBe(true);
    client.setQueryData(["private"], "new account");
    cancellation.resolve();
    expect(await first).toBe(false);
    expect(client.getQueryData(["private"])).toBe("new account");
    client.clear();
  });

  it.each(["success", "error"] as const)(
    "detaches old hook and per-call %s callbacks even after a rerender",
    async (outcome) => {
      const client = new QueryClient({
        mutationCache: new SessionMutationCache(),
      });
      const response = deferred<string>();
      const refresh = vi.fn(() => {
        client.setQueryData(["private"], "old account");
      });
      const options = {
        mutationFn: vi.fn(() => response.promise),
        onSuccess: refresh,
        onError: refresh,
        onSettled: refresh,
      };
      const observer = new MutationObserver(client, options);
      const unsubscribe = observer.subscribe(() => {});
      const pending = observer
        .mutate(undefined, {
          onSuccess: refresh,
          onError: refresh,
          onSettled: refresh,
        })
        .catch(() => undefined);
      await vi.waitFor(() => expect(options.mutationFn).toHaveBeenCalledOnce());
      await clearSessionCache(client);
      client.setQueryData(["private"], "new account");
      observer.setOptions({ ...options });
      if (outcome === "success") response.resolve("old account");
      else response.reject(new Error("old account failure"));
      await pending;
      expect(refresh).not.toHaveBeenCalled();
      expect(client.getQueryData(["private"])).toBe("new account");
      expect(observer.getCurrentResult().isIdle).toBe(true);
      unsubscribe();
      client.clear();
    },
  );

  it("blocks a queued request after asynchronous preparation finishes", async () => {
    const client = new QueryClient({
      mutationCache: new SessionMutationCache(),
    });
    const preparing = deferred<void>();
    const onMutate = vi.fn(() => preparing.promise);
    const send = vi.fn(async () => "old account");
    const mutation = client
      .getMutationCache()
      .build(client, { mutationFn: send, onMutate });
    const pending = mutation.execute(undefined);
    await vi.waitFor(() => expect(onMutate).toHaveBeenCalledOnce());
    await clearSessionCache(client);
    preparing.resolve();
    await expect(pending).rejects.toThrow("Session changed");
    expect(send).not.toHaveBeenCalled();
    client.clear();
  });

  it("blocks an old retry from sending with the next session", async () => {
    const client = new QueryClient({
      mutationCache: new SessionMutationCache(),
    });
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    const mutation = client
      .getMutationCache()
      .build(client, { mutationFn: send, retry: 1, retryDelay: 100 });
    const pending = mutation.execute(undefined).catch((error: Error) => error);
    await vi.waitFor(() => expect(mutation.state.failureCount).toBe(1));
    await clearSessionCache(client);
    expect(await pending).toMatchObject({
      message: expect.stringContaining("Session changed"),
    });
    expect(send).toHaveBeenCalledOnce();
    client.clear();
  });

  it("blocks a paused request even if its resume was already queued", async () => {
    const client = new QueryClient({
      mutationCache: new SessionMutationCache(),
    });
    const send = vi.fn(async () => "old account");
    onlineManager.setOnline(false);
    try {
      const mutation = client
        .getMutationCache()
        .build(client, { mutationFn: send });
      const pending = mutation
        .execute(undefined)
        .catch((error: Error) => error);
      await vi.waitFor(() => expect(mutation.state.isPaused).toBe(true));
      await clearSessionCache(client);
      onlineManager.setOnline(true);
      await mutation.continue().catch(() => undefined);
      expect(await pending).toMatchObject({
        message: expect.stringContaining("Session changed"),
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
      client.clear();
    }
  });

  it("keeps mutations started during query cancellation and clears completed old results", async () => {
    const client = new QueryClient({
      mutationCache: new SessionMutationCache(),
    });
    const observer = new MutationObserver(client, {
      mutationFn: async () => "old account",
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.mutate(undefined);
    const cancellation = deferred<void>();
    vi.spyOn(client, "cancelQueries").mockReturnValue(cancellation.promise);
    const clearing = clearSessionCache(client);
    const fresh = client
      .getMutationCache()
      .build(client, { mutationFn: async () => "new account" });
    cancellation.resolve();
    await clearing;
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(client.getMutationCache().getAll()).toContain(fresh);
    expect(await fresh.execute(undefined)).toBe("new account");
    unsubscribe();
    client.clear();
  });
});

describe("session cache guards", () => {
  it("ignores an old mutation response after another account signs in", async () => {
    const client = new QueryClient();
    let finish!: (data: string) => void;
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      onMutate: () => ({ isCurrent: captureSessionCacheGuard(client) }),
      onSuccess: (data, _variables, context) => {
        if (context?.isCurrent()) client.setQueryData(["account"], data);
      },
    });
    const pending = mutation.execute(undefined);
    // The mutation starts after its onMutate callback has resolved.
    await Promise.resolve();
    await Promise.resolve();
    await clearSessionCache(client);
    client.setQueryData(["account"], "new account");
    finish("old account");
    await pending;
    expect(client.getQueryData(["account"])).toBe("new account");
    client.clear();
  });

  it("keeps a fresh callback valid and isolates different query clients", async () => {
    const client = new QueryClient();
    const other = new QueryClient();
    const old = captureSessionCacheGuard(client);
    const unrelated = captureSessionCacheGuard(other);
    await clearSessionCache(client);
    expect(old()).toBe(false);
    expect(unrelated()).toBe(true);
    expect(captureSessionCacheGuard(client)()).toBe(true);
    client.clear();
    other.clear();
  });
});
