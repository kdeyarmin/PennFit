// @vitest-environment jsdom
//
// AdminModal — the shared Radix-backed admin dialog. Verifies the
// accessibility wins the hand-rolled modals lacked (role=dialog +
// aria-modal, Escape-to-close) and that the portaled content carries
// `admin-root` so the admin theme tokens resolve.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { AdminModal } from "./AdminModal";

afterEach(() => cleanup());

describe("AdminModal", () => {
  it("renders an accessible modal dialog with the title and description", () => {
    render(
      <AdminModal
        title="Campaign detail"
        description="Audience + status"
        onClose={() => {}}
      >
        <p>body</p>
      </AdminModal>,
    );
    // Radix renders the content with role="dialog" (a focus-trapped,
    // scroll-locked modal); getByRole throws if it's absent.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Campaign detail")).toBeTruthy();
    expect(screen.getByText("Audience + status")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("re-scopes admin theme tokens by carrying `admin-root` on the portaled content", () => {
    render(
      <AdminModal title="X" onClose={() => {}}>
        <p>body</p>
      </AdminModal>,
    );
    expect(screen.getByRole("dialog").classList.contains("admin-root")).toBe(
      true,
    );
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <AdminModal title="X" onClose={onClose}>
        <p>body</p>
      </AdminModal>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the built-in close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <AdminModal title="X" onClose={onClose}>
        <p>body</p>
      </AdminModal>,
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
