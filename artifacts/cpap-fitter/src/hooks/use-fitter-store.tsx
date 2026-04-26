import React, { createContext, useContext, useState, ReactNode } from "react";
import type { FacialMeasurements, QuestionnaireAnswers } from "@workspace/api-client-react";

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

interface FitterContextType extends FitterState {
  setMeasurements: (measurements: FacialMeasurements) => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  setCapturedImage: (image: string | null) => void;
  setChosenMask: (mask: ChosenMask | null) => void;
  reset: () => void;
}

const FitterContext = createContext<FitterContextType | undefined>(undefined);

export function FitterProvider({ children }: { children: ReactNode }) {
  const [measurements, setMeasurements] = useState<FacialMeasurements | null>(null);

  // Load initial answers from sessionStorage
  const [answers, setAnswers] = useState<Partial<QuestionnaireAnswers>>(() => {
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
