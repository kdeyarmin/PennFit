// @vitest-environment jsdom
//
// Production-readiness contract for the /learn "Watch & learn" video
// library: placeholder (empty-id) videos must NEVER render as "coming
// soon" cards, and when nothing is curated yet the whole section is
// omitted rather than shown empty. Real ids render normally.

import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Mutable mock of the curated list so each test can vary the data the
// component reads at render time (named import binding is live, so the
// getter is re-read on every access).
const { videosRef } = vi.hoisted(() => ({
  videosRef: {
    current: [] as Array<{
      id: string;
      youtubeId: string;
      title: string;
      blurb: string;
      durationSec: number;
      category: string;
    }>,
  },
}));

vi.mock("@/lib/learn-videos", () => ({
  get LEARN_VIDEOS() {
    return videosRef.current;
  },
}));

import { LearnVideoLibrary } from "./learn-video-library";

afterEach(() => {
  cleanup();
  videosRef.current = [];
});

describe("LearnVideoLibrary", () => {
  it("renders nothing when every video is a placeholder (empty id)", () => {
    videosRef.current = [
      {
        id: "clean-mask",
        youtubeId: "",
        title: "How to clean your CPAP mask",
        blurb: "x",
        durationSec: 75,
        category: "mask",
      },
    ];
    const { container } = render(<LearnVideoLibrary />);
    expect(screen.queryByTestId("learn-video-library")).toBeNull();
    expect(container.firstChild).toBeNull();
    // And no "coming soon" placeholder leaks to a customer.
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it("shows only videos with a real id and hides placeholders", () => {
    videosRef.current = [
      {
        id: "real",
        youtubeId: "abc123",
        title: "A real clip",
        blurb: "x",
        durationSec: 60,
        category: "mask",
      },
      {
        id: "placeholder",
        youtubeId: "",
        title: "Not ready yet",
        blurb: "x",
        durationSec: 60,
        category: "mask",
      },
    ];
    render(<LearnVideoLibrary />);
    expect(screen.getByTestId("learn-video-library")).toBeTruthy();
    expect(screen.getByTestId("learn-video-real")).toBeTruthy();
    expect(screen.queryByTestId("learn-video-placeholder")).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });
});
