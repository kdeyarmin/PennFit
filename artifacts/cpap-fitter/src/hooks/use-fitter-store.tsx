import React, { createContext, useContext, useState, ReactNode } from "react";
import type { FacialMeasurements, QuestionnaireAnswers } from "@workspace/api-client-react/storefront";

export interface ChosenMask {
  maskId: string;
  name: string;
  modelNumber: string;
  manufacturer: string;
}

interface FitterState {
  measurements: FacialMeasurements | null;
  answers: Partial<QuestionnaireAnswers>;
  capturedImage: string | null; // Data URL for display purposes only. Never uploaded.
  chosenMask: ChosenMask | null;
}

// Demo mode (?demo=1) pre-populates realistic but fake state so we can:
//   1. Capture screenshots of the gated /questionnaire and /results pages
//      for the tutorial video, and
//   2. Walk customers through the full app at trade shows / live demos
//      without needing a working camera.
// The values here are NOT real patient data — keep them clearly synthetic.
const DEMO_MEASUREMENTS: FacialMeasurements = {
  noseWidth: 35.2,
  noseHeight: 48.7,
  noseToChin: 62.3,
  mouthWidth: 52.1,
  faceWidthAtCheekbones: 138.4,
  calibrationMethod: "iris",
};
const DEMO_ANSWERS: Partial<QuestionnaireAnswers> = {
  mouthBreather: false,
  claustrophobic: false,
  sideOrStomachSleeper: true,
  heavyFacialHair: false,
  wearsGlasses: false,
  frequentCongestion: false,
  priorMaskExperience: "none",
  mobilityLimitations: false,
  sensitiveSkin: false,
  siliconeSensitivity: false,
  cpapPressureSetting: "medium",
};
// Demo mode is gated behind a development build (or an explicit
// VITE_ENABLE_DEMO=1 env at build time) so a public production user can't
// bypass the measurement/answer flow gating just by appending ?demo=1 to the
// URL — that would let them view recommendations based on synthetic data
// instead of their own. For trade-show / sales-demo deployments, build with
// VITE_ENABLE_DEMO=1 to re-enable demo mode in production.
function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  const enabled =
    import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === "1";
  if (!enabled) return false;
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}

interface FitterContextType extends FitterState {
  setMeasurements: (measurements: FacialMeasurements) => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  setCapturedImage: (image: string | null) => void;
  setChosenMask: (mask: ChosenMask | null) => void;
  reset: () => void;
}

const FitterContext = createContext<FitterContextType | undefined>(undefined);

export function FitterProvider({ children }: { children: ReactNode }) {
  // Lazy initializers run BEFORE any child renders, which means demo state is
  // available on first paint — critical for /results, which redirects to "/"
  // in a useEffect when measurements are null.
  const demo = isDemoMode();

  const [measurements, setMeasurements] = useState<FacialMeasurements | null>(
    demo ? DEMO_MEASUREMENTS : null,
  );

  // Load initial answers from sessionStorage (or demo answers in demo mode).
  const [answers, setAnswers] = useState<Partial<QuestionnaireAnswers>>(() => {
    if (demo) return DEMO_ANSWERS;
    try {
      const stored = sessionStorage.getItem("fitter_answers");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  // Chosen mask survives a refresh on the order page so the patient doesn't
  // have to redo the questionnaire. Stored in sessionStorage (cleared on tab
  // close); never persisted to disk or transmitted on its own.
  const [chosenMask, setChosenMaskState] = useState<ChosenMask | null>(() => {
    try {
      const stored = sessionStorage.getItem("fitter_chosen_mask");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const updateAnswers = (newAnswers: Partial<QuestionnaireAnswers>) => {
    setAnswers((prev) => {
      const updated = { ...prev, ...newAnswers };
      try {
        sessionStorage.setItem("fitter_answers", JSON.stringify(updated));
      } catch (e) {
        console.error("Failed to save answers to sessionStorage", e);
      }
      return updated;
    });
  };

  const setChosenMask = (mask: ChosenMask | null) => {
    setChosenMaskState(mask);
    try {
      if (mask) {
        sessionStorage.setItem("fitter_chosen_mask", JSON.stringify(mask));
      } else {
        sessionStorage.removeItem("fitter_chosen_mask");
      }
    } catch (e) {
      console.error("Failed to persist chosen mask", e);
    }
  };

  const reset = () => {
    setMeasurements(null);
    setAnswers({});
    setCapturedImage(null);
    setChosenMaskState(null);
    sessionStorage.removeItem("fitter_answers");
    sessionStorage.removeItem("fitter_chosen_mask");
  };

  return (
    <FitterContext.Provider
      value={{
        measurements,
        answers,
        capturedImage,
        chosenMask,
        setMeasurements,
        updateAnswers,
        setCapturedImage,
        setChosenMask,
        reset,
      }}
    >
      {children}
    </FitterContext.Provider>
  );
}

export function useFitterStore() {
  const context = useContext(FitterContext);
  if (!context) {
    throw new Error("useFitterStore must be used within a FitterProvider");
  }
  return context;
}
