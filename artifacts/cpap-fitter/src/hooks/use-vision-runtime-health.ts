import { useEffect, useState } from "react";

export type VisionRuntimeHealth = "checking" | "ready" | "degraded";

export function useVisionRuntimeHealth() {
  const [health, setHealth] = useState<VisionRuntimeHealth>("checking");

  useEffect(() => {
    let active = true;
    const base = import.meta.env.BASE_URL;
    const modelUrl = `${base}mediapipe/models/face_landmarker.task`;
    fetch(modelUrl, { method: "HEAD" })
      .then((r) => {
        if (!active) return;
        setHealth(r.ok ? "ready" : "degraded");
      })
      .catch(() => {
        if (!active) return;
        setHealth("degraded");
      });
    return () => {
      active = false;
    };
  }, []);

  return health;
}
