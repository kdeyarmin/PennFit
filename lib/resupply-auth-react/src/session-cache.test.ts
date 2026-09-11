import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { captureSessionCacheGuard, clearSessionCache } from "./session-cache";

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
