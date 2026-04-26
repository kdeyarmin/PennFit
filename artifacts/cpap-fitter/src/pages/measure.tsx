import React, { useEffect, useState } from "react";
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
  const { capturedImage, setMeasurements } = useFitterStore();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing secure on-device processor...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!capturedImage) {
      setLocation("/capture");
      return;
    }

    let isMounted = true;
    
    const processImage = async () => {
      try {
        if (!isMounted) return;
        setProgress(15);
        setStatus("Loading MediaPipe Face Mesh model...");

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );

        if (!isMounted) return;
        setProgress(40);
        setStatus("Configuring landmark detection...");

        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          outputFaceBlendshapes: false,
          runningMode: "IMAGE",
          numFaces: 1
        });

        if (!isMounted) return;
        setProgress(60);
        setStatus("Analyzing facial structure...");

        // Create an image element to feed to MediaPipe
        const img = new Image();
        img.src = capturedImage;
        await new Promise((resolve) => { img.onload = resolve; });

        if (!isMounted) return;
        setProgress(75);
        setStatus("Extracting precise measurements...");

        const result = faceLandmarker.detect(img);

        if (result.faceLandmarks && result.faceLandmarks.length > 0) {
          const landmarks = result.faceLandmarks[0];
          
          /*
            MediaPipe landmarks are normalized [0, 1].
            We need a reference object to convert to mm.
            If a credit card was held (width ~85.6mm), we could detect its corners.
            Since full card detection is complex, we will use the iris diameter as a fallback calibration.
            Average adult human iris diameter is ~11.7mm.
            
            Landmarks (normalized coordinates):
            Nose tip: 4
            Nose bridge: 6
            Left nostril: 129, Right nostril: 358
            Left mouth corner: 61, Right mouth corner: 291
            Chin bottom: 152
            Left cheekbone: 234, Right cheekbone: 454
            Left iris center: 468, Right iris center: 473
            Left iris boundary (left): 469, Left iris boundary (right): 471
          */
          
          // Calculate Euclidean distance between two normalized landmarks
          const dist = (p1: any, p2: any) => {
            const dx = (p1.x - p2.x) * img.width;
            const dy = (p1.y - p2.y) * img.height;
            return Math.sqrt(dx * dx + dy * dy);
          };

          // 1. Determine pixels per mm using Iris
          // Iris center is 468. Left bound is 469, right is 471.
          // Let's measure the horizontal diameter of the left iris in pixels
          const irisLeftPix = dist(landmarks[469], landmarks[471]);
          const pxPerMm = irisLeftPix / 11.7; // ~11.7mm avg iris diameter
          
          if (pxPerMm < 0.1) {
            throw new Error("Could not detect features clearly for calibration. Please ensure good lighting.");
          }

          // 2. Extract measurements in pixels and convert to mm
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
            calibrationMethod: "iris"
          };

          if (!isMounted) return;
          setProgress(100);
          setStatus("Analysis complete.");
          setMeasurements(measurements);
          
          // Proceed automatically
          setTimeout(() => {
            if (isMounted) setLocation("/questionnaire");
          }, 800);

        } else {
          throw new Error("No face detected in the image. Please try again.");
        }

      } catch (err: any) {
        console.error("Measurement error:", err);
        if (isMounted) setError(err.message || "An error occurred during measurement extraction.");
      }
    };

    // Add a tiny delay so the UI can render the initial state smoothly
    setTimeout(processImage, 100);

    return () => {
      isMounted = false;
    };
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
    <div className="container max-w-xl mx-auto px-4 py-24 animate-in fade-in zoom-in-95 duration-500">
      <Card className="border-border shadow-md">
        <CardContent className="pt-12 pb-12 flex flex-col items-center text-center space-y-8">
          <div className="relative">
            {progress === 100 ? (
              <div className="h-24 w-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto animate-in zoom-in duration-300">
                <CheckCircle2 className="h-12 w-12" />
              </div>
            ) : (
              <div className="h-24 w-24 bg-primary/10 text-primary rounded-full flex items-center justify-center mx-auto relative overflow-hidden">
                <ScanFace className="h-10 w-10 absolute z-10" />
                <div 
                  className="absolute inset-0 bg-primary/20 transition-all duration-300"
                  style={{ transform: `translateY(${100 - progress}%)` }}
                />
              </div>
            )}
          </div>
          
          <div className="space-y-4 w-full">
            <h2 className="text-2xl font-semibold tracking-tight">Processing Measurements</h2>
            <p className="text-muted-foreground h-6">{status}</p>
            <Progress value={progress} className="h-2 w-full" />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-4 py-2 rounded-full mt-4">
            <BrainCircuit className="h-4 w-4" />
            <span>Secure on-device processing. No data transmitted.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
