// @vitest-environment jsdom
//
// Covers the "Go to page" jump input: it only appears past a handful of
// pages, and pressing Enter maps the typed page to the right offset
// (clamped to the valid range) via onChange.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { Pagination } from "./Pagination";

afterEach(() => cleanup());

describe("Pagination go-to-page jump", () => {
  it("is hidden for small page counts (<= 5 pages)", () => {
    render(<Pagination total={50} limit={10} offset={0} onChange={vi.fn()} />);
    expect(screen.queryByLabelText(/Go to page/)).toBeNull();
  });

  it("appears once there are more than 5 pages", () => {
    render(<Pagination total={200} limit={10} offset={0} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/Go to page/)).toBeTruthy();
  });

  it("Enter jumps to the requested page offset", () => {
    const onChange = vi.fn();
    render(
      <Pagination total={200} limit={10} offset={0} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/Go to page/);
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // page 7 with limit 10 → offset 60
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it("clamps an out-of-range page to the last page", () => {
    const onChange = vi.fn();
    render(
      <Pagination total={200} limit={10} offset={0} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/Go to page/);
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // 20 pages total → last page offset 190
    expect(onChange).toHaveBeenCalledWith(190);
  });

  it("does not call onChange when jumping to the current page", () => {
    const onChange = vi.fn();
    render(
      <Pagination total={200} limit={10} offset={0} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/Go to page/);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
