// Guided multi-angle capture — the `fitter.multiframe_capture` experience.
//
// Where the single-frame page (capture.tsx) is a viewfinder with a
// button, this one is a live coach: it runs the on-device FaceLandmarker
// in VIDEO mode over the preview stream, scores every look through the
// same pure quality checks the measurement step trusts (lighting,
// distance, head position, obstruction, movement, framing), talks the
// patient into a good frame, and auto-captures four frames (two
// straight-on for repeated measurement evidence, then two turns) —
// front, then a slight turn each way — the moment each pose holds steady.
//
// The extra angles are what buy cross-frame measurement agreement in
// `aggregateFrames` (see /measure): evidence a measurement is stable,
// which a single frame simply cannot produce.
//
// PHI: identical posture to the single-frame page. Frames live in React
// memory only (never sessionStorage, never the network); /measure
// discards them the moment the numbers are extracted. Everything this
// page computes from pixels is a scalar.
//
// FAIL OPEN, always: any setup failure — camera denied, WASM unreachable,
// landmarker refusing to start — calls `onFallback()`, and the parent
// re-renders the proven single-frame page, which owns the full recovery
// UX (permission how-tos, shop/insurance escape hatches). This page never
// dead-ends a patient on a capability the fitting can live without.

import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Camera,
  CheckCircle2,
  RefreshCw,
  ScanFace,
  Volume2,
  VolumeX,
} from "lucide-react";

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

import { useFitterStore, type CapturedFrame } from "@/hooks/use-fitter-store";
import { track } from "@/lib/track";
import { sampleFrame } from "@/lib/frame-sampling";
import {
  createCaptureFeedback,
  shouldSpeakCoachLine,
  type CaptureFeedback,
  type SpokenCoachLine,
} from "@/lib/capture-feedback";
import {
  assessFrameQuality,
  centroidOf,
  estimatePoseFromLandmarks,
  POSE_PROMPT,
  turnCoachNudge,
  type CapturePose,
  type Point2D,
  type QualityResult,
} from "@/lib/scan-quality";
import {
  advancePose,
  canSkipPose,
  currentPose,
  guidedProgress,
  guidedTick,
  initialGuidedState,
  posePrompt,
  skipPose,
  type GuidedCaptureState,
} from "@/lib/guided-capture";

/** Preview assessment cadence. ~5-6 checks/sec is plenty for a coach and
 *  keeps CPU cool on older phones. */
const TICK_MS = 180;

/** Give the model this long to load before falling back to single-frame
 *  — the same stall /measure's image decode guards against. */
const MODEL_LOAD_TIMEOUT_MS = 20_000;

/** Recent-centroid window for the movement check. */
const MOTION_WINDOW = 3;

/** With no successful assessment for this long after the loop was live,
 *  treat the pipeline as dead and fall back to the single-frame page. */
const DEAD_LOOP_FALLBACK_MS = 10_000;

/**
 * The turn direction the CURRENT turn step must produce, or null when
 * either direction is acceptable.
 *
 * Each turn step accepts either physical direction (a mirrored preview
 * makes "your left" genuinely ambiguous) — but the two steps together
 * exist to capture two DIFFERENT angles. Without this, a patient who
 * turned the "wrong" way on the first turn prompt could record the same
 * direction twice, halving the cross-frame evidence the second angle was
 * supposed to add. So once one turn direction is on film, the remaining
 * step requires the other.
 */
function requiredTurn(
  frames: readonly { pose: CapturePose }[],
  nominal: CapturePose,
): CapturePose | null {
  if (nominal === "front") return null;
  const turned = new Set(
    frames.filter((f) => f.pose !== "front").map((f) => f.pose),
  );
  if (turned.has("turn_left") && !turned.has("turn_right")) {
    return "turn_right";
  }
  if (turned.has("turn_right") && !turned.has("turn_left")) {
    return "turn_left";
  }
  return null;
}

export function GuidedCapture({ onFallback }: { onFallback: () => void }) {
  const [, setLocation] = useLocation();
  const { setCapturedImage, setCapturedFrames, clearMeasurements } =
    useFitterStore();

  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const machineRef = useRef<GuidedCaptureState>(initialGuidedState(0));
  const framesRef = useRef<CapturedFrame[]>([]);
  const centroidsRef = useRef<Point2D[]>([]);
  const tickBusyRef = useRef(false);
  const finalizedRef = useRef(false);
  const unmountedRef = useRef(false);
  // Last time the live loop completed a real assessment. A stream that
  // dies AFTER setup (device unplugged, OS revoking the camera) or a
  // landmarker that starts throwing every tick would otherwise leave the
  // page frozen on its last coach line forever — fail open to the
  // single-frame page instead, per the header.
  const lastLiveTickMsRef = useRef(0);

  // Eyes-free feedback: a chime + vibration the instant a frame is taken,
  // and spoken coaching while the patient's head (and eyes) are turned
  // away from the screen. Every channel degrades silently where the
  // browser doesn't support it.
  const feedbackRef = useRef<CaptureFeedback | null>(null);
  feedbackRef.current ??= createCaptureFeedback();
  const lastSpokenCoachRef = useRef<SpokenCoachLine | null>(null);
  const struggleSpokenForPoseRef = useRef(-1);
  const introSpokenRef = useRef(false);
  // The turn direction the live loop most recently MATCHED for the
  // current turn step (either physical side can satisfy an unlocked
  // step). The manual "take it anyway" capture records this, not the
  // nominal step label: a patient who turned opposite the nominal
  // direction and tapped the escape hatch would otherwise be filed under
  // the wrong side, and requiredTurn would then lock the remaining step
  // to the SAME physical direction — two frames of one side, zero of the
  // other. Cleared on every pose advance/skip.
  const lastMatchedTurnRef = useRef<CapturePose | null>(null);

  const [videoReady, setVideoReady] = useState(false);
  const [landmarkerReady, setLandmarkerReady] = useState(false);
  const [coach, setCoach] = useState<{
    message: string;
    struggling: boolean;
  }>({ message: "Getting your camera ready…", struggling: false });
  const [prompt, setPrompt] = useState<string>("Look straight at the camera.");
  const [capturedCount, setCapturedCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const [skippable, setSkippable] = useState(false);
  const [audioOn, setAudioOn] = useState(() => feedbackRef.current!.enabled);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // ── Camera ──
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          const ready = () => setVideoReady(true);
          video.onloadeddata = ready;
          // iOS Safari can defer `loadeddata` for camera streams — arm
          // the earlier `loadedmetadata` too and nudge playback. The tick
          // loop independently guards against a zero-size feed.
          video.onloadedmetadata = ready;
          void video.play?.()?.catch?.(() => {
            /* muted+playsInline already permit autoplay */
          });
        }
      } catch {
        // Permission denied, no device, hardware in use — the
        // single-frame page owns the recovery UX for all of them.
        if (active) onFallback();
      }
    })();
    return () => {
      active = false;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Landmarker (VIDEO mode, GPU → CPU fallback, bounded load) ──
  useEffect(() => {
    let active = true;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (active) onFallback();
    }, MODEL_LOAD_TIMEOUT_MS);
    (async () => {
      try {
        const base = import.meta.env.BASE_URL;
        const vision = await FilesetResolver.forVisionTasks(
          `${base}mediapipe/wasm`,
        );
        const options = (delegate: "GPU" | "CPU") => ({
          baseOptions: {
            modelAssetPath: `${base}mediapipe/models/face_landmarker.task`,
            delegate,
          },
          outputFaceBlendshapes: false,
          runningMode: "VIDEO" as const,
          numFaces: 1,
        });
        let landmarker: FaceLandmarker;
        try {
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
        if (!active || timedOut) {
          landmarker.close?.();
          return;
        }
        clearTimeout(timer);
        landmarkerRef.current = landmarker;
        setLandmarkerReady(true);
        track("guided_capture_ready");
      } catch {
        clearTimeout(timer);
        if (active && !timedOut) onFallback();
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      try {
        landmarkerRef.current?.close?.();
      } catch {
        /* best-effort */
      }
      landmarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalize = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const frames = framesRef.current;
    const front = frames[0];
    if (!front) {
      // Cannot happen (front is unskippable), but never navigate into a
      // guard that will bounce us straight back.
      onFallback();
      return;
    }
    // flushSync before navigating, same as the single-frame page: wouter
    // re-renders the route guards synchronously on pushState, and
    // GuardedMeasure must see the captured image already committed.
    flushSync(() => {
      setCapturedImage(front.dataUrl);
      setCapturedFrames(frames);
      // Invalidate the previous scan's persisted numbers — see the
      // single-frame page; a reload mid-analysis must not resurrect the
      // measurements this capture replaces.
      clearMeasurements();
    });
    stopCamera();
    track("capture_taken", { frames: frames.length, guided: true });
    setLocation("/measure");
  };

  const captureCurrentFrame = (pose: CapturePose): boolean => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      return false;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    // Same frozen-feed dedup as the one-tap burst: a stalled camera can
    // present one still across poses, and byte-identical captures are
    // ONE observation — recording them as two would fabricate the exact
    // cross-frame agreement this flow exists to earn. The pose still
    // advances (holding the patient on a frozen feed helps nobody); the
    // aggregate honestly caps confidence on the frames that remain.
    const previous = framesRef.current[framesRef.current.length - 1];
    if (!previous || previous.dataUrl !== dataUrl) {
      framesRef.current = [
        ...framesRef.current,
        { dataUrl, pose, source: "guided" },
      ];
    }
    machineRef.current = advancePose(machineRef.current, performance.now());
    centroidsRef.current = [];
    lastMatchedTurnRef.current = null;
    setCapturedCount(framesRef.current.length);
    setFlash(true);
    setTimeout(() => {
      if (!unmountedRef.current) setFlash(false);
    }, 350);
    const feedback = feedbackRef.current!;
    if (machineRef.current.done) {
      // The completion chime is deliberately distinct from the per-frame
      // one, and the spoken line calls the patient's eyes back to the
      // phone — the whole flow just spent a minute training them NOT to
      // look at it.
      feedback.allDone();
      feedback.speak(
        "That's every angle — all done. You can look at your phone now.",
        { interrupt: true },
      );
      finalize();
    } else {
      // Direction-aware prompt: if the first turn actually captured (say)
      // a right turn — whatever the nominal step asked — the remaining
      // step must produce the LEFT one, and the on-screen instruction has
      // to say so rather than parroting the nominal step's wording.
      const required = requiredTurn(
        framesRef.current,
        currentPose(machineRef.current),
      );
      const nextPrompt = required
        ? POSE_PROMPT[required]
        : posePrompt(machineRef.current);
      setPrompt(nextPrompt);
      setSkippable(canSkipPose(machineRef.current));
      // The second front capture repeats the same pose — "next angle"
      // would contradict the prompt right above it.
      const atFront = currentPose(machineRef.current) === "front";
      setCoach({
        message: atFront ? "Nice. One more, hold steady…" : "Nice. Next angle…",
        struggling: false,
      });
      // Chime says "it took"; the voice hands over the next instruction —
      // the patient hears the step change without looking back.
      feedback.frameCaptured();
      const spoken = atFront
        ? "Got it — one more straight on. Hold steady."
        : `Got it. ${nextPrompt}`;
      feedback.speak(spoken, { interrupt: true });
      if (feedback.enabled) {
        lastSpokenCoachRef.current = { text: spoken, atMs: performance.now() };
      }
    }
    return true;
  };

  // ── The live loop ──
  useEffect(() => {
    if (!videoReady || !landmarkerReady) return;
    // Start the pose clock NOW. The machine is constructed with epoch 0
    // while every tick passes performance.now() — which counts from page
    // navigation, so by the time camera + model were ready the 8s
    // struggle window read as long elapsed and the "take it anyway" /
    // "skip this angle" escape hatches (and their spoken pointer) fired
    // on the very first assessment, before the patient had tried at all.
    if (
      framesRef.current.length === 0 &&
      machineRef.current.captured.length === 0
    ) {
      machineRef.current = initialGuidedState(performance.now());
    }
    lastLiveTickMsRef.current = performance.now();
    setCoach({ message: "Look straight at the camera.", struggling: false });
    if (!introSpokenRef.current) {
      introSpokenRef.current = true;
      // Warm the audio path while sticky activation from the tap that
      // navigated here is still fresh — the first auto-capture fires from
      // a timer, where a suspended AudioContext cannot resume itself.
      feedbackRef.current!.prime();
      feedbackRef.current!.speak("Look straight at the camera.");
    }

    const deadLoopCheck = () => {
      if (
        !finalizedRef.current &&
        !unmountedRef.current &&
        performance.now() - lastLiveTickMsRef.current > DEAD_LOOP_FALLBACK_MS
      ) {
        track("guided_capture_dead_loop_fallback");
        onFallback();
      }
    };

    const tick = () => {
      if (tickBusyRef.current || finalizedRef.current) return;
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || !video.videoWidth || !video.videoHeight) {
        // The stream died after setup — zero-size feed, refs gone. Wait
        // out the grace window, then fail open.
        deadLoopCheck();
        return;
      }
      tickBusyRef.current = true;
      try {
        const result = landmarker.detectForVideo(video, performance.now());
        const landmarks = (result.faceLandmarks?.[0] ?? null) as
          | Point2D[]
          | null;

        let quality: QualityResult | null = null;
        let matchedPose: CapturePose = currentPose(machineRef.current);
        let liveYawDeg: number | null = null;
        if (landmarks && landmarks[469] && landmarks[471]) {
          // Iris pixels at FULL capture resolution — the distance check's
          // px/mm window is calibrated for the frame we actually save,
          // not the downscaled sampling copy below.
          const w = video.videoWidth;
          const h = video.videoHeight;
          const distPx = (a: Point2D, b: Point2D) =>
            Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
          const irisLeft = distPx(landmarks[469], landmarks[471]);
          const irisRight =
            landmarks[474] && landmarks[476]
              ? distPx(landmarks[474], landmarks[476])
              : 0;
          const irisWidthPx =
            irisLeft > 0 && irisRight > 0
              ? (irisLeft + irisRight) / 2
              : Math.max(irisLeft, irisRight);

          // Luma/sharpness sampling runs on a downscaled copy — the
          // checks are statistical and the face crop is normalised to a
          // fixed raster inside sampleFrame anyway.
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
          liveYawDeg = angles.yawDeg;
          const assessFor = (pose: CapturePose) =>
            assessFrameQuality({
              pose,
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

          const nominal = currentPose(machineRef.current);
          if (nominal === "front") {
            quality = assessFor("front");
          } else {
            // A turn step accepts EITHER direction — the angle is what
            // buys cross-frame evidence, and a mirrored preview makes
            // "your left" genuinely ambiguous — EXCEPT once one direction
            // is already on film: the remaining step then requires the
            // other, or both turn frames could record the same angle.
            const required = requiredTurn(framesRef.current, nominal);
            if (required) {
              quality = assessFor(required);
              matchedPose = required;
            } else {
              const asLeft = assessFor("turn_left");
              const asRight = assessFor("turn_right");
              const useLeft = asLeft.scores.pose >= asRight.scores.pose;
              quality = useLeft ? asLeft : asRight;
              matchedPose = useLeft ? "turn_left" : "turn_right";
            }
            // Remember the live direction for the manual escape hatch —
            // see lastMatchedTurnRef.
            lastMatchedTurnRef.current = matchedPose;
          }

          centroidsRef.current = [
            ...centroidsRef.current.slice(-(MOTION_WINDOW - 1)),
            centroidOf(landmarks),
          ];
        } else {
          centroidsRef.current = [];
        }

        const { state: next, action } = guidedTick(
          machineRef.current,
          quality,
          performance.now(),
        );
        machineRef.current = next;

        if (action.kind === "capture") {
          captureCurrentFrame(matchedPose);
        } else {
          // The machine's pose-failure coach line is worded for the
          // NOMINAL step. When the remaining turn is direction-locked
          // (see requiredTurn), re-issue the locked direction's prompt so
          // the coach never tells the patient to turn the way that's
          // already on film.
          const machinePose = currentPose(machineRef.current);
          const required = requiredTurn(framesRef.current, machinePose);
          let message =
            required &&
            (action.message === POSE_PROMPT.turn_left ||
              action.message === POSE_PROMPT.turn_right)
              ? POSE_PROMPT[required]
              : action.message;
          // At a turn step, "turn your head slightly" tells a patient who
          // IS turned nothing. When yaw itself is what's failing, replace
          // the prompt with the live directional nudge: further, back a
          // touch, or (direction-locked) the other way.
          if (
            machinePose !== "front" &&
            liveYawDeg !== null &&
            quality?.failing[0] === "pose"
          ) {
            const nudge = turnCoachNudge(liveYawDeg, matchedPose, !!required);
            if (nudge) message = nudge;
          }
          setCoach({
            message,
            struggling: action.struggling,
          });
          setSkippable(action.struggling && canSkipPose(machineRef.current));

          const feedback = feedbackRef.current!;
          // Speak coach lines only at the TURN steps — that's when the
          // patient's eyes are off the screen and the on-screen coach is
          // unreadable. (Front-pose coaching stays visual; narrating it
          // would be noise.) Throttled so the voice never chases the
          // ~180ms assessment cadence. The bookkeeping advances ONLY when
          // sound is on: a muted speak() is a no-op, and recording it as
          // spoken would leave a patient who unmutes mid-struggle waiting
          // out a throttle on words they never heard.
          if (machinePose !== "front" && feedback.enabled) {
            const nowMs = performance.now();
            if (
              shouldSpeakCoachLine(lastSpokenCoachRef.current, message, nowMs)
            ) {
              lastSpokenCoachRef.current = { text: message, atMs: nowMs };
              feedback.speak(message);
            }
          }
          // One spoken pointer at the escape hatches, per pose — the
          // buttons appear silently below an eyes-off-screen patient
          // otherwise. Same rule: only marked delivered when it could
          // actually be heard.
          if (
            action.struggling &&
            feedback.enabled &&
            struggleSpokenForPoseRef.current !== machineRef.current.poseIndex
          ) {
            struggleSpokenForPoseRef.current = machineRef.current.poseIndex;
            feedback.speak(
              canSkipPose(machineRef.current)
                ? "Having trouble? That's okay — look at your phone. You can take the photo as it is, or skip this angle."
                : "Having trouble? Look at your phone — you can take the photo yourself.",
            );
          }
        }
        lastLiveTickMsRef.current = performance.now();
      } catch {
        // A single failed assessment is not a failed capture — skip the
        // tick and let the next one try again. A landmarker that throws
        // EVERY tick, though, is a dead pipeline: fail open once the
        // grace window passes rather than coaching a frozen preview
        // forever.
        deadLoopCheck();
      } finally {
        tickBusyRef.current = false;
      }
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoReady, landmarkerReady]);

  const handleManualCapture = () => {
    if (finalizedRef.current) return;
    // File the frame under the direction the patient is ACTUALLY turned
    // (the live loop's last match), falling back to the nominal step only
    // when no assessment has seen a face at this step yet.
    const nominal = currentPose(machineRef.current);
    const pose =
      nominal !== "front" ? (lastMatchedTurnRef.current ?? nominal) : nominal;
    track("guided_capture_manual", { pose });
    captureCurrentFrame(pose);
  };

  const handleSkip = () => {
    if (finalizedRef.current) return;
    track("guided_capture_skip", { pose: currentPose(machineRef.current) });
    machineRef.current = skipPose(machineRef.current, performance.now());
    centroidsRef.current = [];
    lastMatchedTurnRef.current = null;
    if (machineRef.current.done) {
      // Skipping the last angle finishes the flow too — emit the same
      // completion signal the capture path emits, so "done" always
      // sounds the same however the final step ended. Worded to allow
      // skipped angles ("everything we need", not "every angle").
      const feedback = feedbackRef.current!;
      feedback.allDone();
      feedback.speak("That's everything we need — all done.", {
        interrupt: true,
      });
      finalize();
      return;
    }
    const nextPrompt = posePrompt(machineRef.current);
    setPrompt(nextPrompt);
    setSkippable(canSkipPose(machineRef.current));
    feedbackRef.current!.speak(nextPrompt, { interrupt: true });
    if (feedbackRef.current!.enabled) {
      lastSpokenCoachRef.current = {
        text: nextPrompt,
        atMs: performance.now(),
      };
    }
  };

  const toggleAudio = () => {
    const feedback = feedbackRef.current!;
    const next = !feedback.enabled;
    feedback.setEnabled(next);
    setAudioOn(next);
    if (next) {
      // Sound just came on: clear the speech bookkeeping so the current
      // guidance (and this pose's struggle pointer) speaks promptly
      // instead of waiting out a throttle recorded while muted.
      lastSpokenCoachRef.current = null;
      struggleSpokenForPoseRef.current = -1;
    }
  };

  const ready = videoReady && landmarkerReady;
  const progress = guidedProgress(machineRef.current);
  void capturedCount; // re-render trigger; progress reads the ref

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 md:py-12 flex flex-col items-center animate-shimmer-in">
      <div className="text-center mb-3 md:mb-6 max-w-xl">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-xs font-medium mb-4">
          <ScanFace className="w-3.5 h-3.5" />
          <span className="font-semibold tracking-wide">Guided scan</span>
        </div>
        <h1 className="text-display text-2xl md:text-4xl font-bold tracking-tight mb-2 text-gradient-brand">
          {prompt}
        </h1>
        {/* One live status line: the pose prompt above is the instruction;
            this is the coach reacting to what the camera actually sees. */}
        <p
          className="text-sm text-muted-foreground h-5"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="guided-coach"
        >
          {ready ? coach.message : "Getting your camera ready…"}
        </p>
      </div>

      <div className="relative w-full max-w-lg h-[min(50vh,28rem)] md:h-auto md:aspect-video bg-black rounded-2xl overflow-hidden mb-4 md:mb-6 border border-[hsl(var(--penn-navy)/0.18)] shadow-[0_20px_60px_hsl(var(--penn-navy)/0.20),0_0_0_1px_hsl(var(--penn-navy)/0.08)]">
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-white/50">
            <RefreshCw className="h-8 w-8 animate-spin" />
          </div>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover transform -scale-x-100"
        />
        <canvas ref={captureCanvasRef} className="hidden" />
        {/* Sound on/off. The chime + voice are the whole eyes-free story,
            so they default ON; the toggle is for patients somewhere quiet.
            Vibration is silent and stays on regardless. */}
        <button
          type="button"
          onClick={toggleAudio}
          aria-pressed={audioOn}
          aria-label={
            audioOn ? "Turn capture sounds off" : "Turn capture sounds on"
          }
          data-testid="guided-sound-toggle"
          className="absolute top-3 right-3 z-10 rounded-full bg-black/50 p-2.5 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
        >
          {audioOn ? (
            <Volume2 className="h-4 w-4" />
          ) : (
            <VolumeX className="h-4 w-4" />
          )}
        </button>
        <div
          className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center"
          aria-hidden="true"
        >
          <div className="h-4/5 max-h-[80%] aspect-[2/3] md:h-auto md:w-1/3 md:max-h-none border-[3px] border-primary/80 rounded-[100%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45),inset_0_0_30px_rgba(255,255,255,0.08)]" />
        </div>
        {flash && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90 animate-in fade-in duration-150">
            <Camera className="w-16 h-16 text-primary" />
          </div>
        )}
        {/* Angle progress dots */}
        <div
          className="absolute bottom-3 inset-x-0 flex items-center justify-center gap-2"
          data-testid="guided-progress"
          aria-label={`Captured ${progress.captured} of ${progress.total} angles`}
        >
          {Array.from({ length: progress.total }, (_, i) => (
            <span
              key={i}
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                i < progress.captured ? "bg-emerald-400" : "bg-white/40"
              }`}
            />
          ))}
        </div>
        <div
          className="sr-only"
          role="status"
          aria-live="assertive"
          aria-atomic="true"
        >
          {flash ? "Captured" : ""}
        </div>
      </div>

      {coach.struggling && !finalizedRef.current && (
        <div className="flex flex-wrap gap-3 justify-center mb-4">
          <Button
            onClick={handleManualCapture}
            className="rounded-full btn-primary-glow px-6 gap-2"
            data-testid="guided-capture-anyway"
          >
            <Camera className="h-4 w-4" />
            Take the photo anyway
          </Button>
          {skippable && (
            <Button
              variant="outline"
              onClick={handleSkip}
              className="rounded-full glass-panel border-0 px-6 gap-2"
              data-testid="guided-skip-angle"
            >
              <CheckCircle2 className="h-4 w-4" />
              Skip this angle
            </Button>
          )}
        </div>
      )}

      <p className="mt-1 text-xs text-muted-foreground text-center max-w-md leading-relaxed">
        Three quick angles — straight on, then a slight turn each way — let us
        cross-check every measurement. You&apos;ll hear a chime each time a
        photo is taken, so there&apos;s no need to watch the screen. It all
        happens on this device; photos never leave your phone.
      </p>
    </div>
  );
}
