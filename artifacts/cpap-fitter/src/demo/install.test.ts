import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { installDemoFetchInterceptor } from "./install";
import { setDemoActive, __resetDemoStateForTests } from "./state";

interface FakeWindow {
  fetch: typeof fetch;
  localStorage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
  location: { search: string; origin: string };
}

const passthroughResponse = () =>
  new Response(JSON.stringify({ from: "network" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const originalFetch = vi.fn(async () => passthroughResponse());

beforeAll(() => {
  const store: Record<string, string> = {};
  const fake: FakeWindow = {
    fetch: originalFetch as unknown as typeof fetch,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
    location: { search: "", origin: "http://localhost" },
  };
  (globalThis as unknown as { window?: FakeWindow }).window = fake;
  // Binds `originalFetch` and replaces window.fetch with the wrapper.
  installDemoFetchInterceptor();
});

afterEach(() => {
  __resetDemoStateForTests();
  originalFetch.mockClear();
});

describe("demo fetch interceptor", () => {
  beforeEach(() => {
    __resetDemoStateForTests();
  });

  it("is transparent when demo is off", async () => {
    setDemoActive(false);
    const res = await window.fetch("/api/auth/me");
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect((await res.json()) as unknown).toEqual({ from: "network" });
  });

  it("intercepts same-origin API calls when demo is on", async () => {
    setDemoActive(true);
    const res = await window.fetch("/api/auth/me");
    expect(originalFetch).not.toHaveBeenCalled();
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("demo-customer-1");
  });

  it("passes non-API requests through even when demo is on", async () => {
    setDemoActive(true);
    await window.fetch("/assets/logo.svg");
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });
});
