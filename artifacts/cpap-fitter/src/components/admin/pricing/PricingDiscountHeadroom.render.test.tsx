// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  clearSessionCache,
  SessionMutationCache,
} from "@workspace/resupply-auth-react";
import { PricingDiscountHeadroom } from "./PricingDiscountHeadroom";
import * as api from "@/lib/admin/pricing-api";
vi.mock("@/lib/admin/pricing-api", async (original) => ({
  ...(await original<typeof import("@/lib/admin/pricing-api")>()),
  getPricingDiscountHeadroom: vi.fn(),
}));
const scenario = {
  lines: [{ id: "line", sku: "MASK", quantity: 1, unitAmountCents: 10000 }],
  revenue: { mode: "self_pay", discountCents: 250 },
  validUntil: "2099-01-01T00:00:00Z",
} as api.Scenario;
type Response = Awaited<ReturnType<typeof api.getPricingDiscountHeadroom>>;
const response = {
  scenario,
  discountHeadroom: {
    status: "search_limit",
    searchUpperBoundCents: 2000,
    remainingMerchandiseCents: 9750,
    wholeDomainSearched: false,
    target: {
      additionalDiscountCents: 731,
      evaluation: { contributionCents: 3000, selectedBasisMarginBps: 4500 },
    },
    floor: {
      additionalDiscountCents: 1889,
      evaluation: { contributionCents: 2100, selectedBasisMarginBps: 3000 },
    },
  },
} as Response;
function mount(value: api.Scenario = scenario) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <PricingDiscountHeadroom scenario={value} />
      </QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPricingDiscountHeadroom).mockResolvedValue(response);
});
afterEach(cleanup);
it("uses the requested bound and reports returned discounts without changing the scenario", async () => {
  mount();
  fireEvent.change(
    screen.getByLabelText("Search up to additional discount ($)"),
    { target: { value: "20.00" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Check discount room", hidden: true }),
  );
  await screen.findByText("$7.31");
  expect(screen.getByText("$18.89")).toBeTruthy();
  expect(screen.getByText(/Larger discounts were not checked/)).toBeTruthy();
  expect(api.getPricingDiscountHeadroom).toHaveBeenCalledWith(scenario, 2000);
  expect(scenario.revenue).toHaveProperty("discountCents", 250);
});
it("keeps unknown discount room distinct from a confirmed zero discount", async () => {
  vi.mocked(api.getPricingDiscountHeadroom).mockResolvedValue({
    ...response,
    discountHeadroom: {
      ...response.discountHeadroom,
      target: null,
      floor: {
        ...response.discountHeadroom.floor!,
        additionalDiscountCents: 0,
      },
    },
  });
  mount();
  fireEvent.change(
    screen.getByLabelText("Search up to additional discount ($)"),
    { target: { value: "20.00" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Check discount room", hidden: true }),
  );
  await screen.findByText("None found in checked range");
  expect(screen.getByText("$0.00")).toBeTruthy();
});
it("clears an in-flight result when the search limit changes", async () => {
  let finish!: (value: Response) => void;
  vi.mocked(api.getPricingDiscountHeadroom).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  const input = screen.getByLabelText("Search up to additional discount ($)");
  fireEvent.change(input, { target: { value: "20.00" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Check discount room", hidden: true }),
  );
  await waitFor(() =>
    expect(api.getPricingDiscountHeadroom).toHaveBeenCalled(),
  );
  fireEvent.change(input, { target: { value: "10.00" } });
  await act(async () => {
    finish(response);
  });
  expect(screen.queryByText("$7.31")).toBeNull();
});
it("does not expose discount controls for insurance collections", () => {
  mount({
    ...scenario,
    revenue: {
      mode: "insurance",
      expectedCollectibleCents: 10000,
      status: "estimated",
    },
  });
  expect(
    screen.queryByLabelText("Search up to additional discount ($)"),
  ).toBeNull();
});
it("rejects malformed or over-limit dollars before requesting a search", () => {
  mount();
  for (const value of ["", "10.001", "1000.01", "1e2"]) {
    fireEvent.change(
      screen.getByLabelText("Search up to additional discount ($)"),
      { target: { value } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check discount room", hidden: true }),
    );
    expect(screen.getByText(/Enter an additional discount limit/)).toBeTruthy();
  }
  expect(api.getPricingDiscountHeadroom).not.toHaveBeenCalled();
});
it("discards a late discount result after the session is cleared", async () => {
  let finish!: (value: Response) => void;
  vi.mocked(api.getPricingDiscountHeadroom).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { client } = mount();
  fireEvent.change(
    screen.getByLabelText("Search up to additional discount ($)"),
    { target: { value: "20.00" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Check discount room", hidden: true }),
  );
  await waitFor(() =>
    expect(api.getPricingDiscountHeadroom).toHaveBeenCalled(),
  );
  await act(async () => {
    await clearSessionCache(client);
    finish(response);
  });
  expect(screen.queryByText("$7.31")).toBeNull();
});
