// Live coaching for the one-tap capture page.
//
// WHY THIS EXISTS. The default capture is one tap with no feedback, so
// everything a patient can get wrong — too far, too dark, half a face in
// frame — was only discovered AFTERWARDS, on the extraction error screen
// or as a quietly capped confidence score. The checks that would have
// caught it live already existed, pure and camera-free, and the guided
// multi-angle page had been running them at 180 ms for a while. They
// were simply never pointed at the page almost every patient actually
// uses (the guided flow is a per-tenant opt-in, seeded off).
//
// So this hook runs the guided page's own recipe — detect, measure the
// iris at full resolution, sample luma/sharpness on a downscaled copy,
// read the head angles, score the frame — and reports one coaching line
// plus a `steady` flag. It deliberately owns no UI and no capture: the
// page decides what to draw and when to fire the shutter.
//
// WHAT IT WILL NOT DO. It never gates the shutter. `getCaptureBlockers`
// is untouched, so a patient can always take the photo the coach is
// still complaining about — the coaching is advice, not a permission
// system, and a scan the model dislikes is still worth having (the
// server prices its confidence honestly either way). Every failure path
// — the model not loading, a device too slow to tick, a runtime throwing
// — degrades to `unavailable`, which renders exactly the page that
// shipped before this existed.
//
// PHI: pixels never leave the browser. The hook produces six scores in
// [0,1], three angles, and a string chosen from a fixed table.

import { useEffect, useRef, useState } from "react";

import {
  assessFrameQuality,
  centroidOf,
  coachMessage,
  estimatePoseFromLandmarks,
  type Point2D,
  type QualityResult,
} from "@/lib/scan-quality";
import { sampleFrame } from "@/lib/frame-sampling";
import { loadFaceLandmarker } from "@/lib/landmarker-loader";
import {
  shouldSpeakCoachLine,
  type SpokenCoachLine,
} from "@/lib/capture-feedback";

/** Matches the guided page's cadence — proven cheap on real phones. */
const TICK_MS = 180;

/**
 * Consecutive acceptable frames before the capture is considered steady.
 *
 * Three, the same as the guided flow's front pose: enough that a face
 * passing through a good position on its way somewhere else does not
 * trigger, few enough (~540 ms) that a patient holding still does not
 * wonder whether anything is happening.
 */
export const STEADY_FRAMES_REQUIRED = 3;

/**
 * A shorter ceiling than /measure's 20 s. Coaching is an enhancement on
 * a page that already works without it, so a slow model should stop
 * being waited on well before it would block anything.
 */
const COACH_MODEL_TIMEOUT_MS = 15_000;

/**
 * Give up after this many consecutive tick failures, or this long
 * without a single successful assessment. Either says the runtime is not
 * going to work on this device; continuing would burn battery to say
 * nothing.
 */
const MAX_CONSECUTIVE_TICK_ERRORS = 20;
const NO_ASSESSMENT_GRACE_MS = 8_000;

/** How long a coach line holds before another may replace it. */
const COACH_LINE_MIN_GAP_MS = 1_500;
const COACH_LINE_REPEAT_GAP_MS = 6_000;

export type LiveCoachStatus = "loading" | "active" | "unavailable";

export interface LiveFrameCoach {
  status: LiveCoachStatus;
  /** The current frame passes every check. */
  ready: boolean;
  /** It has passed them for STEADY_FRAMES_REQUIRED frames running. */
  steady: boolean;
  /** What to tell the patient, or null when there is nothing to fix. */
  message: string | null;
}

/** The slice of FaceLandmarker this hook uses — the seam tests inject. */
export interface LandmarkerLike {
  detectForVideo(
    video: HTMLVideoElement,
    timestampMs: number,
  ): { faceLandmarks?: Array<Array<Point2D>> };
  close?: () => void;
}

export interface UseLiveFrameCoachOptions {
  /** Coach only while the page wants it (feed up, not mid-capture). */
  enabled: boolean;
  /** Injectable for tests; defaults to the real VIDEO-mode loader. */
  loadLandmarker?: () => Promise<LandmarkerLike>;
}

export function useLiveFrameCoach(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  { enabled, loadLandmarker }: UseLiveFrameCoachOptions,
): LiveFrameCoach {
  const [status, setStatus] = useState<LiveCoachStatus>("loading");
  const [ready, setReady] = useState(false);
  const [steady, setSteady] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const landmarkerRef = useRef<LandmarkerLike | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const centroidsRef = useRef<Point2D[]>([]);
  const streakRef = useRef(0);
  const tickBusyRef = useRef(false);
  const errorStreakRef = useRef(0);
  const lastAssessmentAtRef = useRef<number>(0);
  // Throttle bookkeeping for the displayed line — reuses the guided
  // flow's own speech throttle so one patient-facing rule governs both.
  const lastLineRef = useRef<SpokenCoachLine | null>(null);

  // Held in a ref, not a dependency: loading the model is a ONE-SHOT
  // bootstrap, not a reactive input. Keyed off the prop's identity, a
  // caller that passes an inline function (or simply re-renders) would
  // tear down and reload the model — and, worse, resurrect a coach that
  // had already given up, since the reload sets `active` again.
  const loadLandmarkerRef = useRef(loadLandmarker);
  loadLandmarkerRef.current = loadLandmarker;

  // ── Load the model (VIDEO mode), once per mount ──
  useEffect(() => {
    let active = true;
    const injected = loadLandmarkerRef.current;
    const load =
      injected ??
      (() =>
        loadFaceLandmarker({
          runningMode: "VIDEO",
          timeoutMs: COACH_MODEL_TIMEOUT_MS,
        }) as unknown as Promise<LandmarkerLike>);
    void (async () => {
      try {
        const landmarker = await load();
        if (!active) {
          landmarker.close?.();
          return;
        }
        landmarkerRef.current = landmarker;
        lastAssessmentAtRef.current = Date.now();
        setStatus("active");
      } catch {
        // No coaching on this device. The page is unchanged by it.
        if (active) setStatus("unavailable");
      }
    })();
    return () => {
      active = false;
      try {
        landmarkerRef.current?.close?.();
      } catch {
        /* best-effort */
      }
      landmarkerRef.current = null;
    };
    // Mount-only: see loadLandmarkerRef above.
  }, []);

  // ── The tick ──
  useEffect(() => {
    if (status !== "active") return;

    const giveUp = () => {
      setStatus("unavailable");
      setReady(false);
      setSteady(false);
      setMessage(null);
    };

    const tick = () => {
      if (!enabled || tickBusyRef.current) return;
      // A backgrounded tab keeps its interval alive on some browsers;
      // detecting on a frozen feed says nothing and costs battery.
      if (typeof document !== "undefined" && document.hidden) return;
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || !video.videoWidth || !video.videoHeight) {
        if (Date.now() - lastAssessmentAtRef.current > NO_ASSESSMENT_GRACE_MS) {
          giveUp();
        }
        return;
      }
      tickBusyRef.current = true;
      try {
        const result = landmarker.detectForVideo(video, performance.now());
        const landmarks = (result.faceLandmarks?.[0] ?? null) as
          | Point2D[]
          | null;
        let quality: QualityResult | null = null;

        if (landmarks && landmarks[469] && landmarks[471]) {
          // Iris pixels at FULL capture resolution: the distance check's
          // px/mm window is calibrated against the frame actually saved,
          // not the downscaled sampling copy below.
          const w = video.videoWidth;
          const h = video.videoHeight;
          const distPx = (a: Point2D, b: Point2D) =>
            Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
          const irisLeft = distPx(landmarks[469]!, landmarks[471]!);
          const irisRight =
            landmarks[474] && landmarks[476]
              ? distPx(landmarks[474], landmarks[476])
              : 0;
          const irisWidthPx =
            irisLeft > 0 && irisRight > 0
              ? (irisLeft + irisRight) / 2
              : Math.max(irisLeft, irisRight);

          // Luma/sharpness on a downscaled copy — the checks are
          // statistical and sampleFrame normalises the face crop anyway.
          let sampleCanvas = sampleCanvasRef.current;
          if (!sampleCanvas) {
            sampleCanvas = document.createElement("canvas");
            sampleCanvasRef.current = sampleCanvas;
          }
          const scale = Math.min(1, 480 / w);
          sampleCanvas.width = Math.max(2, Math.round(w * scale));
          sampleCanvas.height = Math.max(2, Math.round(h * scale));
          const sctx = sampleCanvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (sctx) {
            sctx.drawImage(
              video,
              0,
              0,
              sampleCanvas.width,
              sampleCanvas.height,
            );
          }
          const sample = sctx
            ? sampleFrame(sampleCanvas, landmarks)
            : sampleFrame(video as never, landmarks);

          const angles = estimatePoseFromLandmarks(landmarks, {
            width: w,
            height: h,
          });
          quality = assessFrameQuality({
            pose: "front",
            landmarks,
            irisWidthPx,
            frameWidth: w,
            frameHeight: h,
            faceLuma: sample.faceLuma,
            faceLumaLeft: sample.faceLumaLeft,
            faceLumaRight: sample.faceLumaRight,
            sharpness: sample.sharpness,
            yawDeg: angles.yawDeg,
            pitchDeg: angles.pitchDeg,
            rollDeg: angles.rollDeg,
            previousCentroids: centroidsRef.current,
          });
          const centroid = centroidOf(landmarks);
          if (centroid) {
            centroidsRef.current = [...centroidsRef.current, centroid].slice(
              -3,
            );
          }
        }

        errorStreakRef.current = 0;
        lastAssessmentAtRef.current = Date.now();

        if (!quality) {
          // No face in frame at all. The framing line is the honest one:
          // every other check is unmeasurable until there is a face.
          streakRef.current = 0;
          setReady(false);
          setSteady(false);
          setThrottledMessage(
            "Fit your whole face in the frame — forehead to chin.",
          );
          return;
        }

        const acceptable = quality.acceptable;
        streakRef.current = acceptable ? streakRef.current + 1 : 0;
        setReady(acceptable);
        setSteady(streakRef.current >= STEADY_FRAMES_REQUIRED);
        setThrottledMessage(acceptable ? null : coachMessage(quality, "front"));
      } catch {
        errorStreakRef.current += 1;
        if (errorStreakRef.current >= MAX_CONSECUTIVE_TICK_ERRORS) giveUp();
      } finally {
        tickBusyRef.current = false;
      }
    };

    /**
     * Hold a line long enough to read.
     *
     * At 5.5 assessments a second two failing checks can trade places
     * every tick, and a message that strobes is worse than none. Reuses
     * the guided flow's own speech throttle so the visual and spoken
     * rules cannot drift apart.
     */
    function setThrottledMessage(next: string | null) {
      if (next === null) {
        lastLineRef.current = null;
        setMessage(null);
        return;
      }
      const now = Date.now();
      const last = lastLineRef.current;
      if (
        !shouldSpeakCoachLine(last, next, now, {
          minGapMs: COACH_LINE_MIN_GAP_MS,
          repeatGapMs: COACH_LINE_REPEAT_GAP_MS,
        })
      ) {
        return;
      }
      lastLineRef.current = { text: next, atMs: now };
      setMessage(next);
    }

    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [status, enabled, videoRef]);

  // Coaching a capture in flight would be noise; keep the last state.
  useEffect(() => {
    if (!enabled) {
      streakRef.current = 0;
      setSteady(false);
    }
  }, [enabled]);

  return { status, ready, steady, message };
}
