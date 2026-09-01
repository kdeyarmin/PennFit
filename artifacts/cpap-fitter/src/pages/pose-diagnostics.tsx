// /internal/pose-diagnostics — the device validation page.
//
// WHY THIS PAGE EXISTS
// --------------------
// `poseFromFacialTransformationMatrix` reads MediaPipe's matrix
// column-major and extracts Tait-Bryan angles in an assumed sign
// convention. The tasks-vision docs do not state the handedness, and a
// WASM build can change it. If PITCH is reversed on some device, the
// depth-aware nose-to-chin correction — which is deliberately asymmetric
// in the sign of pitch — runs backwards and roughly doubles the error it
// exists to remove.
//
// `resolveFramePose` already refuses a matrix that disagrees with the
// geometric estimate, so a reversed convention degrades to the geometric
// fallback rather than corrupting a measurement. What it cannot do is
// TELL ANYONE, because a rejected matrix looks exactly like a runtime
// that never emitted one. This page is how a person finds out, on a real
// device, in a browser, in about ninety seconds.
//
// NOT FOR PATIENTS
// ----------------
// It is not linked from anywhere in the patient flow and is gated to
// non-production builds. It is a validation instrument, not a product
// surface.
//
// IMAGES
// ------
// The camera preview is live and is never captured. No frame is written
// to a canvas that is read back, no image reaches state, and the export
// contains angles only — `pose-diagnostics.ts`, which computes the
// verdict, is never given an image at all. Nothing is transmitted: the
// export is a client-side download, and retaining it is the operator's
// deliberate act.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadFaceLandmarker } from "@/lib/landmarker-loader";
import {
  POSE_STEP_SPECS,
  buildPoseValidationCsv,
  buildPoseValidationReport,
  type DeviceDescriptor,
  type PoseDiagnosticFrame,
  type PoseValidationReport,
} from "@/lib/pose-diagnostics";
import {
  estimatePoseFromLandmarks,
  poseFromFacialTransformationMatrix,
  resolveFramePose,
  type Point2D,
} from "@/lib/scan-quality";

/** How long each guided step records for. */
const STEP_DURATION_MS = 4000;
const SAMPLE_INTERVAL_MS = 120;
const MODEL_LOAD_TIMEOUT_MS = 20_000;

/**
 * Coarse, non-identifying device description.
 *
 * Deliberately NOT the raw user-agent string: that is fingerprintable,
 * and the platform/browser family is all the device matrix needs.
 */
function describeDevice(): DeviceDescriptor {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform = /iPhone|iPad|iPod/.test(ua)
    ? `iOS ${/OS (\d+)[._]/.exec(ua)?.[1] ?? "?"}`
    : /Android/.test(ua)
      ? `Android ${/Android (\d+)/.exec(ua)?.[1] ?? "?"}`
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : "unknown";
  const browser = /CriOS|Chrome\//.test(ua)
    ? `Chrome ${/(?:CriOS|Chrome)\/(\d+)/.exec(ua)?.[1] ?? "?"}`
    : /Edg\//.test(ua)
      ? `Edge ${/Edg\/(\d+)/.exec(ua)?.[1] ?? "?"}`
      : /Firefox\//.test(ua)
        ? `Firefox ${/Firefox\/(\d+)/.exec(ua)?.[1] ?? "?"}`
        : /Safari\//.test(ua)
          ? `Safari ${/Version\/(\d+)/.exec(ua)?.[1] ?? "?"}`
          : "unknown";
  return { platform, browser };
}

/**
 * How much to trust a sign read off this frame, from landmark geometry
 * alone.
 *
 * Deliberately NOT the fitter's `assessFrameQuality`: that needs luma and
 * sharpness, which are computed by drawing the frame to a canvas and
 * reading the pixels back. Doing that here would put a facial image in a
 * buffer, and the claim that this page captures no image would stop being
 * structurally true — it would depend on nobody ever persisting that
 * buffer. So instead: is a face present, and does it fill enough of the
 * frame that the landmarks are not noise?
 *
 * @param landmarks - Normalised landmark positions.
 * @returns 0..1, where >= 0.5 is usable for a direction reading.
 */
function frameUsability(landmarks: readonly Point2D[]): number {
  if (landmarks.length < 400) return 0;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // Fully inside the frame, and occupying a reasonable share of it. A
  // face clipped at an edge has landmarks extrapolated off-screen, which
  // is exactly where a pose estimate goes wrong.
  const inside = minX > 0.02 && maxX < 0.98 && minY > 0.02 && maxY < 0.98;
  if (!inside) return 0.2;
  const span = Math.min(maxX - minX, maxY - minY);
  if (span < 0.15) return 0.3;
  return span > 0.25 ? 1 : 0.7;
}

type SessionState = "idle" | "loading" | "running" | "done" | "error";

export function PoseDiagnostics(): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const landmarkerRef = useRef<{
    detectForVideo: (v: HTMLVideoElement, ts: number) => unknown;
    close?: () => void;
  } | null>(null);
  const framesRef = useRef<PoseDiagnosticFrame[]>([]);
  const startedAtRef = useRef<number>(0);

  const [state, setState] = useState<SessionState>("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [liveAngles, setLiveAngles] = useState<{
    matrix: { yawDeg: number; pitchDeg: number; rollDeg: number } | null;
    geometric: { yawDeg: number; pitchDeg: number; rollDeg: number };
    poseSource: "matrix" | "geometric";
    quality: number;
  } | null>(null);
  const [report, setReport] = useState<PoseValidationReport | null>(null);
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const device = useMemo(describeDevice, []);
  const currentStep = POSE_STEP_SPECS[stepIndex];

  // ── Camera + model ──────────────────────────────────────────────────
  const start = useCallback(async () => {
    setState("loading");
    setError(null);
    framesRef.current = [];
    setReport(null);
    setStepIndex(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      landmarkerRef.current = (await loadFaceLandmarker({
        runningMode: "VIDEO",
        timeoutMs: MODEL_LOAD_TIMEOUT_MS,
        outputFacialTransformationMatrixes: true,
      })) as unknown as typeof landmarkerRef.current;
      startedAtRef.current = Date.now();
      setState("running");
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.name}: could not start the camera or the model`
          : "could not start",
      );
      setState("error");
    }
  }, []);

  const stop = useCallback(() => {
    const video = videoRef.current;
    const stream = video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
    landmarkerRef.current?.close?.();
    landmarkerRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  // ── Sampling loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (state !== "running") return;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      const step = POSE_STEP_SPECS[stepIndex];
      if (!video || !landmarker || !step || video.readyState < 2) return;

      try {
        const result = landmarker.detectForVideo(video, performance.now()) as {
          faceLandmarks?: Array<Array<{ x: number; y: number }>>;
          facialTransformationMatrixes?: unknown[];
        };
        const landmarks = (result.faceLandmarks?.[0] ?? []) as Point2D[];
        if (landmarks.length === 0) return;

        const w = video.videoWidth || 1;
        const h = video.videoHeight || 1;
        const rawMatrix = result.facialTransformationMatrixes?.[0] as
          | Parameters<typeof poseFromFacialTransformationMatrix>[0]
          | undefined;

        // Both estimates, unconditionally — the whole point is to see
        // what the matrix says even when `resolveFramePose` rejects it.
        const matrix = poseFromFacialTransformationMatrix(rawMatrix);
        const geometric = estimatePoseFromLandmarks(landmarks, {
          width: w,
          height: h,
        });
        const resolved = resolveFramePose(rawMatrix, landmarks, {
          width: w,
          height: h,
        });

        // A landmark-geometry usability proxy rather than the fitter's
        // full `assessFrameQuality`. That one needs luma and sharpness,
        // which are read back out of a canvas — and reading pixels back
        // is the one thing this page must never do, because the moment a
        // frame lands in an ImageData buffer the claim "no image is
        // captured" stops being structurally true. A sign is a coarse
        // reading; a coarse usability check is enough for it.
        const quality = frameUsability(landmarks);

        const frame: PoseDiagnosticFrame = {
          atMs: Date.now() - startedAtRef.current,
          step: step.step,
          matrix,
          geometric,
          poseSource: resolved.poseSource,
          qualityScore: quality,
        };
        framesRef.current.push(frame);
        setLiveAngles({
          matrix,
          geometric,
          poseSource: resolved.poseSource,
          quality,
        });
      } catch {
        // A single bad frame is not a failure. The report reads medians.
      }
    };

    const sampler = setInterval(tick, SAMPLE_INTERVAL_MS);
    const advance = setTimeout(() => {
      if (cancelled) return;
      if (stepIndex + 1 < POSE_STEP_SPECS.length) {
        setStepIndex((i) => i + 1);
      } else {
        setReport(
          buildPoseValidationReport({
            sessionId: `pose_${Date.now().toString(36)}`,
            startedAt: new Date(startedAtRef.current).toISOString(),
            device,
            frames: framesRef.current,
          }),
        );
        setState("done");
        stop();
      }
    }, STEP_DURATION_MS);

    return () => {
      cancelled = true;
      clearInterval(sampler);
      clearTimeout(advance);
    };
  }, [state, stepIndex, device, stop]);

  const download = useCallback(() => {
    if (!report) return;
    const blob = new Blob([buildPoseValidationCsv(report)], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pose-validation-${report.sessionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report]);

  return (
    <main className="mx-auto max-w-3xl p-6 font-mono text-sm">
      <h1 className="text-xl font-bold">
        Head-pose convention validation — internal
      </h1>
      <p className="mt-2 text-muted-foreground">
        Confirms that MediaPipe&rsquo;s facial transformation matrix means what
        the fitter assumes it means, on <strong>this</strong> device and
        browser. Not a patient surface. No image is captured, stored or
        transmitted — the verdict is computed from angles alone.
      </p>
      <p className="mt-2 text-muted-foreground">
        Device: {device.platform} · {device.browser}
      </p>

      {state === "idle" && (
        <div className="mt-6 space-y-4">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
            />
            <span>
              I understand this turns on the camera. The preview is live and is
              never recorded; only derived angles are kept, in this browser tab,
              until I download or leave the page.
            </span>
          </label>
          <button
            type="button"
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-40"
            disabled={!consented}
            onClick={() => void start()}
          >
            Start the sequence
          </button>
          <ol className="ml-4 list-decimal text-muted-foreground">
            {POSE_STEP_SPECS.map((s) => (
              <li key={s.step}>{s.instruction}</li>
            ))}
          </ol>
        </div>
      )}

      {state === "error" && (
        <p className="mt-6 text-red-600">
          {error} — the fitter itself is unaffected; it falls back to the
          geometric estimator whenever the matrix is unavailable.
        </p>
      )}

      <video
        ref={videoRef}
        playsInline
        muted
        className={state === "running" ? "mt-6 w-full rounded" : "hidden"}
      />

      {state === "running" && currentStep && (
        <div className="mt-4 space-y-2">
          <p className="text-lg font-bold">
            {stepIndex + 1}/{POSE_STEP_SPECS.length}: {currentStep.instruction}
          </p>
          {currentStep.axis && (
            <p className="text-muted-foreground">
              Expected {currentStep.axis} sign:{" "}
              {currentStep.expectedSign > 0 ? "positive" : "negative"}
            </p>
          )}
          {liveAngles && (
            <table className="w-full">
              <tbody>
                <tr>
                  <td>matrix</td>
                  <td>
                    {liveAngles.matrix
                      ? `pitch ${liveAngles.matrix.pitchDeg.toFixed(1)} · yaw ${liveAngles.matrix.yawDeg.toFixed(1)} · roll ${liveAngles.matrix.rollDeg.toFixed(1)}`
                      : "not emitted"}
                  </td>
                </tr>
                <tr>
                  <td>geometric</td>
                  <td>
                    pitch {liveAngles.geometric.pitchDeg.toFixed(1)} · yaw{" "}
                    {liveAngles.geometric.yawDeg.toFixed(1)} · roll{" "}
                    {liveAngles.geometric.rollDeg.toFixed(1)}
                  </td>
                </tr>
                <tr>
                  <td>resolveFramePose used</td>
                  <td>{liveAngles.poseSource}</td>
                </tr>
                <tr>
                  <td>frame quality</td>
                  <td>{liveAngles.quality.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      {state === "done" && report && (
        <div className="mt-6 space-y-4">
          <h2 className="text-lg font-bold">Verdict</h2>
          <table className="w-full">
            <tbody>
              {(["pitch", "yaw", "roll"] as const).map((axis) => (
                <tr key={axis}>
                  <td>{axis}</td>
                  <td
                    className={
                      report.verdicts[axis] === "agreed"
                        ? "text-green-700"
                        : report.verdicts[axis] === "reversed" ||
                            report.verdicts[axis] === "inconsistent"
                          ? "text-red-600 font-bold"
                          : "text-amber-700"
                    }
                  >
                    {report.verdicts[axis]}
                  </td>
                </tr>
              ))}
              <tr>
                <td>matrix accepted on</td>
                <td>
                  {Math.round(report.matrixAcceptanceRate * 100)}% of frames
                </td>
              </tr>
            </tbody>
          </table>

          <ul className="ml-4 list-disc space-y-1">
            {report.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>

          <table className="w-full">
            <thead>
              <tr>
                <th className="text-left">step</th>
                <th className="text-left">matrix</th>
                <th className="text-left">geometric</th>
                <th className="text-left">moved</th>
                <th className="text-left">sign</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((s) => (
                <tr key={s.step}>
                  <td>{s.step}</td>
                  <td>{s.medianMatrixDeg?.toFixed(1) ?? "—"}</td>
                  <td>{s.medianGeometricDeg?.toFixed(1) ?? "—"}</td>
                  <td>{s.movedEnough ? "yes" : "no"}</td>
                  <td>
                    {s.signMatched === null
                      ? "—"
                      : s.signMatched
                        ? "ok"
                        : "REVERSED"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border px-4 py-2"
              onClick={download}
            >
              Download CSV (angles only, no image)
            </button>
            <button
              type="button"
              className="rounded border px-4 py-2"
              onClick={() => setState("idle")}
            >
              Run again
            </button>
          </div>

          <p className="text-muted-foreground">
            A green result covers <strong>this device and browser only</strong>.
            Record it against the matching row in
            docs/runbooks/fitter-device-validation.md; a passing run on one
            device is not evidence about any other.
          </p>
        </div>
      )}
    </main>
  );
}

export default PoseDiagnostics;
