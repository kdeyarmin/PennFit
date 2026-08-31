// @vitest-environment jsdom
//
// One narrow contract: after a CSR marks a fulfillment shipped, the
// episodes list and its count strip actually refresh.
//
// This is worth its own file because the failure is silent and looks like
// nothing happened. The list and the chips are served by generated hooks
// keyed on the REQUEST URL (`/resupply-api/episodes`), so invalidating a
// hand-written `["episodes"]` matches no query at all: the request
// succeeds, the row keeps offering "Mark shipped", and the operator marks
// it again. Asserting against a real QueryClient — rather than a spy on
// `invalidateQueries` — is the point, because a spy happily records a key
// that matches nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getListEpisodeCountsQueryKey,
  getListEpisodesQueryKey,
} from "@workspace/api-client-react/admin";

const { markFulfillmentShipped } = vi.hoisted(() => ({
  markFulfillmentShipped: vi.fn(),
}));

vi.mock("@/lib/admin/fulfillments-api", () => ({
  markFulfillmentShipped,
  cancelFulfillment: vi.fn(),
}));

// The page module pulls in the whole admin console graph; the button is
// the only part under test.
import { MarkShippedButton } from "./episodes";

/** The list as the dispatcher actually loads it: filtered and paginated,
 *  so the key carries params. A fix that only invalidated the bare,
 *  param-free key would pass a weaker test than this one. */
const LIST_KEY = getListEpisodesQueryKey({
  status: "confirmed",
  limit: 25,
  offset: 0,
} as never);
const COUNTS_KEY = getListEpisodeCountsQueryKey({ q: "jane" } as never);

function seededClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(LIST_KEY, { episodes: [], total: 0 });
  qc.setQueryData(COUNTS_KEY, { counts: {} });
  return qc;
}

function Harness({ qc }: { qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      <MarkShippedButton fulfillmentId="ful-1" />
    </QueryClientProvider>
  );
}

async function markShipped(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /mark shipped/i }));
  fireEvent.change(screen.getByLabelText(/ship date/i), {
    target: { value: "2026-08-20" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  await waitFor(() => expect(markFulfillmentShipped).toHaveBeenCalled());
}

describe("MarkShippedButton — refreshes what it changed", () => {
  beforeEach(() => {
    markFulfillmentShipped.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);

  it("invalidates the episodes list the dispatcher is looking at", async () => {
    const qc = seededClient();
    render(<Harness qc={qc} />);

    expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(false);

    await markShipped();

    await waitFor(() => {
      expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
    });
  });

  it("also invalidates the count strip, which is a different URL", async () => {
    // The chips are the primary entry point to this page. Their key is
    // `/resupply-api/episodes/counts` — a sibling of the list URL, not a
    // child of it, so a single prefix invalidation does NOT reach it and
    // the chips would keep showing the pre-shipment depth.
    const qc = seededClient();
    render(<Harness qc={qc} />);

    await markShipped();

    await waitFor(() => {
      expect(qc.getQueryState(COUNTS_KEY)?.isInvalidated).toBe(true);
    });
  });

  it("passes the operator's chosen ship date through, not today", async () => {
    // Guards the reason the control takes a date at all: a CSR catching
    // up records when it shipped, and that date becomes the date of
    // service on the claim.
    const qc = seededClient();
    render(<Harness qc={qc} />);

    await markShipped();

    expect(markFulfillmentShipped).toHaveBeenCalledWith("ful-1", {
      shippedAt: "2026-08-20",
    });
  });

  it("does not invalidate when the server refuses", async () => {
    // The ship-date clamp rejects a date far enough back to miss a filing
    // deadline. Nothing changed, so nothing should be refetched — and the
    // panel must stay open with the reason on screen.
    markFulfillmentShipped.mockRejectedValue(
      new Error("would date this patient's claim that far back"),
    );
    const qc = seededClient();
    render(<Harness qc={qc} />);

    await markShipped();

    await screen.findByRole("alert");
    expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(COUNTS_KEY)?.isInvalidated).toBe(false);
  });
});

describe("the key shape this depends on", () => {
  it("keys the list on its request URL, so a guessed key matches nothing", () => {
    // Pins the assumption the fix rests on. If codegen ever moves to
    // opaque keys, this fails here rather than as a stale list in
    // production.
    expect(getListEpisodesQueryKey()[0]).toBe("/resupply-api/episodes");
    expect(getListEpisodeCountsQueryKey()[0]).toBe(
      "/resupply-api/episodes/counts",
    );

    const qc = seededClient();
    // The key this used to invalidate.
    qc.invalidateQueries({ queryKey: ["episodes"] });
    expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(COUNTS_KEY)?.isInvalidated).toBe(false);
  });
});
