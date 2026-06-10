// @vitest-environment jsdom
//
// Render tests for the PacWare-ID inline editor on the patient-detail
// header — the backfill path for patients created without an account
// number. Mocks useUpdatePatient; everything else (incl. ApiError) is
// the real module so instanceof checks behave like production.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";

const { updateState } = vi.hoisted(() => ({
  updateState: {
    current: {
      mutateAsync: vi.fn(async () => ({
        id: "p1",
        changed: ["pacware_id"],
        updatedAt: "2026-06-10T00:00:01.000Z",
      })),
      isPending: false,
    } as { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean },
  },
}));

vi.mock("@workspace/api-client-react/admin", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react/admin")>();
  return {
    ...actual,
    useUpdatePatient: () => updateState.current,
  };
});

import {
  ApiError,
  type PatientDetail,
} from "@workspace/api-client-react/admin";

import { PacwareIdInlineEdit } from "./PacwareIdInlineEdit";

function makePatient(pacwareId: string | null): PatientDetail {
  return {
    id: "p1",
    pacwareId,
    firstName: "Jordan",
    lastName: "Rivera",
    status: "active",
    hasPhone: true,
    hasEmail: true,
    insurancePayer: null,
    cadenceOverrideDays: null,
    channelPreference: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  } as unknown as PatientDetail;
}

beforeEach(() => {
  cleanup();
  updateState.current.mutateAsync = vi.fn(async () => ({
    id: "p1",
    changed: ["pacware_id"],
    updatedAt: "2026-06-10T00:00:01.000Z",
  }));
  updateState.current.isPending = false;
});

describe("PacwareIdInlineEdit", () => {
  it("shows 'No PacWare ID' + Add for a patient without an id, and saves a new id", async () => {
    const onSaved = vi.fn();
    render(
      <PacwareIdInlineEdit patient={makePatient(null)} onSaved={onSaved} />,
    );

    expect(screen.getByText("No PacWare ID")).toBeTruthy();
    fireEvent.click(screen.getByText("Add"));

    const input = screen.getByLabelText("PacWare ID");
    fireEvent.change(input, { target: { value: "  PAC-9001  " } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(updateState.current.mutateAsync).toHaveBeenCalledWith({
      id: "p1",
      data: {
        pacwareId: "PAC-9001",
        expectedUpdatedAt: "2026-06-10T00:00:00.000Z",
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("shows the current id + Edit, and clears it by saving blank (null)", async () => {
    const onSaved = vi.fn();
    render(
      <PacwareIdInlineEdit patient={makePatient("PAC-1")} onSaved={onSaved} />,
    );

    expect(screen.getByText("PACware ID #PAC-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Edit"));

    const input = screen.getByLabelText("PacWare ID") as HTMLInputElement;
    expect(input.value).toBe("PAC-1");
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(updateState.current.mutateAsync).toHaveBeenCalledWith({
      id: "p1",
      data: {
        pacwareId: null,
        expectedUpdatedAt: "2026-06-10T00:00:00.000Z",
      },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("keeps editing and shows the server message on 409 duplicate_pacware_id", async () => {
    const onSaved = vi.fn();
    updateState.current.mutateAsync = vi.fn(async () => {
      throw new ApiError(
        new Response(null, { status: 409, statusText: "Conflict" }),
        {
          error: "duplicate_pacware_id",
          message: 'Pacware id "PAC-1" is already in use.',
        },
        { method: "PATCH", url: "/resupply-api/patients/p1" },
      );
    });

    render(
      <PacwareIdInlineEdit patient={makePatient(null)} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("PacWare ID"), {
      target: { value: "PAC-1" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(
      screen.getByText('Pacware id "PAC-1" is already in use.'),
    ).toBeTruthy();
    // Still editing — input is present, no refetch fired.
    expect(screen.getByLabelText("PacWare ID")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not PATCH when the value is unchanged", async () => {
    const onSaved = vi.fn();
    render(
      <PacwareIdInlineEdit patient={makePatient("PAC-1")} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByText("Edit"));
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(updateState.current.mutateAsync).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    // Back to display mode.
    expect(screen.getByText("PACware ID #PAC-1")).toBeTruthy();
  });
});
