// @vitest-environment jsdom
//
// Regression coverage for dashboard → conversations deep links.
//
// The page seeds its initial filters from the URL query string so KPI
// tiles like "Awaiting reply" can land prefiltered. It originally
// parsed wouter's useLocation() string — but wouter v3's location is
// the PATHNAME only and never contains a "?", so every deep-link
// filter was silently dropped and operators landed on the unfiltered
// inbox while the URL claimed otherwise
// (docs/app-review-2026-06-10.md P0-5). This renders the real page
// with a real query string and asserts the list hook is called with
// the filters from the URL.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const listSpy = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/conversations", vi.fn()],
}));

vi.mock("@workspace/api-client-react/admin", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useListConversations: (params: unknown) => {
      listSpy(params);
      return {
        data: undefined,
        isPending: true,
        isError: false,
        error: null,
        isFetching: false,
        refetch: vi.fn(),
      };
    },
  };
});

import { ConversationsPage } from "./conversations";

describe("ConversationsPage — URL deep-link filters", () => {
  it("seeds status/channel/view filters from window.location.search", () => {
    window.history.replaceState(
      null,
      "",
      "/admin/conversations?status=awaiting_admin&channel=sms&view=escalated",
    );

    render(<ConversationsPage />);

    expect(listSpy).toHaveBeenCalled();
    const params = listSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.status).toBe("awaiting_admin");
    expect(params.channel).toBe("sms");
    expect(params.view).toBe("escalated");
  });
});
