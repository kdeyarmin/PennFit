// @vitest-environment jsdom
//
// Regression coverage for the capture page's camera-error retry path.
//
// The error view renders WITHOUT the <video> element, so when "Try
// again" succeeds, the element only mounts on the next render — after
// startCamera's own attach already saw a null videoRef. The original
// code attached srcObject only inside startCamera, which left the
// freshly mounted <video> with no stream: videoReady never flipped,
// the page wedged on "warming up" with the camera light on, and only
// a full refresh recovered (docs/app-review-2026-06-10.md P0-4). This
// test drives deny → Try again → grant through the real component and
// asserts the stream lands on the <video> and "ready" is reachable.

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";

vi.mock("wouter", () => ({
  useLocation: () => ["/capture", vi.fn()],
  // Spread the rest: the escape-hatch buttons render `asChild`, so Radix
  // merges their data-testid onto the Link itself. A mock that dropped
  // props made those hatches invisible to the tests that assert on them.
  Link: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => <a {...props}>{children}</a>,
}));
vi.mock("@/hooks/use-fitter-store", () => ({
  useFitterStore: () => ({
    setCapturedImage: vi.fn(),
    setCapturedFrames: vi.fn(),
    clearMeasurements: vi.fn(),
    multiframeCapture: false,
  }),
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));
vi.mock("@/hooks/use-vision-runtime-health", () => ({
  useVisionRuntimeHealth: () => "ready",
}));

import { Capture } from "./capture";
import { CAMERA_FEED_TIMEOUT_MS } from "@/lib/capture-readiness";

// jsdom's HTMLMediaElement doesn't reliably store srcObject — shim it
// as a plain data property so the component's assignment round-trips.
Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
  configurable: true,
  writable: true,
  value: null,
});

function makeStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

beforeEach(() => {
  cleanup();
});

describe("Capture — camera retry after a denied permission", () => {
  it("attaches the stream to the freshly mounted <video> and can reach 'ready'", async () => {
    const stream = makeStream();
    const denied = Object.assign(new Error("Permission denied"), {
      name: "NotAllowedError",
    });
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValueOnce(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const { container } = render(<Capture />);

    // First mount: permission denied → error view with Try again.
    const retry = await screen.findByTestId("capture-camera-retry");
    expect(screen.getByTestId("capture-camera-error")).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();

    // Retry succeeds → the success view mounts a fresh <video> that
    // must carry the just-acquired stream (the regression left it
    // with srcObject == null, wedged on "warming up" forever).
    await act(async () => {
      fireEvent.click(retry);
    });

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect((video as HTMLVideoElement).srcObject).toBe(stream);
    expect(screen.getByText("Getting your camera ready…")).toBeTruthy();

    // loadeddata flips videoReady — the "getting ready" wedge is gone
    // and (with the mocked vision runtime "ready") the line becomes
    // "Camera ready".
    await act(async () => {
      fireEvent(video as HTMLVideoElement, new Event("loadeddata"));
    });
    expect(screen.queryByText("Getting your camera ready…")).toBeNull();
    expect(screen.getByText("Camera ready")).toBeTruthy();
  });
});

describe("Capture — a camera that never delivers a frame", () => {
  it("offers a retry and the escape hatches instead of waiting forever", async () => {
    // getUserMedia RESOLVES but no loadeddata/loadedmetadata ever fires
    // (OS camera lock, another app holding the device). Nothing rejects,
    // so without the watchdog the page sits on a disabled shutter under
    // "Getting your camera ready…" with the camera light on.
    vi.useFakeTimers();
    try {
      const stream = makeStream();
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      });

      render(<Capture />);
      await act(async () => {});
      expect(screen.queryByTestId("capture-video-stalled")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(CAMERA_FEED_TIMEOUT_MS + 100);
      });

      expect(screen.getByTestId("capture-video-stalled")).toBeTruthy();
      expect(screen.getByTestId("capture-stalled-retry")).toBeTruthy();
      // Including the one exit that reaches a person.
      expect(
        screen.getByTestId("capture-stalled-fallback-callback"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never arms the watchdog while the permission prompt is still open", async () => {
    vi.useFakeTimers();
    try {
      // getUserMedia stays pending — that is the browser's own permission
      // dialog. Telling a patient reading it that the camera stalled
      // would be both wrong and alarming.
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: vi.fn().mockReturnValue(new Promise(() => {})) },
      });

      render(<Capture />);
      await act(async () => {
        vi.advanceTimersByTime(CAMERA_FEED_TIMEOUT_MS * 2);
      });

      expect(screen.queryByTestId("capture-video-stalled")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Capture — a tap that didn't take", () => {
  it("keeps the viewfinder and does not claim a permission problem", async () => {
    // The burst preflight fails when the feed has no dimensions yet. The
    // camera is alive and the next tap will probably work, so this must
    // not tear down the page — and above all must not be captioned
    // "Camera access required", a failure the patient never had.
    const stream = makeStream();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    const { container } = render(<Capture />);
    await act(async () => {});
    const video = container.querySelector("video") as HTMLVideoElement;
    await act(async () => {
      fireEvent(video, new Event("loadeddata"));
    });

    // videoWidth/Height stay 0 in jsdom, which is exactly the preflight
    // failure under test.
    await act(async () => {
      fireEvent.click(screen.getByTestId("button-capture"));
    });

    expect(screen.getByTestId("capture-transient-error")).toBeTruthy();
    expect(screen.queryByTestId("capture-camera-error")).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
    expect(screen.getByTestId("button-capture")).toBeTruthy();
  });
});
