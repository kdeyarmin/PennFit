// Loading the on-device face landmarker, once, correctly.
//
// Three pages need this model — /measure (IMAGE mode, one shot per
// frame), the guided capture (VIDEO mode, live), and the live coach on
// the default capture page — and each had, or would have grown, its own
// copy of the same four-part dance: resolve the WASM fileset, try the
// GPU delegate, fall back to CPU, and bound the whole thing with a timer
// so a device that will never finish loading does not hold the patient
// on a spinner.
//
// The part worth centralising is the losing path. `createFromOptions`
// can resolve AFTER the timeout has already fired or the component has
// unmounted, and the landmarker it hands back holds native WASM memory:
// dropping the reference leaks it. Every caller has to close a late
// arrival, and that is exactly the kind of detail that gets copied
// correctly twice and wrongly the third time.
//
// PHI: this module loads a model. It never sees a frame, and the
// landmarks it later produces stay in the browser — see the repo's
// image-privacy invariant.

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

/**
 * How long to wait for the model before giving the page back to the
 * patient. Generous — this is a multi-megabyte download on a phone that
 * may be on cellular — but finite, because "still loading" with no
 * ceiling is indistinguishable from broken.
 */
export const MODEL_LOAD_TIMEOUT_MS = 20_000;

export interface LoadFaceLandmarkerOptions {
  /** IMAGE for a still, VIDEO for a live feed. */
  runningMode: "IMAGE" | "VIDEO";
  /** Overrides the default ceiling; the live coach uses a shorter one. */
  timeoutMs?: number;
  /**
   * Head pose as a 4x4 transformation matrix, alongside the landmarks.
   *
   * Off by default: it costs work on every detection, and only the
   * callers that correct for head angle need it.
   */
  outputFacialTransformationMatrixes?: boolean;
}

export class LandmarkerLoadTimeout extends Error {
  constructor() {
    super("The measurement model took too long to load.");
    this.name = "LandmarkerLoadTimeout";
  }
}

/**
 * Resolve a ready landmarker, or reject.
 *
 * Rejects with `LandmarkerLoadTimeout` past the ceiling, and with
 * whatever MediaPipe threw when both delegates fail. A landmarker that
 * arrives after the rejection is closed rather than leaked, so the
 * caller can treat rejection as final.
 */
export async function loadFaceLandmarker(
  opts: LoadFaceLandmarkerOptions,
): Promise<FaceLandmarker> {
  const base = import.meta.env.BASE_URL;
  let settled = false;

  return new Promise<FaceLandmarker>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LandmarkerLoadTimeout());
    }, opts.timeoutMs ?? MODEL_LOAD_TIMEOUT_MS);

    void (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          `${base}mediapipe/wasm`,
        );
        const options = (delegate: "GPU" | "CPU") => ({
          baseOptions: {
            modelAssetPath: `${base}mediapipe/models/face_landmarker.task`,
            delegate,
          },
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: Boolean(
            opts.outputFacialTransformationMatrixes,
          ),
          runningMode: opts.runningMode,
          numFaces: 1,
        });
        let landmarker: FaceLandmarker;
        try {
          // GPU first; a device without usable WebGL falls back rather
          // than failing, which is the difference between a slow scan
          // and no scan at all on older hardware.
          landmarker = await FaceLandmarker.createFromOptions(
            vision,
            options("GPU"),
          );
        } catch {
          landmarker = await FaceLandmarker.createFromOptions(
            vision,
            options("CPU"),
          );
        }
        if (settled) {
          // The timeout already fired. Nobody is holding this, and it
          // owns native memory — close it rather than leaking.
          landmarker.close?.();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(landmarker);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
}
