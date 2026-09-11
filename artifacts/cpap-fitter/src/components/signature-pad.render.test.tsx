// @vitest-environment jsdom
import React, { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";

const context = {
  scale: vi.fn(),
  drawImage: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,signature",
  );
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function draw() {
  const canvas = screen.getByRole("img", { name: "Signature pad" });
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 40 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
}

describe("SignaturePad", () => {
  it("preserves a drawn signature when the viewport resizes", () => {
    const ref = createRef<SignaturePadHandle>();
    const onChange = vi.fn();
    render(<SignaturePad ref={ref} onChange={onChange} />);
    draw();
    expect(ref.current?.isEmpty()).toBe(false);

    fireEvent(window, new Event("resize"));

    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(ref.current?.isEmpty()).toBe(false);
    expect(ref.current?.toDataURL()).toBe("data:image/png;base64,signature");
    expect(onChange.mock.calls.map(([empty]) => empty)).toEqual([true, false]);
  });

  it("does not erase the canvas when its change callback gets a new identity", () => {
    const ref = createRef<SignaturePadHandle>();
    const nextChange = vi.fn();
    const view = render(<SignaturePad ref={ref} onChange={() => {}} />);
    draw();
    const initialSetups = context.scale.mock.calls.length;

    view.rerender(<SignaturePad ref={ref} onChange={nextChange} />);

    expect(context.scale).toHaveBeenCalledTimes(initialSetups);
    expect(ref.current?.isEmpty()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(nextChange).toHaveBeenCalledWith(true);
    expect(ref.current?.toDataURL()).toBeNull();
  });

  it("requires a fresh drawing after switching from Draw to Type and back", () => {
    function SigningForm() {
      const [drawing, setDrawing] = useState(true);
      const [empty, setEmpty] = useState(true);
      return (
        <>
          <button onClick={() => setDrawing((value) => !value)}>
            Switch mode
          </button>
          {drawing && <SignaturePad onChange={setEmpty} />}
          <button disabled={drawing && empty}>Sign</button>
        </>
      );
    }
    render(<SigningForm />);
    draw();
    expect(
      (screen.getByRole("button", { name: "Sign" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Switch mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch mode" }));
    expect(
      (screen.getByRole("button", { name: "Sign" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Sign here")).toBeTruthy();
  });
});
