// @vitest-environment jsdom
//
// The signed-out → sign-in → back-to-the-gated-route round trip.
//
// A console gate that bounces a signed-out visitor to sign-in leaves a
// SUCCESSFUL `null` in the session cache (fetchMe returns null on 401 rather
// than throwing). The gate then unmounts, so that cache entry goes INACTIVE.
// useSignIn's onSuccess only invalidates it — and React Query does not
// refetch an inactive query on invalidation, it just marks it stale.
//
// So when sign-in navigates back to the gated route, the gate remounts onto
// cached `data: null` with `isPending: false` and redirects to sign-in AGAIN,
// before the background refetch can land. That strands the operator on the
// sign-in form after a successful sign-in.
//
// These tests pin the failure and the fix.

import { useEffect, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAuthClient,
  createAuthHooks,
} from "@workspace/resupply-auth-react";

const SESSION_KEY = ["auth", "me", "admin"] as const;

/** A /me endpoint that 401s until `signedIn` flips. */
function makeFetch(state: { signedIn: boolean }) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/me")) {
      return state.signedIn
        ? new Response(JSON.stringify({ userId: "u1", email: "a@b.c" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 401 });
    }
    return new Response(null, { status: 204 });
  };
}

function setup(state: { signedIn: boolean }) {
  const hooks = createAuthHooks(
    createAuthClient({
      basePath: "/resupply-api/auth",
      fetch: makeFetch(state) as unknown as typeof globalThis.fetch,
    }),
    { sessionQueryKey: SESSION_KEY },
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { hooks, qc };
}

/** Mimics PlatformConsoleRoute / ConsoleRoute's three-way gate. */
function makeGate(hooks: ReturnType<typeof createAuthHooks>) {
  return function Gate() {
    const { data, isPending } = hooks.useSession();
    if (isPending) return <div>SPINNER</div>;
    if (!data) return <div>REDIRECT</div>;
    return <div>CONSOLE</div>;
  };
}

afterEach(() => cleanup());

describe("session cache across the sign-in round trip", () => {
  it("caches a successful null when the gate runs while signed out", async () => {
    const state = { signedIn: false };
    const { hooks, qc } = setup(state);
    const Gate = makeGate(hooks);

    render(
      <QueryClientProvider client={qc}>
        <Gate />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("REDIRECT")).toBeDefined());
    // The 401 landed as data:null in a SUCCESS state — not an error.
    expect(qc.getQueryData(SESSION_KEY)).toBeNull();
    expect(qc.getQueryState(SESSION_KEY)?.status).toBe("success");
  });

  it("REGRESSION: invalidate alone leaves the remounted gate redirecting", async () => {
    const state = { signedIn: false };
    const { hooks, qc } = setup(state);
    const Gate = makeGate(hooks);

    // 1. Gate runs signed out and caches null.
    const first = render(
      <QueryClientProvider client={qc}>
        <Gate />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("REDIRECT")).toBeDefined());

    // 2. Gate unmounts (we navigated to sign-in) → query goes inactive.
    first.unmount();
    cleanup();

    // 3. Sign-in succeeds: cookie is set, and useSignIn invalidates /me.
    state.signedIn = true;
    void qc.invalidateQueries({ queryKey: ["auth", "me"] });

    // 4. Navigate back to the gated route. This is the first paint.
    const second = render(
      <QueryClientProvider client={qc}>
        <Gate />
      </QueryClientProvider>,
    );

    // The bug: stale-but-cached null renders as a non-pending "no session",
    // so the gate bounces the freshly signed-in operator back to sign-in.
    expect(second.queryByText("CONSOLE")).toBeNull();
    expect(second.queryByText("SPINNER")).toBeNull();
    expect(second.getByText("REDIRECT")).toBeDefined();
  });

  it("FIX: removing the cached session first makes the gate wait, then admit", async () => {
    const state = { signedIn: false };
    const { hooks, qc } = setup(state);
    const Gate = makeGate(hooks);

    const first = render(
      <QueryClientProvider client={qc}>
        <Gate />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("REDIRECT")).toBeDefined());
    first.unmount();
    cleanup();

    // Sign-in succeeds and DROPS the stale entry instead of only marking it
    // stale, so the gate remounts with no data at all.
    state.signedIn = true;
    qc.removeQueries({ queryKey: SESSION_KEY });

    const second = render(
      <QueryClientProvider client={qc}>
        <Gate />
      </QueryClientProvider>,
    );

    // First paint is a genuine loading state — no spurious redirect …
    expect(second.getByText("SPINNER")).toBeDefined();
    expect(second.queryByText("REDIRECT")).toBeNull();
    // … and the console renders once /me comes back.
    await waitFor(() => expect(second.getByText("CONSOLE")).toBeDefined());
  });
});

/** The page-side shape of the fix: drop the session, then navigate. */
function SignInLike({
  hooks,
  onNavigate,
}: {
  hooks: ReturnType<typeof createAuthHooks>;
  onNavigate: () => void;
}) {
  const qc = useQueryClient();
  const signIn = hooks.useSignIn();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    setDone(true);
    signIn.mutate(
      { email: "a@b.c", password: "pw" },
      {
        onSuccess: () => {
          qc.removeQueries({ queryKey: SESSION_KEY });
          onNavigate();
        },
      },
    );
  }, [done, onNavigate, qc, signIn]);
  return <div>SIGN_IN_FORM</div>;
}

describe("sign-in page hands the gate a clean session cache", () => {
  it("navigates only after the stale session entry is gone", async () => {
    const state = { signedIn: false };
    const { hooks, qc } = setup(state);

    // Gate ran signed out first.
    qc.setQueryData(SESSION_KEY, null);

    let navigated = false;
    // The sign-in call itself flips the server to signed-in.
    const flipOnSignIn = () => {
      state.signedIn = true;
    };

    render(
      <QueryClientProvider client={qc}>
        <SignInLike
          hooks={hooks}
          onNavigate={() => {
            navigated = true;
          }}
        />
      </QueryClientProvider>,
    );
    flipOnSignIn();

    await waitFor(() => expect(navigated).toBe(true));
    // The poisoned entry is gone, so whatever mounts next starts pending.
    expect(qc.getQueryState(SESSION_KEY)).toBeUndefined();
  });
});
