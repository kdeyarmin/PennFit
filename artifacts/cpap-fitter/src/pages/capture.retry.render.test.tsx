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
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/hooks/use-fitter-store", () => ({
  useFitterStore: () => ({ setCapturedImage: vi.fn() }),
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));
vi.mock("@/hooks/use-vision-runtime-health", () => ({
  useVisionRuntimeHealth: () => "ready",
}));

import { Capture } from "./capture";

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
