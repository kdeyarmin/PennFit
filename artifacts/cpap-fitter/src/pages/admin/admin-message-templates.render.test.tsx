// @vitest-environment jsdom
//
// Render regression test for AdminMessageTemplatesPage (/admin/templates).
//
// Investigating a "templates page - Something went wrong" report: this test
// renders the page with payloads shaped like the real
// /admin/message-templates response and asserts it never bubbles a render
// error to the top-level ErrorBoundary.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let MOCK_DATA: unknown = { templates: [] };

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: () => ({
      data: MOCK_DATA,
      isPending: false,
      isError: false,
      error: null,
    }),
  };
});

import { AdminMessageTemplatesPage } from "./admin-message-templates";

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AdminMessageTemplatesPage />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("AdminMessageTemplatesPage — render regression", () => {
  it("renders a realistic backend payload without crashing", () => {
    MOCK_DATA = {
      templates: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          templateKey: "rx_renewal.30_day",
          channel: "email",
          subject: "Time to renew",
          bodyHtml: "<p>Hi {{first_name}}</p>",
          bodyText: "Hi {{first_name}}",
          allowedVariables: ["first_name", "manage_url"],
          isActive: true,
          updatedAt: "2026-06-01T00:00:00.000Z",
          updatedBy: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          createdBy: null,
        },
        {
          id: "22222222-2222-2222-2222-222222222222",
          templateKey: "office_hours",
          channel: "sms",
          subject: null,
          bodyHtml: null,
          bodyText: "Our office hours are 9-5.",
          allowedVariables: [],
          isActive: true,
          updatedAt: "2026-06-01T00:00:00.000Z",
          updatedBy: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          createdBy: null,
        },
      ],
    };
    expect(() => renderPage()).not.toThrow();
    expect(screen.getByTestId("admin-message-templates-page")).toBeDefined();
  });

  // The crash behind the "templates page - Something went wrong" report:
  // the page read `item.allowedVariables.length` / `.map(...)` directly. The
  // API contract is `string[]`, but the underlying column is jsonb and the
  // backend only coerced null/undefined (`?? []`) — a stored jsonb string /
  // object, or a stale backend that null'd or omitted the field, sailed
  // through and threw a raw TypeError into the global ErrorBoundary. Each of
  // these malformed shapes must now render without crashing.
  const malformedShapes: Array<[string, unknown]> = [
    ["null", null],
    ["undefined (missing field)", undefined],
    ["a string", "first_name,manage_url"],
    ["an object", { first_name: true }],
    ["a number", 7],
  ];
  for (const [label, allowedVariables] of malformedShapes) {
    it(`does not crash when allowedVariables is ${label}`, () => {
      MOCK_DATA = {
        templates: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            templateKey: "weird.row",
            channel: "sms",
            subject: null,
            bodyHtml: null,
            bodyText: "Body",
            allowedVariables,
            isActive: true,
            updatedAt: "2026-06-01T00:00:00.000Z",
            updatedBy: null,
            createdAt: "2026-06-01T00:00:00.000Z",
            createdBy: null,
          },
        ],
      };
      expect(() => renderPage()).not.toThrow();
      expect(screen.getByTestId("admin-message-templates-page")).toBeDefined();
    });
  }
});
