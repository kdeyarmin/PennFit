export interface PrepChecks {
  noGlasses: boolean;
  evenLight: boolean;
  facingCamera: boolean;
}

export interface CaptureBlockers {
  cameraReady: boolean;
  runtimeReady?: boolean;
  noGlasses: boolean;
  evenLight: boolean;
  facingCamera: boolean;
}

export function getCaptureBlockers(
  hasPermission: boolean | null,
  videoReady: boolean,
  checks: PrepChecks,
): CaptureBlockers {
  return {
    cameraReady: hasPermission === true && videoReady,
    noGlasses: checks.noGlasses,
    evenLight: checks.evenLight,
    facingCamera: checks.facingCamera,
  };
}

export function isCaptureReady(blockers: CaptureBlockers): boolean {
  return (
    blockers.cameraReady &&
    blockers.noGlasses &&
    blockers.evenLight &&
    blockers.facingCamera
  );
}
