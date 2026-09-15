import { afterEach, expect, it, vi } from "vitest";
import { adminJsonFetch } from "../admin-json-fetch";
import { fetchOwnerAnalytics } from "./owner-analytics-api";

vi.mock("../admin-json-fetch", () => ({
  adminJsonFetch: vi.fn().mockResolvedValue({}),
}));
afterEach(() => vi.clearAllMocks());
it("forwards cancellation and sends only the selected preset", async () => {
  const signal = new AbortController().signal;
  await fetchOwnerAnalytics({ days: 7 }, signal);
  expect(adminJsonFetch).toHaveBeenCalledWith("/admin/analytics/owner?days=7", {
    signal,
  });
});
it("sends inclusive custom dates without an implicit days parameter", async () => {
  await fetchOwnerAnalytics({ from: "2026-06-01", to: "2026-06-30" });
  expect(adminJsonFetch).toHaveBeenCalledWith(
    "/admin/analytics/owner?from=2026-06-01&to=2026-06-30",
    { signal: undefined },
  );
});
