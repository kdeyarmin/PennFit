// Translation dictionaries for PennFit's customer surfaces.
//
// Why hand-rolled (no i18next)
// ----------------------------
// The customer-facing app has ~20 user-visible strings on the pages
// most likely to land a Spanish speaker (home hero, track-order,
// insurance estimator, language toggle, banner copy). A library like
// react-i18next is the right answer for hundreds of strings + plural
// rules + RTL — but for this scope it's heavier than the problem.
// A flat dictionary + a useTranslation() hook covers the surface
// area today and the same shape can absorb a library swap later
// without touching call sites.
//
// Add-key contract
// ----------------
// Every new key MUST be added to BOTH `en` and `es` at the same
// time. The Translations type forces a compile error when the two
// drift — the keyof of `en` IS the union of valid t() keys, and `es`
// is typed as `Record<TranslationKey, string>` so a missing key
// surfaces at build time, not at runtime.
//
// English text is the source of truth — translators work from `en`
// to `es`. Existing strings in `es` are AI-drafted + safe for general
// product copy; before a real Spanish-speaking market launch, get
// these reviewed by a native speaker.

export type Locale = "en" | "es";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "es"];

/** Localized label for the language switcher button. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  es: "Español",
};

const en = {
  // ── Generic UI ──────────────────────────────────────────────────
  "common.languageToggle": "Language",
  "common.changeLanguage": "Change language",

  // ── Home hero ───────────────────────────────────────────────────
  "home.eyebrow": "PennPaps CPAP supplier — at-home mask fitting",
  "home.headline": "Find the right CPAP mask without a clinic visit",
  "home.subhead":
    "Snap a quick photo, get a mask fit to your face in 2 minutes, and have it shipped — covered by most insurance.",
  "home.ctaPrimary": "Start at-home mask fitting",
  "home.ctaSecondary": "Check insurance coverage",

  // ── Track-order page (public, no login) ─────────────────────────
  "track.badge": "Order status",
  "track.headline": "Track my order",
  "track.intro":
    "Enter your PennPaps order reference (from your confirmation email) and the email you used to place it. No login needed.",
  "track.formTitle": "Order lookup",
  "track.formSubtitleAccountPrefix": "For full order history, sign in to",
  "track.formSubtitleAccountLink": "your account",
  "track.fieldReference": "Order reference",
  "track.fieldEmail": "Email on the order",
  "track.submit": "Look up my order",
  "track.submitting": "Looking up…",
  "track.lookupAnother": "Look up another order",
  "track.errorNotFound":
    "We couldn't find that order. Double-check the reference and the email match.",
  "track.errorRateLimited":
    "Too many attempts. Please wait a few minutes and try again.",
  "track.errorGeneric":
    "Something went wrong. Please try again in a moment.",
  "track.resultLabelStatus": "Status",
  "track.resultLabelReference": "Reference",
  "track.resultLabelMask": "Mask",
  "track.resultLabelSubmitted": "Submitted",

  // ── Order-status descriptors (parallel to formatStatus) ─────────
  "track.statusReceived.label": "Received",
  "track.statusReceived.description":
    "Our fulfillment team has your order. A team member contacts you within 1 business day.",
  "track.statusProcessing.label": "Processing",
  "track.statusProcessing.description":
    "Order received. Awaiting confirmation from our team.",
  "track.statusDeliveryIssue.label": "Delivery issue",
  "track.statusDeliveryIssue.description":
    "We hit a snag forwarding your order. Please call us or reply to your confirmation email.",
} as const;

export type TranslationKey = keyof typeof en;

const es: Record<TranslationKey, string> = {
  "common.languageToggle": "Idioma",
  "common.changeLanguage": "Cambiar idioma",

  "home.eyebrow": "PennPaps proveedor de CPAP — ajuste de mascarilla en casa",
  "home.headline":
    "Encuentre la mascarilla CPAP correcta sin ir a la clínica",
  "home.subhead":
    "Tome una foto rápida, obtenga una mascarilla ajustada a su rostro en 2 minutos, y reciba su envío — cubierto por la mayoría de los seguros.",
  "home.ctaPrimary": "Comenzar ajuste de mascarilla en casa",
  "home.ctaSecondary": "Verificar cobertura del seguro",

  "track.badge": "Estado del pedido",
  "track.headline": "Rastrear mi pedido",
  "track.intro":
    "Ingrese su referencia de pedido de PennPaps (del correo de confirmación) y el correo electrónico que usó al realizarlo. No necesita iniciar sesión.",
  "track.formTitle": "Búsqueda de pedido",
  "track.formSubtitleAccountPrefix":
    "Para el historial completo de pedidos, inicie sesión en",
  "track.formSubtitleAccountLink": "su cuenta",
  "track.fieldReference": "Referencia del pedido",
  "track.fieldEmail": "Correo electrónico del pedido",
  "track.submit": "Buscar mi pedido",
  "track.submitting": "Buscando…",
  "track.lookupAnother": "Buscar otro pedido",
  "track.errorNotFound":
    "No encontramos ese pedido. Verifique que la referencia y el correo electrónico coincidan.",
  "track.errorRateLimited":
    "Demasiados intentos. Espere unos minutos y vuelva a intentarlo.",
  "track.errorGeneric": "Algo salió mal. Intente de nuevo en un momento.",
  "track.resultLabelStatus": "Estado",
  "track.resultLabelReference": "Referencia",
  "track.resultLabelMask": "Mascarilla",
  "track.resultLabelSubmitted": "Enviado",

  "track.statusReceived.label": "Recibido",
  "track.statusReceived.description":
    "Nuestro equipo de envíos tiene su pedido. Un miembro del equipo lo contactará dentro de 1 día hábil.",
  "track.statusProcessing.label": "Procesando",
  "track.statusProcessing.description":
    "Pedido recibido. Esperando confirmación de nuestro equipo.",
  "track.statusDeliveryIssue.label": "Problema de entrega",
  "track.statusDeliveryIssue.description":
    "Hubo un problema al procesar su pedido. Llámenos o responda al correo de confirmación.",
};

export const TRANSLATIONS: Record<Locale, Record<TranslationKey, string>> = {
  en,
  es,
};
