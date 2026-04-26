import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { BrainCircuit, ScanFace, CheckCircle2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import type { FacialMeasurements } from "@workspace/api-client-react";

export function Measure() {
  const [, setLocation] = useLocation();
  const { capturedImage, setMeasurements, setCapturedImage } = useFitterStore();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing secure on-device processor…");
  const [error, setError] = useState<string | null>(null);
  // Guard so the effect doesn't redirect us back to /capture once we
  // intentionally clear the captured image for privacy after extracting
  // measurements (which would otherwise re-fire this effect with capturedImage
  // === null, beating our setTimeout to /questionnaire).
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    if (!capturedImage) {
      setLocation("/capture");
      return;
    }
    startedRef.current = true;

    let isMounted = true;

    const processImage = async () => {
      try {
        if (!isMounted) return;
        setProgress(15);
        setStatus("Loading on-device facial landmark model…");

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
        );

        if (!isMounted) return;
        setProgress(40);
        setStatus("Configuring landmark detection…");

        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU",
          },
          outputFaceBlendshapes: false,
          runningMode: "IMAGE",
          numFaces: 1,
        });

        if (!isMounted) return;
        setProgress(60);
        setStatus("Analyzing facial structure…");

        const img = new Image();
        img.src = capturedImage;
        await new Promise((resolve) => {
          img.onload = resolve;
        });

        if (!isMounted) return;
        setProgress(75);
        setStatus("Calibrating to your iris and extracting measurements…");

        const result = faceLandmarker.detect(img);

        if (result.faceLandmarks && result.faceLandmarks.length > 0) {
          const landmarks = result.faceLandmarks[0];

          /*
            MediaPipe landmarks are normalized [0, 1].
            We calibrate the millimeter scale using the iris diameter, which is
            remarkably consistent across adults at ~11.7mm horizontally
            (Forrester JV et al, "The Eye: Basic Sciences in Practice", 4th ed).

            Landmarks (normalized coordinates):
            Nose tip: 4
            Nose bridge: 6
            Left nostril: 129, Right nostril: 358
            Left mouth corner: 61, Right mouth corner: 291
            Chin bottom: 152
            Left cheekbone: 234, Right cheekbone: 454
            Left iris boundary (left): 469, Left iris boundary (right): 471
          */

          const dist = (p1: any, p2: any) => {
            const dx = (p1.x - p2.x) * img.width;
            const dy = (p1.y - p2.y) * img.height;
            return Math.sqrt(dx * dx + dy * dy);
          };

          const irisLeftPix = dist(landmarks[469], landmarks[471]);
          const pxPerMm = irisLeftPix / 11.7;

          if (pxPerMm < 0.1) {
            throw new Error(
              "Could not detect features clearly for calibration. Please ensure good lighting and try again.",
            );
          }

          const mm = (pixels: number) => Math.round((pixels / pxPerMm) * 10) / 10;

          const noseWidthPx = dist(landmarks[129], landmarks[358]);
          const noseHeightPx = dist(landmarks[6], landmarks[4]);
          const noseToChinPx = dist(landmarks[4], landmarks[152]);
          const mouthWidthPx = dist(landmarks[61], landmarks[291]);
          const faceWidthPx = dist(landmarks[234], landmarks[454]);

          const measurements: FacialMeasurements = {
            noseWidth: mm(noseWidthPx),
            noseHeight: mm(noseHeightPx),
            noseToChin: mm(noseToChinPx),
            mouthWidth: mm(mouthWidthPx),
            faceWidthAtCheekbones: mm(faceWidthPx),
            calibrationMethod: "iris",
          };

          if (!isMounted) return;
          setProgress(100);
          setStatus("Analysis complete.");
          setMeasurements(measurements);

          // Privacy: discard the captured image from memory the moment we have
          // numeric measurements. Our UI promises this — keep it true.
          setCapturedImage(null);

          setTimeout(() => {
            if (isMounted) setLocation("/questionnaire");
          }, 900);
        } else {
          throw new Error("No face detected in the image. Please try the capture again.");
        }
      } catch (err: any) {
        console.error("Measurement error:", err);
        if (isMounted) setError(err.message || "An error occurred during measurement extraction.");
      }
    };

    setTimeout(processImage, 100);

    return () => {
      isMounted = false;
    };
    // setCapturedImage is intentionally omitted — including it would re-run the
    // entire MediaPipe pipeline when we clear the image on success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturedImage, setLocation, setMeasurements]);

  if (error) {
    return (
      <div className="container max-w-md mx-auto px-4 py-24 text-center">
        <Alert variant="destructive" className="mb-6 text-left">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button onClick={() => setLocation("/capture")}>Return to Camera</Button>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-in fade-in zoom-in-95 duration-500">
      <Card className="border-border shadow-md overflow-hidden">
        <CardContent className="p-0">
          {/* Image with scan line overlay — feels active and "tech" */}
          {capturedImage ? (
            <div className="relative aspect-[3/4] md:aspect-video bg-black overflow-hidden">
              <img
                src={capturedImage}
                alt="Captured for analysis"
                className="w-full h-full object-cover transform -scale-x-100"
              />
              {/* Soft dark overlay */}
              <div className="absolute inset-0 bg-black/20" />
              {/* Animated scan line — sweeps top to bottom */}
              {progress < 100 && (
                <>
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-b from-primary/0 via-primary to-primary/0 shadow-[0_0_20px_4px_rgba(59,130,246,0.6)] scan-line" />
                  {/* Subtle horizontal scan grid */}
                  <div
                    className="absolute inset-0 opacity-30 pointer-events-none"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(0deg, rgba(59,130,246,0.05) 0px, rgba(59,130,246,0.05) 1px, transparent 1px, transparent 8px)",
                    }}
                  />
                </>
              )}
              {/* Corner brackets to suggest "scanning frame" */}
              <CornerBrackets />
              {/* Completion badge */}
              {progress === 100 && (
                <div className="absolute inset-0 flex items-center justify-center bg-green-600/30 backdrop-blur-[1px] animate-in fade-in duration-300">
                  <div className="h-20 w-20 bg-white text-green-600 rounded-full flex items-center justify-center shadow-2xl animate-in zoom-in duration-300">
                    <CheckCircle2 className="h-10 w-10" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Fallback if image isn't available (shouldn't happen — redirected above)
            <div className="aspect-video bg-muted flex items-center justify-center">
              <ScanFace className="w-16 h-16 text-muted-foreground" />
            </div>
          )}

          <div className="p-8 space-y-5">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold tracking-tight">
                {progress === 100 ? "Measurements Ready" : "Processing Your Measurements"}
              </h2>
              <p className="text-sm text-muted-foreground h-5">{status}</p>
            </div>
            <Progress value={progress} className="h-2 w-full" />
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-4 py-2.5 rounded-lg">
              <BrainCircuit className="h-4 w-4 shrink-0 text-primary" />
              <span>
                Your photo is being processed entirely on this device by Google's
                MediaPipe library. The image is discarded the moment your
                measurements are extracted.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
      {/* CSS animation keyframes for the scan line — container-relative so it
          tracks the image regardless of viewport, and disabled for users with
          a reduced-motion preference. */}
      <style>{`
        @keyframes scanLineMove {
          0%   { top: 0%; opacity: 0.4; }
          10%  { opacity: 1; }
          50%  { top: 100%; opacity: 1; }
          60%  { opacity: 0.4; }
          100% { top: 0%; opacity: 0.4; }
        }
        .scan-line {
          animation: scanLineMove 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
          will-change: top, opacity;
        }
        @media (prefers-reduced-motion: reduce) {
          .scan-line {
            animation: none;
            top: 50%;
            opacity: 0.7;
          }
        }
      `}</style>
    </div>
  );
}

function CornerBrackets() {
  const cornerClass = "absolute w-6 h-6 border-primary/80";
  return (
    <>
      <div className={`${cornerClass} top-3 left-3 border-t-2 border-l-2 rounded-tl-md`} />
      <div className={`${cornerClass} top-3 right-3 border-t-2 border-r-2 rounded-tr-md`} />
      <div className={`${cornerClass} bottom-3 left-3 border-b-2 border-l-2 rounded-bl-md`} />
      <div className={`${cornerClass} bottom-3 right-3 border-b-2 border-r-2 rounded-br-md`} />
    </>
  );
}
