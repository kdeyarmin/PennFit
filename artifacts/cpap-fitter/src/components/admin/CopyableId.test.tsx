// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { CopyableId } from "./CopyableId";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => cleanup());

describe("CopyableId", () => {
  it("renders the display label but copies the full value", async () => {
    const fullId = "11111111-2222-3333-4444-555555555555";
    render(<CopyableId value={fullId} label={fullId.slice(0, 8)} />);
    // The visible text is the truncated label…
    expect(screen.getByText("11111111")).toBeTruthy();
    // …but clicking copies the full value.
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(fullId));
  });

  it("defaults the button label to 'Copy <value>'", () => {
    render(<CopyableId value="AF20-S" />);
    expect(screen.getByRole("button", { name: "Copy AF20-S" })).toBeTruthy();
  });

  it("honors a custom title for the copy button", () => {
    render(<CopyableId value="abc" title="Copy customer ID" />);
    expect(
      screen.getByRole("button", { name: "Copy customer ID" }),
    ).toBeTruthy();
  });
});
