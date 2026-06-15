// @vitest-environment jsdom
//
// Render test for the admin "Add provider" modal. Covers the two paths the
// flow promises: (1) NPPES lookup prefills the whole record, and (2) when the
// lookup isn't used, every field is editable and a fully hand-entered provider
// saves with source "csr_entry".

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: () => ({
    data: { providers: [], total: 0, limit: 25, offset: 0 },
    isPending: false,
    isError: false,
    error: null,
  }),
  useMutation: ({
    mutationFn,
    onSuccess,
    onError,
  }: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (r: unknown) => void;
    onError?: (e: unknown) => void;
  }) => ({
    mutate: () => {
      void mutationFn().then(
        (r) => onSuccess?.(r),
        (e) => onError?.(e),
      );
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/lib/admin/providers-api", () => ({
  listProviders: vi.fn(),
  lookupNppes: vi.fn(),
  createProvider: vi.fn(),
}));

import {
  lookupNppes,
  createProvider,
  type NppesProviderProjection,
} from "@/lib/admin/providers-api";
import { AdminProvidersPage } from "./admin-providers";

function openModal() {
  render(<AdminProvidersPage />);
  fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
}

beforeEach(() => {
  cleanup();
  vi.mocked(lookupNppes).mockReset();
  vi.mocked(createProvider).mockReset();
  vi.mocked(createProvider).mockResolvedValue({ id: "prov-1", created: true });
});

describe("AddProviderModal", () => {
  it("saves a fully hand-entered provider as csr_entry (no NPPES lookup)", async () => {
    openModal();

    fireEvent.change(screen.getByLabelText("NPI (10 digits)"), {
      target: { value: "1234567893" },
    });
    fireEvent.change(screen.getByLabelText("Legal name"), {
      target: { value: "Dr. Anna Singh, MD" },
    });
    fireEvent.change(screen.getByLabelText("Taxonomy code"), {
      target: { value: "207RS0012X" },
    });
    fireEvent.change(screen.getByLabelText("Practice name"), {
      target: { value: "Sleep Health Associates" },
    });
    fireEvent.change(screen.getByLabelText("Phone (E.164)"), {
      target: { value: "+12155551234" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "office@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Address line 1"), {
      target: { value: "100 Market St" },
    });
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Philadelphia" },
    });
    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "PA" },
    });
    fireEvent.change(screen.getByLabelText("ZIP / postal code"), {
      target: { value: "19103" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save provider/i }));

    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        npi: "1234567893",
        legalName: "Dr. Anna Singh, MD",
        taxonomyCode: "207RS0012X",
        practiceName: "Sleep Health Associates",
        phoneE164: "+12155551234",
        email: "office@example.com",
        source: "csr_entry",
        practiceAddress: expect.objectContaining({
          line1: "100 Market St",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19103",
        }),
      }),
    );
  });

  it("blocks save on a malformed phone and surfaces a format hint", async () => {
    openModal();
    fireEvent.change(screen.getByLabelText("NPI (10 digits)"), {
      target: { value: "1234567893" },
    });
    fireEvent.change(screen.getByLabelText("Legal name"), {
      target: { value: "Dr. Anna Singh" },
    });
    fireEvent.change(screen.getByLabelText("Phone (E.164)"), {
      target: { value: "215-555-1234" },
    });

    expect(screen.getByText(/Phone must be E\.164/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /save provider/i }),
    ).toHaveProperty("disabled", true);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("prefills the record from an NPPES lookup and saves it as nppes", async () => {
    const projection: NppesProviderProjection = {
      npi: "1234567893",
      legalName: "Dr. Beth Cohen, MD",
      taxonomyCode: "207RS0012X",
      phoneE164: "+12155559999",
      faxE164: null,
      practiceName: "Penn Sleep Center",
      practiceAddress: {
        line1: "200 Spruce St",
        city: "Philadelphia",
        state: "PA",
        postalCode: "19104",
        country: "US",
      },
    };
    vi.mocked(lookupNppes).mockResolvedValue({ provider: projection });

    openModal();
    fireEvent.change(screen.getByLabelText("NPI (10 digits)"), {
      target: { value: "1234567893" },
    });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Legal name")).toHaveProperty(
        "value",
        "Dr. Beth Cohen, MD",
      ),
    );
    expect(screen.getByLabelText("Practice name")).toHaveProperty(
      "value",
      "Penn Sleep Center",
    );
    expect(screen.getByLabelText("City")).toHaveProperty(
      "value",
      "Philadelphia",
    );

    fireEvent.click(screen.getByRole("button", { name: /save provider/i }));
    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ source: "nppes", npi: "1234567893" }),
    );
  });
});
