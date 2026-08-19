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
