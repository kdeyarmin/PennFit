import React, { createContext, useContext, useState, ReactNode } from "react";
import type { FacialMeasurements, QuestionnaireAnswers } from "@workspace/api-client-react";

interface FitterState {
  measurements: FacialMeasurements | null;
  answers: Partial<QuestionnaireAnswers>;
  capturedImage: string | null; // Data URL for display purposes only. Never uploaded.
}

interface FitterContextType extends FitterState {
  setMeasurements: (measurements: FacialMeasurements) => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  setCapturedImage: (image: string | null) => void;
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

  const reset = () => {
    setMeasurements(null);
    setAnswers({});
    setCapturedImage(null);
    sessionStorage.removeItem("fitter_answers");
  };

  return (
    <FitterContext.Provider
      value={{
        measurements,
        answers,
        capturedImage,
        setMeasurements,
        updateAnswers,
        setCapturedImage,
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
