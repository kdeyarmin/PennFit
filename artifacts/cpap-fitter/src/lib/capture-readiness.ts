export interface CaptureBlockers {
  cameraReady: boolean;
  runtimeReady?: boolean;
}

export function getCaptureBlockers(
  hasPermission: boolean | null,
  videoReady: boolean,
): CaptureBlockers {
  return {
    cameraReady: hasPermission === true && videoReady,
  };
}

export function isCaptureReady(blockers: CaptureBlockers): boolean {
  return blockers.cameraReady;
}
