import React, { createContext, useContext, useState, ReactNode } from "react";
import type {
  FacialMeasurements,
  QuestionnaireAnswers,
} from "@workspace/api-client-react/storefront";

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
  /**
   * Email + marketing-consent captured at the start of the fitter flow
   * (on the /consent page). Downstream routes (/capture, /measure,
   * /questionnaire, /results, /order) refuse to render until the email
   * is set, so the email backs every recommendation the patient sees.
   * `emailConsent` is the OPTIONAL marketing opt-in — it does not gate
   * the flow (see useFitterEmailGate in App.tsx); its only consumer is
   * the marketing-gated completion ping in results.tsx.
   */
  email: string | null;
  emailConsent: boolean;
  /**
   * Signed token from a staff-initiated AI-fitter invite
   * (`/fitter-invite?t=…`). When present, the /results page transmits
   * the full fitting (measurements + answers + recommendation) back to
   * PennPaps via /shop/fitter-invite/complete so it can be attached to
   * the patient's chart. Null for the normal public storefront flow.
   */
  inviteToken: string | null;
}

interface FitterContextType extends FitterState {
  setMeasurements: (measurements: FacialMeasurements) => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  setCapturedImage: (image: string | null) => void;
  setChosenMask: (mask: ChosenMask | null) => void;
  setEmailConsent: (email: string, consent: boolean) => void;
  setInviteToken: (token: string | null) => void;
  reset: () => void;
}

const FitterContext = createContext<FitterContextType | undefined>(undefined);

export function FitterProvider({ children }: { children: ReactNode }) {
  const [measurements, setMeasurements] = useState<FacialMeasurements | null>(
    null,
  );

  // Load initial answers from sessionStorage.
  const [answers, setAnswers] = useState<Partial<QuestionnaireAnswers>>(() => {
    try {
      const stored = sessionStorage.getItem("fitter_answers");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  // Email + marketing-consent gate. Persisted in sessionStorage so a
  // refresh mid-flow doesn't kick the patient back to /consent.
  const [email, setEmail] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("fitter_email");
    } catch {
      return null;
    }
  });
  const [emailConsent, setEmailConsentState] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("fitter_email_consent") === "1";
    } catch {
      return false;
    }
  });

  // Staff-invite token. Persisted in sessionStorage so it survives the
  // multi-page fitter flow (and a mid-flow refresh) and is still
  // available on /results to transmit the completed fitting.
  const [inviteToken, setInviteTokenState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("fitter_invite_token");
    } catch {
      return null;
    }
  });

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

  const setEmailConsent = (nextEmail: string, consent: boolean) => {
    setEmail(nextEmail);
    setEmailConsentState(consent);
    try {
      sessionStorage.setItem("fitter_email", nextEmail);
      sessionStorage.setItem("fitter_email_consent", consent ? "1" : "0");
    } catch (e) {
      console.error("Failed to persist fitter email consent", e);
    }
  };

  const setInviteToken = (token: string | null) => {
    setInviteTokenState(token);
    try {
      if (token) {
        sessionStorage.setItem("fitter_invite_token", token);
      } else {
        sessionStorage.removeItem("fitter_invite_token");
      }
    } catch (e) {
      console.error("Failed to persist fitter invite token", e);
    }
  };

  const reset = () => {
    setMeasurements(null);
    setAnswers({});
    setCapturedImage(null);
    setChosenMaskState(null);
    setEmail(null);
    setEmailConsentState(false);
    setInviteTokenState(null);
    sessionStorage.removeItem("fitter_answers");
    sessionStorage.removeItem("fitter_chosen_mask");
    sessionStorage.removeItem("fitter_email");
    sessionStorage.removeItem("fitter_email_consent");
    sessionStorage.removeItem("fitter_invite_token");
  };

  return (
    <FitterContext.Provider
      value={{
        measurements,
        answers,
        capturedImage,
        chosenMask,
        email,
        emailConsent,
        inviteToken,
        setMeasurements,
        updateAnswers,
        setCapturedImage,
        setChosenMask,
        setEmailConsent,
        setInviteToken,
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
