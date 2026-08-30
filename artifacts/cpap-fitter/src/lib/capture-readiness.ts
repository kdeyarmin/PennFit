/**
 * How long a GRANTED camera may go without delivering a frame before the
 * capture pages stop waiting and offer a way out.
 *
 * getUserMedia resolving is not the same as a picture arriving: an OS
 * camera lock, another app holding the device, or a Safari tab restored
 * from the background all resolve the promise and then never fire
 * `loadeddata`. Nothing rejects, so without this the page waits forever
 * on a disabled shutter with the camera light on.
 *
 * 12 seconds: comfortably past a slow sensor warm-up on an old phone
 * (the acquisitions we see land inside ~2 s), short enough that a patient
 * has not yet decided the site is broken.
 */
export const CAMERA_FEED_TIMEOUT_MS = 12_000;

export interface CaptureBlockers {
  cameraReady: boolean;
  /** Whether the on-device vision runtime (model + WASM) is reachable. */
  runtimeReady: boolean;
}

export function getCaptureBlockers(
  hasPermission: boolean | null,
  videoReady: boolean,
  runtimeReady: boolean,
): CaptureBlockers {
  return {
    cameraReady: hasPermission === true && videoReady,
    runtimeReady,
  };
}

export function isCaptureReady(blockers: CaptureBlockers): boolean {
  return blockers.cameraReady && blockers.runtimeReady;
}
