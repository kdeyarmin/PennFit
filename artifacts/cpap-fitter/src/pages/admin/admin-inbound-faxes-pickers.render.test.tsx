// @vitest-environment jsdom
//
// Behavioural tests for the two filing-reference helpers introduced when
// the inbound-fax triage form swapped raw UUID inputs for search pickers:
//   * ExistingAttachmentChip — shows a pre-existing attachment id with a
//     Change affordance (re-triage path).
//   * PrescriptionPicker — patient-scoped prescription select sourced from
//     useGetPatient, with loading / error / empty / list states.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { useGetPatient } = vi.hoisted(() => ({ useGetPatient: vi.fn() }));

vi.mock("@workspace/api-client-react/admin", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/api-client-react/admin")>();
  return { ...actual, useGetPatient };
});

import {
  ExistingAttachmentChip,
  PrescriptionPicker,
} from "./admin-inbound-faxes";

afterEach(cleanup);

describe("ExistingAttachmentChip", () => {
  it("shows the attached id and clears it on Change", () => {
    const onClear = vi.fn();
    render(
      <ExistingAttachmentChip
        kind="patient"
        id="11111111-2222-3333-4444-555555555555"
        onClear={onClear}
      />,
    );
    expect(screen.getByText(/attached patient/i)).toBeTruthy();
    expect(
      screen.getByText("11111111-2222-3333-4444-555555555555"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("PrescriptionPicker", () => {
  beforeEach(() => useGetPatient.mockReset());

  function renderPicker(state: unknown, value = "") {
    const onChange = vi.fn();
    useGetPatient.mockReturnValue(state);
    render(
      <PrescriptionPicker
        patientId="pat_1"
        value={value}
        onChange={onChange}
      />,
    );
    return { onChange };
  }

  it("offers each prescription by a human label and yields its id", () => {
    const { onChange } = renderPicker({
      isPending: false,
      isError: false,
      data: {
        prescriptions: [
          {
            id: "rx_1",
            itemSku: "E0601",
            hcpcsCode: "A7030-KX",
            status: "active",
          },
          { id: "rx_2", itemSku: "A7034", hcpcsCode: null, status: "expired" },
        ],
      },
    });
    const select = screen.getByRole("combobox", { name: "Prescription" });
    // Empty "— None —" option + the two prescriptions.
    expect(select.querySelectorAll("option").length).toBe(3);
    // hcpcsCode is folded in only when present.
    expect(screen.getByText("E0601 · A7030-KX · active")).toBeTruthy();
    expect(screen.getByText("A7034 · expired")).toBeTruthy();

    fireEvent.change(select, { target: { value: "rx_2" } });
    expect(onChange).toHaveBeenCalledWith("rx_2");
  });

  it("explains when the patient has no prescriptions on file", () => {
    renderPicker({
      isPending: false,
      isError: false,
      data: { prescriptions: [] },
    });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/no prescriptions on file/i)).toBeTruthy();
  });

  it("shows a loading state while the patient is fetched", () => {
    renderPicker({ isPending: true, isError: false, data: undefined });
    expect(screen.getByText(/loading this patient/i)).toBeTruthy();
  });

  it("surfaces a load error without blocking the save", () => {
    renderPicker({ isPending: false, isError: true, data: undefined });
    expect(screen.getByText(/couldn.t load prescriptions/i)).toBeTruthy();
  });
});
