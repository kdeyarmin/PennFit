// Customer-facing support contact details. Centralized so the
// floating chat launcher, footer contact column, and any inline
// "have a question?" links all stay in lockstep.
//
// Keeping them in code rather than env so they ship with the
// static SPA bundle and don't need a server round-trip on every
// page load.

/** Penn Home Medical Supply support phone, E.164-style for tel:
 *  links and dashed for display. */
export const SUPPORT_PHONE_E164 = "+18144710627";
export const SUPPORT_PHONE_DISPLAY = "(814) 471-0627";

/** Customer-service mailbox. Distinct from info@pennpaps.com which
 *  is the legal/privacy contact. */
export const SUPPORT_EMAIL = "support@pennpaps.com";

/** Business hours blurb. Plain English, displayed under the phone
 *  in the footer + floating launcher. */
export const SUPPORT_HOURS = "Mon–Fri 9a–5p ET";
