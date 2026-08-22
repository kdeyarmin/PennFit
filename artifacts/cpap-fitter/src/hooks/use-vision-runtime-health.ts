import { useEffect, useState } from "react";

export type VisionRuntimeHealth = "checking" | "ready" | "degraded";

/**
 * Advisory probe that the MediaPipe model asset is reachable. The
 * capture page gates its "Take Photo" button on `"ready"`, so a single
 * failed HEAD must NOT latch `"degraded"` for the component's lifetime
 * — a flaky connection at page load would permanently disable the
 * button while the on-screen copy says "wait a moment and try again".
 * While the probe fails we keep re-probing on a capped backoff until
 * the asset answers. The probe is purely advisory (the real model load
 * happens on /measure), so retrying can only un-block, never break,
 * the flow.
 */
export function useVisionRuntimeHealth() {
  const [health, setHealth] = useState<VisionRuntimeHealth>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const base = import.meta.env.BASE_URL;
    const modelUrl = `${base}mediapipe/models/face_landmarker.task`;
    const scheduleRetry = () => {
      // 2s, 4s, 6s … capped at 10s between probes.
      const delayMs = Math.min(2_000 * (attempt + 1), 10_000);
      retryTimer = setTimeout(() => {
        if (active) setAttempt((n) => n + 1);
      }, delayMs);
    };
    // Time-boxed: a blackholed request (a proxy that accepts and never
    // responds) would otherwise leave health at "checking" forever — the
    // capture button stays disabled AND the "degraded" escape hatches
    // never render, the exact dead-end this probe exists to prevent.
    // AbortController rather than AbortSignal.timeout(): the static
    // helper is a 2022 addition, and on the older phones this fitter is
    // MOST likely to meet it throws synchronously — crashing the whole
    // capture page to set a timeout on an advisory probe.
    const probeController = new AbortController();
    const probeTimer = setTimeout(() => probeController.abort(), 8_000);
    fetch(modelUrl, { method: "HEAD", signal: probeController.signal })
      .finally(() => clearTimeout(probeTimer))
      .then((r) => {
        if (!active) return;
        if (r.ok) {
          setHealth("ready");
        } else {
          setHealth("degraded");
          scheduleRetry();
        }
      })
      .catch(() => {
        if (!active) return;
        setHealth("degraded");
        scheduleRetry();
      });
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [attempt]);

  return health;
}
