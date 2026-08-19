import React, { createContext, useContext, useState, ReactNode } from "react";
import type {
  FacialMeasurements,
  QuestionnaireAnswers,
} from "@workspace/api-client-react/storefront";
import type { ScanSignalsPayload } from "@/lib/scan-signals";
import type { FitAnswers } from "@/lib/fit-profile";

export interface ChosenMask {
  maskId: string;
  name: string;
  modelNumber: string;
  manufacturer: string;
  /**
   * The size the fitting actually recommended, e.g. "Medium". Optional
   * because the legacy `/api/recommend` path ranks masks without ever
   * resolving a size — the clinical path (`/api/fit/assess`) does, and
   * losing it between the results page and the order was a real gap: a
   * mask ordered in the wrong size fits no better than the wrong mask.
   */
  size?: string | null;
}

interface FitterState {
  measurements: FacialMeasurements | null;
  /**
   * Scalar scan-quality signals for the frame the measurements came from
   * (lighting, focus, pose, framing, cross-frame agreement, and the
   * resulting measurement confidence). Set alongside `measurements` by
   * /measure and posted with the clinical assessment, which otherwise
   * substitutes a fixed neutral 0.7 — below its own high-confidence scan
   * floor, so no fitting could ever be high confidence. Scalars only;
   * nothing image-derived beyond these numbers is retained.
   */
  scanSignals: ScanSignalsPayload | null;
  answers: Partial<QuestionnaireAnswers>;
  /**
   * The v2 Patient Fit Profile answers, when the tenant runs the v2
   * questionnaire (`fitProfileV2`). `undefined`/missing = not yet asked;
   * `null` = the patient explicitly said "I'm not sure". The v1 `answers`
   * above are kept in sync via `toLegacyAnswers` so every legacy consumer
   * (the /api/recommend fallback, the invite completion payload, the
   * campaign ping) keeps working unchanged.
   */
  fitAnswers: FitAnswers;
  /** Whether this tenant's invite resolved with the v2 questionnaire on. */
  fitProfileV2: boolean;
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
  /**
   * How the patient was put in front of the fitter — set from the `entry`
   * query param on a referral fitting link. Without it every persisted
   * session would record `remote_link`, silently mislabelling in-office
   * and kiosk fittings and defeating any by-channel outcome comparison.
   */
  entryPoint:
    | "remote_link"
    | "in_office"
    | "kiosk_qr"
    | "refit_campaign"
    | null;
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
  setMeasurements: (
    measurements: FacialMeasurements,
    scanSignals?: ScanSignalsPayload | null,
  ) => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  updateFitAnswers: (answers: FitAnswers) => void;
  setFitProfileV2: (on: boolean) => void;
  setCapturedImage: (image: string | null) => void;
  setChosenMask: (mask: ChosenMask | null) => void;
  setEmailConsent: (email: string, consent: boolean) => void;
  setInviteToken: (token: string | null) => void;
  reset: () => void;
}

const FitterContext = createContext<FitterContextType | undefined>(undefined);
const MEASUREMENTS_STORAGE_KEY = "fitter_measurements";
const SCAN_SIGNALS_STORAGE_KEY = "fitter_scan_signals";

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

function isFacialMeasurements(value: unknown): value is FacialMeasurements {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const method = m.calibrationMethod;
  return (
    typeof m.noseWidth === "number" &&
    typeof m.noseHeight === "number" &&
    typeof m.noseToChin === "number" &&
    typeof m.mouthWidth === "number" &&
    typeof m.faceWidthAtCheekbones === "number" &&
    (method === "creditCard" || method === "iris" || method === "manual")
  );
}

function readStoredMeasurements(): FacialMeasurements | null {
  try {
    const stored = sessionStorage.getItem(MEASUREMENTS_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!isFacialMeasurements(parsed)) return null;
    return {
      noseWidth: parsed.noseWidth,
      noseHeight: parsed.noseHeight,
      noseToChin: parsed.noseToChin,
      mouthWidth: parsed.mouthWidth,
      faceWidthAtCheekbones: parsed.faceWidthAtCheekbones,
      calibrationMethod: parsed.calibrationMethod,
    };
  } catch {
    return null;
  }
}

/**
 * Restore the persisted scan signals.
 *
 * Validated loosely on purpose: the API re-validates with a strict Zod
 * schema, and a malformed blob here should degrade to "no signals"
 * (the server's neutral default) rather than throw mid-flow.
 */
function readStoredScanSignals(): ScanSignalsPayload | null {
  try {
    const stored = sessionStorage.getItem(SCAN_SIGNALS_STORAGE_KEY);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.measurementConfidence !== "number") return null;
    if (r.band !== "high" && r.band !== "moderate" && r.band !== "low") {
      return null;
    }
    if (typeof r.frameCount !== "number") return null;
    return parsed as ScanSignalsPayload;
  } catch {
    return null;
  }
}

export function FitterProvider({ children }: { children: ReactNode }) {
  const [storagePersisted] = useState(probeSessionStorage);
  const [measurements, setMeasurementsState] =
    useState<FacialMeasurements | null>(readStoredMeasurements);
  const [scanSignals, setScanSignalsState] =
    useState<ScanSignalsPayload | null>(readStoredScanSignals);

  // Load initial answers from sessionStorage.
  const [answers, setAnswers] = useState<Partial<QuestionnaireAnswers>>(() => {
    try {
      const stored = sessionStorage.getItem("fitter_answers");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // The v2 Patient Fit Profile answers + the flag that turns the v2
  // questionnaire on. Both survive a mid-flow refresh like everything
  // else in this store.
  const [fitAnswers, setFitAnswers] = useState<FitAnswers>(() => {
    try {
      const stored = sessionStorage.getItem("fitter_fit_answers");
      return stored ? (JSON.parse(stored) as FitAnswers) : {};
    } catch {
      return {};
    }
  });
  const [fitProfileV2, setFitProfileV2State] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("fitter_profile_v2") === "1";
    } catch {
      return false;
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
  const [entryPoint] = useState<
    "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign" | null
  >(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("entry");
    return raw === "in_office" ||
      raw === "kiosk_qr" ||
      raw === "remote_link" ||
      raw === "refit_campaign"
      ? raw
      : null;
  });
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

  const updateFitAnswers = (newAnswers: FitAnswers) => {
    setFitAnswers((prev) => {
      const updated = { ...prev, ...newAnswers };
      try {
        sessionStorage.setItem("fitter_fit_answers", JSON.stringify(updated));
      } catch (e) {
        console.error("Failed to save fit answers to sessionStorage", e);
      }
      return updated;
    });
  };

  const setFitProfileV2 = (on: boolean) => {
    setFitProfileV2State(on);
    try {
      if (on) sessionStorage.setItem("fitter_profile_v2", "1");
      else sessionStorage.removeItem("fitter_profile_v2");
    } catch (e) {
      console.error("Failed to persist fit profile flag", e);
    }
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

  const setMeasurements = (
    nextMeasurements: FacialMeasurements,
    nextScanSignals?: ScanSignalsPayload | null,
  ) => {
    setMeasurementsState(nextMeasurements);
    if (nextScanSignals !== undefined) setScanSignalsState(nextScanSignals);
    try {
      sessionStorage.setItem(
        MEASUREMENTS_STORAGE_KEY,
        JSON.stringify({
          noseWidth: nextMeasurements.noseWidth,
          noseHeight: nextMeasurements.noseHeight,
          noseToChin: nextMeasurements.noseToChin,
          mouthWidth: nextMeasurements.mouthWidth,
          faceWidthAtCheekbones: nextMeasurements.faceWidthAtCheekbones,
          calibrationMethod: nextMeasurements.calibrationMethod,
        }),
      );
      // Persisted separately so a refresh keeps the real signals rather
      // than falling back to the server's neutral default.
      if (nextScanSignals) {
        sessionStorage.setItem(
          SCAN_SIGNALS_STORAGE_KEY,
          JSON.stringify(nextScanSignals),
        );
      } else if (nextScanSignals === null) {
        sessionStorage.removeItem(SCAN_SIGNALS_STORAGE_KEY);
      }
    } catch (e) {
      console.error("Failed to persist fitter measurements", e);
    }
  };

  const reset = () => {
    setMeasurementsState(null);
    setScanSignalsState(null);
    setAnswers({});
    setFitAnswers({});
    setFitProfileV2State(false);
    setCapturedImage(null);
    setChosenMaskState(null);
    setEmail(null);
    setEmailConsentState(false);
    setInviteTokenState(null);
    try {
      sessionStorage.removeItem("fitter_measurements");
      sessionStorage.removeItem("fitter_answers");
      sessionStorage.removeItem("fitter_fit_answers");
      sessionStorage.removeItem("fitter_profile_v2");
      sessionStorage.removeItem("fitter_chosen_mask");
      sessionStorage.removeItem("fitter_email");
      sessionStorage.removeItem("fitter_email_consent");
      sessionStorage.removeItem("fitter_invite_token");
      sessionStorage.removeItem(MEASUREMENTS_STORAGE_KEY);
      sessionStorage.removeItem(SCAN_SIGNALS_STORAGE_KEY);
    } catch {
      // Storage unusable — nothing was persisted, nothing to clear.
    }
  };

  return (
    <FitterContext.Provider
      value={{
        measurements,
        scanSignals,
        answers,
        fitAnswers,
        fitProfileV2,
        capturedImage,
        chosenMask,
        email,
        emailConsent,
        inviteToken,
        entryPoint,
        storagePersisted,
        setMeasurements,
        updateAnswers,
        updateFitAnswers,
        setFitProfileV2,
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
