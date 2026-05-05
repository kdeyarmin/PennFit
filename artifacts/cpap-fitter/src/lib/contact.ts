// Customer-facing support contact details. Centralized so the
// floating chat launcher, footer contact column, and any inline
// "have a question?" links all stay in lockstep.
//
// PLACEHOLDER values — production deployer should overwrite these
// (or wire them to env vars) before launch. Keeping them in code
// rather than env so they ship with the static SPA bundle and
// don't need a server round-trip on every page load.

/** US support phone, E.164-style for tel: links and dashed for display. */
export const SUPPORT_PHONE_E164 = "+18005550100";
export const SUPPORT_PHONE_DISPLAY = "1 (800) 555-0100";

/** Customer-service mailbox. Distinct from info@pennpaps.com which
 *  is the legal/privacy contact. */
export const SUPPORT_EMAIL = "support@pennpaps.com";

/** Business hours blurb. Plain English, displayed under the phone
 *  in the footer + floating launcher. */
export const SUPPORT_HOURS = "Mon–Fri 8a–6p ET";
