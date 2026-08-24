import React, { createContext, useContext, useState, ReactNode } from "react";
import type {
  FacialMeasurements,
  QuestionnaireAnswers,
} from "@workspace/api-client-react/storefront";
import type { ScanSignalsPayload } from "@/lib/scan-signals";
import type { FitAnswers } from "@/lib/fit-profile";
import type { CapturePose } from "@/lib/scan-quality";

/**
 * One frame from the guided multi-angle capture: the still (display +
 * re-detection on /measure only — never uploaded, never persisted) and
 * the pose prompt it was captured under, which /measure needs to pick the
 * right quality target and foreshortening correction.
 */
export interface CapturedFrame {
  dataUrl: string;
  pose: CapturePose;
  /**
   * Which capture flow produced the frame. /measure keys the motion
   * check and its status copy on this — a guided run whose turn angles
   * were both skipped is still a guided run (two front frames taken
   * seconds apart, moving between poses in between), and treating it as
   * a one-tap burst would apply the hold-still motion penalty to
   * movement the flow itself instructed.
   */
  source: "burst" | "guided";
}

/**
 * Which service line the fitting runs on. Mirrors `Population` in the
 * API's clinical engine (`lib/fitting/types.ts`) and the `population`
 * column on `fit_sessions` — the SPA sends this string verbatim.
 */
export type Population = "adult" | "pediatric";

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
  /**
   * The interface family, normalized to the legacy four
   * (`fullFace | nasal | nasalPillow | hybrid`). Carried so a fit
   * REQUEST can name the kind of mask the patient was shown without the
   * CSR opening the fitting record — the clinical path speaks
   * `interfaceType` (seven values) and the legacy path speaks `type`,
   * and `toLegacyMaskType` is what reconciles them at the call site.
   */
  maskType?: string | null;
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
  /**
   * Who the fitting is FOR — an adult or a child. Asked once at the head
   * of the questionnaire (see `PopulationGate`), because it is a property
   * of the SESSION rather than an answer about the patient's breathing:
   * it selects the plausibility windows, the tier-1 service-line filter
   * in the clinical engine, and the `population` column on the stored fit
   * session. `null` means "not asked yet" — the questionnaire refuses to
   * advance past the gate until it is set, so no engine is ever asked to
   * fit a face whose population we are guessing at.
   */
  population: Population | null;
  /**
   * The clinical fit session this fitting produced, when the clinical
   * path answered. Null on the legacy `/api/recommend` path, which
   * records no session at all — so a fit request from a legacy fitting
   * files with no session link, and that is accurate rather than a gap.
   */
  fitSessionId: string | null;
  /** Whether this tenant's invite resolved with the v2 questionnaire on. */
  fitProfileV2: boolean;
  /**
   * Whether this tenant runs the fitter in LEAD-CAPTURE mode
   * (`fitter.lead_capture_only`): the patient sees their recommendation
   * and asks the DME to take it from there, instead of self-submitting an
   * insurance order the DME never reviewed.
   *
   * Defaults to TRUE and fails soft to TRUE — a flag lookup that never
   * reached the tenant's row must not hand a patient the self-serve order
   * form. Only an explicit tenant opt-out turns it off.
   */
  leadCaptureOnly: boolean;
  /** Whether this tenant's invite resolved with guided multi-angle capture
   *  on (`fitter.multiframe_capture`). Off = the single-frame capture. */
  multiframeCapture: boolean;
  capturedImage: string | null; // Data URL for display purposes only. Never uploaded.
  /**
   * The guided capture's frame set (front + turns), memory only — like
   * `capturedImage`, never sessionStorage, never transmitted. /measure
   * re-detects landmarks on each and aggregates; it clears them the
   * moment the numbers are extracted. Null on the single-frame path.
   */
  capturedFrames: CapturedFrame[] | null;
  chosenMask: ChosenMask | null;
  /**
   * Email + marketing-consent captured at the start of the fitter flow
   * (on the /consent page). Downstream routes (/capture, /measure,
   * /questionnaire, /results, /order) refuse to render until the email
   * is set, so the email backs every recommendation the patient sees.
   * `emailConsent` is the OPTIONAL marketing opt-in — it does not gate
   * the flow (see useFitterConsentGate in App.tsx); its only consumer is
   * the marketing-gated completion ping in results.tsx.
   */
  email: string | null;
  emailConsent: boolean;
  /**
   * Whether the patient actually SUBMITTED the /consent step — the
   * affirmative camera/biometric checkbox, not merely having an email on
   * file. The two are distinct: a staff invite carries a known email, and
   * prefilling it must never stand in for the patient's own consent to
   * use their camera. Set ONLY by the consent page's Continue handler
   * (which requires the checkbox), and it is what gates every
   * camera-bearing route — see useFitterConsentGate in App.tsx.
   */
  cameraConsentGiven: boolean;
  /**
   * Signed token from a staff-initiated AI-fitter invite
   * (`/fitter-invite?t=…`). When present, the /results page transmits
   * the full fitting (measurements + answers + recommendation) back to
   * Penn Home Medical Supply via /shop/fitter-invite/complete so it can be attached to
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
  /** Drop the previous scan's persisted measurements + signals — called
   *  when a new capture is committed, so a reload mid-analysis can't
   *  resurrect the scan the patient just replaced. */
  clearMeasurements: () => void;
  updateAnswers: (answers: Partial<QuestionnaireAnswers>) => void;
  updateFitAnswers: (answers: FitAnswers) => void;
  /** Replace the WHOLE v2 answer set. The merge-based updater above can
   *  never delete a key, and pruning answers from abandoned branches is
   *  exactly a deletion. */
  replaceFitAnswers: (answers: FitAnswers) => void;
  /** `null` REOPENS the adult-or-child gate. The questionnaire's first
   *  Back does exactly that: a misclick on this one answer silently
   *  changes which masks are eligible, so it must be correctable
   *  without a full reset. */
  setPopulation: (value: Population | null) => void;
  setFitSessionId: (value: string | null) => void;
  setFitProfileV2: (on: boolean) => void;
  setLeadCaptureOnly: (on: boolean) => void;
  setMultiframeCapture: (on: boolean) => void;
  setCapturedImage: (image: string | null) => void;
  setCapturedFrames: (frames: CapturedFrame[] | null) => void;
  setChosenMask: (mask: ChosenMask | null) => void;
  setEmailConsent: (email: string, consent: boolean) => void;
  /** Record that the patient submitted /consent (the camera/biometric
   *  checkbox). Called only from that page's Continue handler. */
  setCameraConsentGiven: () => void;
  setInviteToken: (token: string | null) => void;
  /** Re-anchor the entry channel when a NEW invite resolves — see the
   *  implementation note in the provider. */
  setEntryPoint: (
    value: "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign" | null,
  ) => void;
  reset: () => void;
  /**
   * Clear the fitting DATA (photo, measurements, answers, chosen mask)
   * while keeping the patient's IDENTITY and invite context (email,
   * consent, invite token, tenant flags, entry point). This is what
   * "Start Over" means inside an invitation-only flow: a full `reset()`
   * there also wipes the invite token, and since every fitter route is
   * invite-gated the patient lands on "Invitation required" with no way
   * back in short of re-opening the original link.
   */
  resetForNewFitting: () => void;
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
 * Validated to the SERVER's contract, not loosely: the API's `scan`
 * schema is `.strict()` with per-field 0..1 ranges, so a stale or
 * hand-edited blob that merely LOOKED right used to be posted verbatim
 * and 400 the entire assessment — a dead end that survives retries,
 * because the bad blob is re-read on every attempt. Anything off-shape
 * degrades to "no signals" (the server's neutral default) instead.
 */
function readStoredScanSignals(): ScanSignalsPayload | null {
  try {
    const stored = sessionStorage.getItem(SCAN_SIGNALS_STORAGE_KEY);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return null;
    const r = parsed as Record<string, unknown>;
    if (r.band !== "high" && r.band !== "moderate" && r.band !== "low") {
      return null;
    }
    const unit = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!unit(r.measurementConfidence)) return null;
    if (
      typeof r.frameCount !== "number" ||
      !Number.isInteger(r.frameCount) ||
      r.frameCount < 1 ||
      r.frameCount > 10
    ) {
      return null;
    }
    const QUALITY_KEYS = [
      "lighting",
      "distance",
      "pose",
      "occlusion",
      "motion",
      "framing",
    ];
    const AGREEMENT_KEYS = [
      "noseWidth",
      "noseHeight",
      "noseToChin",
      "mouthWidth",
      "faceWidthAtCheekbones",
    ];
    const objectOfUnits = (
      value: unknown,
      allowedKeys: string[],
    ): value is Record<string, number> =>
      typeof value === "object" &&
      value !== null &&
      Object.entries(value).every(
        ([k, v]) => allowedKeys.includes(k) && unit(v),
      );
    if (!objectOfUnits(r.quality, QUALITY_KEYS)) return null;
    if (!objectOfUnits(r.agreement, AGREEMENT_KEYS)) return null;
    // Rebuild rather than pass through: an extra top-level key would
    // fail the server's `.strict()` even with every known field valid.
    return {
      frameCount: r.frameCount,
      quality: r.quality,
      agreement: r.agreement,
      measurementConfidence: r.measurementConfidence,
      band: r.band,
    } as ScanSignalsPayload;
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
  const [population, setPopulationState] = useState<Population | null>(() => {
    try {
      const stored = sessionStorage.getItem("fitter_population");
      return stored === "adult" || stored === "pediatric" ? stored : null;
    } catch {
      return null;
    }
  });
  const [fitSessionId, setFitSessionIdState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("fitter_fit_session_id");
    } catch {
      return null;
    }
  });
  // Fails soft to TRUE in both directions — an unreadable storage key and
  // an unresolvable flag both mean "we could not confirm this tenant lets
  // patients self-order", and the safe answer there is that they cannot.
  const [leadCaptureOnly, setLeadCaptureOnlyState] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("fitter_lead_capture_only") !== "0";
    } catch {
      return true;
    }
  });
  const [fitProfileV2, setFitProfileV2State] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("fitter_profile_v2") === "1";
    } catch {
      return false;
    }
  });
  const [multiframeCapture, setMultiframeCaptureState] = useState<boolean>(
    () => {
      try {
        return sessionStorage.getItem("fitter_multiframe") === "1";
      } catch {
        return false;
      }
    },
  );

  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  // Memory only, deliberately: persisting camera stills — even to
  // sessionStorage — would outlive the "discarded the moment your
  // measurements are extracted" promise the UI makes.
  const [capturedFrames, setCapturedFrames] = useState<CapturedFrame[] | null>(
    null,
  );

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
  // Deliberately its own key rather than inferred from `email`: a
  // patient mid-flow when this shipped has an email but no flag, and
  // re-showing them the consent step is the safe direction.
  const [cameraConsentGiven, setCameraConsentGivenState] = useState<boolean>(
    () => {
      try {
        return sessionStorage.getItem("fitter_camera_consent") === "1";
      } catch {
        return false;
      }
    },
  );

  // Staff-invite token. Persisted in sessionStorage so it survives the
  // multi-page fitter flow (and a mid-flow refresh) and is still
  // available on /results to transmit the completed fitting.
  const [entryPoint, setEntryPointState] = useState<
    "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign" | null
  >(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("entry");
    const fromUrl =
      raw === "in_office" ||
      raw === "kiosk_qr" ||
      raw === "remote_link" ||
      raw === "refit_campaign"
        ? raw
        : null;
    // Persisted like every other flow field: the `entry` param only exists
    // on the landing URL, so without this a mid-flow refresh silently
    // drops the channel and the fitting is recorded under the server's
    // `remote_link` default — mislabelling kiosk and refit-campaign
    // fittings in the by-channel outcome reporting.
    try {
      if (fromUrl) {
        sessionStorage.setItem("fitter_entry_point", fromUrl);
        return fromUrl;
      }
      const stored = sessionStorage.getItem("fitter_entry_point");
      return stored === "in_office" ||
        stored === "kiosk_qr" ||
        stored === "remote_link" ||
        stored === "refit_campaign"
        ? stored
        : null;
    } catch {
      return fromUrl;
    }
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

  const replaceFitAnswers = (next: FitAnswers) => {
    setFitAnswers(next);
    try {
      sessionStorage.setItem("fitter_fit_answers", JSON.stringify(next));
    } catch (e) {
      console.error("Failed to save fit answers to sessionStorage", e);
    }
  };

  const setPopulation = (value: Population | null) => {
    setPopulationState(value);
    try {
      if (value) sessionStorage.setItem("fitter_population", value);
      else sessionStorage.removeItem("fitter_population");
    } catch (e) {
      console.error("Failed to persist fitting population", e);
    }
  };

  const setFitSessionId = (value: string | null) => {
    setFitSessionIdState(value);
    try {
      if (value) sessionStorage.setItem("fitter_fit_session_id", value);
      else sessionStorage.removeItem("fitter_fit_session_id");
    } catch (e) {
      console.error("Failed to persist fit session id", e);
    }
  };

  const setLeadCaptureOnly = (on: boolean) => {
    setLeadCaptureOnlyState(on);
    try {
      // Only the OPT-OUT is written. An absent key reads as "on", which
      // keeps the fail-soft default aligned with the initializer above.
      if (on) sessionStorage.removeItem("fitter_lead_capture_only");
      else sessionStorage.setItem("fitter_lead_capture_only", "0");
    } catch (e) {
      console.error("Failed to persist lead-capture flag", e);
    }
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

  const setMultiframeCapture = (on: boolean) => {
    setMultiframeCaptureState(on);
    try {
      if (on) sessionStorage.setItem("fitter_multiframe", "1");
      else sessionStorage.removeItem("fitter_multiframe");
    } catch (e) {
      console.error("Failed to persist multiframe capture flag", e);
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

  const setCameraConsentGiven = () => {
    setCameraConsentGivenState(true);
    try {
      sessionStorage.setItem("fitter_camera_consent", "1");
    } catch (e) {
      console.error("Failed to persist fitter camera consent", e);
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

  /**
   * Re-anchor the entry channel when a NEW invite is resolved. The
   * persisted value exists so a mid-flow refresh keeps its channel — but
   * opening a fresh invite in the same tab must not inherit the PREVIOUS
   * fitting's channel: an ordinary remote invite following a kiosk or
   * refit-campaign fitting would otherwise be recorded under the stale
   * channel. Null means "no channel hint" (the server default applies).
   */
  const setEntryPoint = (
    value: "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign" | null,
  ) => {
    setEntryPointState(value);
    try {
      if (value) sessionStorage.setItem("fitter_entry_point", value);
      else sessionStorage.removeItem("fitter_entry_point");
    } catch (e) {
      console.error("Failed to persist fitter entry point", e);
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

  /**
   * Invalidate the previous scan the moment a NEW capture is committed.
   * The photo lives in memory only, but the measurements it produced are
   * persisted — so a reload during the retake's analysis used to lose
   * the new photo, rehydrate the OLD measurements, and silently forward
   * the patient with the scan they had just chosen to replace. Called at
   * capture-commit time (not when a retake button is clicked, which
   * would un-gate the flow behind the Back button).
   */
  const clearMeasurements = () => {
    setMeasurementsState(null);
    setScanSignalsState(null);
    try {
      sessionStorage.removeItem(MEASUREMENTS_STORAGE_KEY);
      sessionStorage.removeItem(SCAN_SIGNALS_STORAGE_KEY);
    } catch {
      // Storage unusable — nothing was persisted, nothing to clear.
    }
  };

  /** Clear the fitting DATA but keep identity + invite context. */
  const resetForNewFitting = () => {
    setMeasurementsState(null);
    setScanSignalsState(null);
    setAnswers({});
    setFitAnswers({});
    // The population is an ANSWER about this fitting, not identity — a
    // "Start Over" that kept it would silently carry an adult session's
    // service line into a re-fit that a parent started for their child.
    setPopulationState(null);
    // Belongs to the fitting that just ended, not to the next one.
    setFitSessionIdState(null);
    setCapturedImage(null);
    setCapturedFrames(null);
    setChosenMaskState(null);
    try {
      sessionStorage.removeItem("fitter_answers");
      sessionStorage.removeItem("fitter_fit_answers");
      sessionStorage.removeItem("fitter_population");
      sessionStorage.removeItem("fitter_fit_session_id");
      sessionStorage.removeItem("fitter_chosen_mask");
      sessionStorage.removeItem(MEASUREMENTS_STORAGE_KEY);
      sessionStorage.removeItem(SCAN_SIGNALS_STORAGE_KEY);
    } catch {
      // Storage unusable — nothing was persisted, nothing to clear.
    }
  };

  const reset = () => {
    resetForNewFitting();
    setFitProfileV2State(false);
    // Back to the fail-soft default, not to `false`: a fresh invite that
    // never resolves must not leave the previous tenant's opt-out behind.
    setLeadCaptureOnlyState(true);
    setMultiframeCaptureState(false);
    setEmail(null);
    setEmailConsentState(false);
    // A different patient (a new invite in this tab, a shared kiosk)
    // must give their OWN camera consent — never inherit the last
    // patient's. `resetForNewFitting` deliberately keeps it: that is the
    // same patient re-scanning within one consented session.
    setCameraConsentGivenState(false);
    setInviteTokenState(null);
    // Clear the in-memory channel along with its storage key below — a
    // later fitting in the same tab must not inherit this one's channel.
    setEntryPointState(null);
    try {
      // Measurements + scan signals were already cleared by
      // resetForNewFitting() above (via the storage-key constants).
      sessionStorage.removeItem("fitter_profile_v2");
      sessionStorage.removeItem("fitter_lead_capture_only");
      sessionStorage.removeItem("fitter_multiframe");
      sessionStorage.removeItem("fitter_email");
      sessionStorage.removeItem("fitter_email_consent");
      sessionStorage.removeItem("fitter_camera_consent");
      sessionStorage.removeItem("fitter_invite_token");
      sessionStorage.removeItem("fitter_entry_point");
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
        population,
        fitSessionId,
        fitProfileV2,
        leadCaptureOnly,
        multiframeCapture,
        capturedImage,
        capturedFrames,
        chosenMask,
        email,
        emailConsent,
        cameraConsentGiven,
        inviteToken,
        entryPoint,
        storagePersisted,
        setMeasurements,
        clearMeasurements,
        updateAnswers,
        updateFitAnswers,
        replaceFitAnswers,
        setPopulation,
        setFitSessionId,
        setFitProfileV2,
        setLeadCaptureOnly,
        setMultiframeCapture,
        setCapturedImage,
        setCapturedFrames,
        setChosenMask,
        setEmailConsent,
        setCameraConsentGiven,
        setInviteToken,
        setEntryPoint,
        reset,
        resetForNewFitting,
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
