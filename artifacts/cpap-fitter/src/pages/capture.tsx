import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Camera, AlertCircle, RefreshCw } from "lucide-react";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function Capture() {
  const [, setLocation] = useLocation();
  const { setCapturedImage } = useFitterStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setHasPermission(true);
    } catch (err: any) {
      console.error("Camera error:", err);
      setHasPermission(false);
      if (err.name === "NotAllowedError") {
        setError("Camera access was denied. Please enable camera permissions in your browser settings to continue.");
      } else if (err.name === "NotFoundError") {
        setError("No camera found on this device.");
      } else {
        setError("An error occurred while accessing the camera: " + err.message);
      }
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
    }
  };

  const takeCapture = () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    setIsCapturing(true);
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    // Set canvas dimensions to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Could not initialize image capture.");
      setIsCapturing(false);
      return;
    }
    
    // Draw video frame to canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Get data URL (in-memory only)
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setCapturedImage(dataUrl);
    
    // Stop camera and proceed
    stopCamera();
    setLocation("/measure");
  };

  if (hasPermission === false || error) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Camera Access Required</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div className="flex justify-center">
          <Button onClick={startCamera} variant="outline" className="gap-2">
            <RefreshCw className="h-4 w-4" /> Try Again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto px-4 py-8 flex flex-col items-center">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Position Your Face</h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Align your face within the oval. For best accuracy, hold a standard credit card flat against your chin.
        </p>
      </div>

      <div className="relative w-full max-w-lg aspect-[3/4] md:aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl mb-8 border border-border">
        {/* Loading state indicator */}
        {hasPermission === null && (
          <div className="absolute inset-0 flex items-center justify-center text-white/50">
            <RefreshCw className="h-8 w-8 animate-spin" />
          </div>
        )}
        
        <video 
          ref={videoRef}
          autoPlay 
          playsInline 
          muted
          className="w-full h-full object-cover transform -scale-x-100" // Mirror effect
        />
        
        {/* Hidden canvas for extraction */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Overlay Guides */}
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
          {/* Face Oval */}
          <div className="w-3/5 md:w-2/5 aspect-[3/4] border-4 border-dashed border-primary/70 rounded-[100%] shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
          
          {/* Card alignment hint */}
          <div className="absolute bottom-[15%] w-2/5 h-[8%] border-2 border-white/50 rounded-md flex items-center justify-center bg-white/10 backdrop-blur-sm">
            <span className="text-white/80 text-xs font-medium px-2 text-center">
              Credit Card / ID Card
            </span>
          </div>
        </div>
      </div>

      <Button 
        size="lg" 
        className="h-16 px-12 rounded-full text-lg shadow-lg hover:scale-105 transition-transform"
        onClick={takeCapture}
        disabled={isCapturing || hasPermission === null}
      >
        <Camera className="mr-2 h-6 w-6" />
        Capture Measurement Frame
      </Button>
    </div>
  );
}
