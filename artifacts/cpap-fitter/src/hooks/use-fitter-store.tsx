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
  /**
   * False when sessionStorage is unusable (some private-browsing
   * modes, storage quota exhausted, cookies/site-data fully blocked).
   * The flow still works — all state lives in React memory — but a
   * refresh restarts from /consent. Surfaces a heads-up banner so the
   * patient isn't surprised mid-flow.
   */
  storagePersisted: boolean;
  setMeasurements: (measurements: FacialMeasurements) => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  setCapturedImage: (image: string | null) => void;
  setChosenMask: (mask: ChosenMask | null) => void;
  setEmailConsent: (email: string, consent: boolean) => void;
  setInviteToken: (token: string | null) => void;
  reset: () => void;
}

const FitterContext = createContext<FitterContextType | undefined>(undefined);

/**
 * Write-probe sessionStorage. Reading `window.sessionStorage` alone
 * can throw (site data blocked), and some private modes only fail on
 * setItem — so probe the full round-trip once at provider mount.
 */
function probeSessionStorage(): boolean {
  try {
    const k = "__fitter_storage_probe__";
    sessionStorage.setItem(k, "1");
    sessionStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export function FitterProvider({ children }: { children: ReactNode }) {
  const [storagePersisted] = useState(probeSessionStorage);

  // Numeric facial measurements survive a mid-flow refresh (a common
  // mobile failure mode — tab restore / accidental pull-to-refresh on
  // /questionnaire, /results, or /order) so the patient doesn't have
  // to retake the photo. ONLY the numeric measurement object is
  // persisted — capturedImage stays memory-only and never reaches any
  // storage (privacy invariant: images never leave the browser, and
  // never even leave React memory).
  const [measurements, setMeasurementsState] =
    useState<FacialMeasurements | null>(() => {
      try {
        const stored = sessionStorage.getItem("fitter_measurements");
        return stored ? JSON.parse(stored) : null;
      } catch {
        return null;
      }
    });

  const setMeasurements = (next: FacialMeasurements) => {
    setMeasurementsState(next);
    try {
      sessionStorage.setItem("fitter_measurements", JSON.stringify(next));
    } catch (e) {
      console.error("Failed to persist fitter measurements", e);
    }
  };

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
    setMeasurementsState(null);
    setAnswers({});
    setCapturedImage(null);
    setChosenMaskState(null);
    setEmail(null);
    setEmailConsentState(false);
    setInviteTokenState(null);
    try {
      sessionStorage.removeItem("fitter_measurements");
      sessionStorage.removeItem("fitter_answers");
      sessionStorage.removeItem("fitter_chosen_mask");
      sessionStorage.removeItem("fitter_email");
      sessionStorage.removeItem("fitter_email_consent");
      sessionStorage.removeItem("fitter_invite_token");
    } catch {
      // Storage unusable — nothing was persisted, nothing to clear.
    }
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
        storagePersisted,
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
