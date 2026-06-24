// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { listPatients } = vi.hoisted(() => ({ listPatients: vi.fn() }));

// Keep every other export real (types, UI helpers) and override only the
// network call, so the component resolves exactly as it does in the app.
vi.mock("@workspace/api-client-react/admin", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/api-client-react/admin")>();
  return { ...actual, listPatients };
});

import { PatientSearchCombobox } from "./PatientSearchCombobox";
import type { PatientListItem } from "@workspace/api-client-react/admin";

const PATIENT: PatientListItem = {
  id: "pat-123",
  pacwareId: "PW42",
  firstName: "Ada",
  lastName: "Lovelace",
  status: "active",
  hasPhone: true,
  hasEmail: false,
  createdAt: "2026-01-01T00:00:00Z",
};

function renderCombobox(value: PatientListItem | null = null) {
  const onChange = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <PatientSearchCombobox
        value={value}
        onChange={onChange}
        aria-label="Patient"
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("PatientSearchCombobox", () => {
  beforeEach(() => {
    listPatients.mockReset();
    listPatients.mockResolvedValue({
      items: [PATIENT],
      total: 1,
      limit: 10,
      offset: 0,
    });
  });
  afterEach(cleanup);

  it("searches by typed text and yields the chosen patient object", async () => {
    const { onChange } = renderCombobox();

    fireEvent.change(screen.getByTestId("patient-search-input"), {
      target: { value: "lov" },
    });

    const option = await screen.findByTestId("patient-search-option-pat-123");
    expect(option.textContent).toContain("Ada Lovelace");
    expect(option.textContent).toContain("PacWare PW42");

    fireEvent.click(option);
    // The caller receives the whole patient — including the id — not a string.
    expect(onChange).toHaveBeenCalledWith(PATIENT);
    expect(listPatients).toHaveBeenCalledWith(
      expect.objectContaining({ search: "lov", limit: 10 }),
    );
  });

  it("does not query below the minimum character threshold", async () => {
    renderCombobox();

    fireEvent.change(screen.getByTestId("patient-search-input"), {
      target: { value: "l" },
    });
    // Wait past the debounce window to confirm nothing fired.
    await new Promise((r) => setTimeout(r, 350));
    expect(listPatients).not.toHaveBeenCalled();
  });

  it("renders the selected patient with a Change affordance", () => {
    const { onChange } = renderCombobox(PATIENT);

    const selected = screen.getByTestId("patient-search-selected");
    expect(selected.textContent).toContain("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: /change patient/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
