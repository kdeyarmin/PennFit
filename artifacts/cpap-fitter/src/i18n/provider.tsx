// TranslationProvider + useTranslation() — minimal in-house i18n.
//
// Design
// ------
// Just enough to swap the user-visible strings on the surfaces we've
// localized today (home hero, /track-order, language toggle). The
// shape mirrors what react-i18next exposes (`t(key)` + a current
// locale) so a future swap to that library is a mechanical
// search-and-replace, not a rewrite.
//
// Locale detection order:
//   1. localStorage `pf_locale` — persists the user's explicit
//      choice across sessions / refreshes.
//   2. `navigator.language` first 2 chars when it's a supported
//      Locale.
//   3. Default to "en".
//
// SSR / non-browser safety
// ------------------------
// We default to "en" when `window` or `localStorage` aren't
// available, then re-derive on mount. That keeps the initial paint
// stable for any future SSR pass and avoids a hydration mismatch.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  SUPPORTED_LOCALES,
  TRANSLATIONS,
  type Locale,
  type TranslationKey,
} from "./locales";

const STORAGE_KEY = "pf_locale";

interface TranslationContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TranslationKey) => string;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
      return stored as Locale;
    }
  } catch {
    // localStorage access can throw in private browsing.
  }
  const browser = (navigator.language ?? "en").slice(0, 2).toLowerCase();
  if ((SUPPORTED_LOCALES as readonly string[]).includes(browser)) {
    return browser as Locale;
  }
  return "en";
}

export function TranslationProvider({ children }: { children: ReactNode }) {
  // SSR-safe default; re-detect on mount.
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(detectInitialLocale());
  }, []);

  // Sync the <html lang> attribute so screen readers + browser
  // translation features pick up the active locale.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", locale);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persistence is a nice-to-have; failure is silent.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      const dict = TRANSLATIONS[locale];
      // Falling back to English when a key is missing in the active
      // locale ensures we never render a raw key to the user, even
      // mid-rollout when a new key has been added to en but not es.
      return dict[key] ?? TRANSLATIONS.en[key] ?? String(key);
    },
    [locale],
  );

  const value = useMemo<TranslationContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return (
    <TranslationContext.Provider value={value}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslation(): TranslationContextValue {
  const ctx = useContext(TranslationContext);
  if (!ctx) {
    // We render OUTSIDE the provider in two cases: rendering tests
    // that don't wrap in TranslationProvider, and any future widget
    // that opts out of the provider. Return a passthrough that
    // surfaces the English string so the call site still gets
    // something usable.
    return {
      locale: "en",
      setLocale: () => {
        /* noop */
      },
      t: (key) => TRANSLATIONS.en[key] ?? String(key),
    };
  }
  return ctx;
}
