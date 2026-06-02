import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isDemoActive,
  setDemoActive,
  subscribeDemo,
  initDemoStateFromUrl,
  __resetDemoStateForTests,
} from "./state";

interface FakeLocation {
  search: string;
  pathname: string;
  hash: string;
  origin: string;
}

interface FakeWindow {
  localStorage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
  location: FakeLocation;
  history: {
    state: unknown;
    replaceState(state: unknown, title: string, url: string): void;
  };
}

let lastReplacedUrl: string | null = null;

function installWindow(search: string, store: Record<string, string> = {}) {
  lastReplacedUrl = null;
  const fake: FakeWindow = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
    location: {
      search,
      pathname: "/page",
      hash: "",
      origin: "http://localhost",
    },
    history: {
      state: null,
      replaceState: (_s, _t, url) => {
        lastReplacedUrl = url;
      },
    },
  };
  (globalThis as unknown as { window?: FakeWindow }).window = fake;
  return store;
}

describe("demo state", () => {
  beforeEach(() => {
    __resetDemoStateForTests();
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: FakeWindow }).window;
    __resetDemoStateForTests();
  });

  it("enables demo from ?demo=1 and scrubs the param", () => {
    const store = installWindow("?demo=1&keep=yes");
    initDemoStateFromUrl();
    expect(isDemoActive()).toBe(true);
    expect(store["pennfit:demo-mode:v1"]).toBe("1");
    // The demo param is removed; unrelated params are preserved.
    expect(lastReplacedUrl).toBe("/page?keep=yes");
  });

  it("disables demo from ?demo=0 and clears storage", () => {
    const store = installWindow("?demo=0", { "pennfit:demo-mode:v1": "1" });
    initDemoStateFromUrl();
    expect(isDemoActive()).toBe(false);
    expect("pennfit:demo-mode:v1" in store).toBe(false);
  });

  it("falls back to stored flag when no param is present", () => {
    installWindow("", { "pennfit:demo-mode:v1": "1" });
    initDemoStateFromUrl();
    expect(isDemoActive()).toBe(true);
  });

  it("notifies subscribers on setDemoActive and updates the flag", () => {
    installWindow("");
    initDemoStateFromUrl();
    const seen: boolean[] = [];
    const unsub = subscribeDemo((v) => seen.push(v));
    setDemoActive(true);
    setDemoActive(true); // no-op, already on
    setDemoActive(false);
    unsub();
    setDemoActive(true); // not observed after unsubscribe
    expect(seen).toEqual([true, false]);
    expect(isDemoActive()).toBe(true);
  });
});
