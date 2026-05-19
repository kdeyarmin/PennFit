// Compact EN/ES language toggle for the customer-facing header.
//
// Why a button (not a select)
// ---------------------------
// We support exactly two locales today. A two-option dropdown is
// more clicks than a single-tap pill toggle for the same outcome.
// If we add more locales later, the same component can grow into
// a dropdown without touching the call sites.

import { Globe } from "lucide-react";

import { useTranslation } from "@/i18n/provider";
import { LOCALE_LABEL, SUPPORTED_LOCALES, type Locale } from "@/i18n/locales";

export function LanguageToggle({
  variant = "default",
}: {
  variant?: "default" | "compact";
}) {
  const { locale, setLocale, t } = useTranslation();
  const next: Locale =
    locale === "en" ? "es" : SUPPORTED_LOCALES[0]!;

  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      aria-label={t("common.changeLanguage")}
      title={t("common.changeLanguage")}
      data-testid="language-toggle"
      className={
        variant === "compact"
          ? "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium glass-panel border-0 hover:opacity-80 transition-opacity"
          : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium glass-panel border-0 hover:opacity-80 transition-opacity"
      }
    >
      <Globe className="h-3.5 w-3.5" />
      <span className="tabular-nums tracking-wide uppercase">{locale}</span>
      <span className="sr-only">— {LOCALE_LABEL[locale]}</span>
    </button>
  );
}
