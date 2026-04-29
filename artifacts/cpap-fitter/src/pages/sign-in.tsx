import { SignIn } from "@clerk/react";
import { useDocumentTitle } from "@/hooks/use-document-title";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Pull a `?redirect=` target out of the current URL. We use this to
 * support BOTH the admin flow (legacy `/admin` destination) and the
 * patient flow (return-to-where-I-was). The query string is read at
 * render time — Clerk handles the rest of the auth dance and lands
 * the user at this URL on success.
 *
 * Validation: only allow same-origin paths starting with `/`. This
 * prevents an open-redirect (`?redirect=https://evil.com`) and also
 * rejects empty / accidental absolute URLs.
 */
function readRedirect(): string {
  if (typeof window === "undefined") return `${basePath}/admin`;
  const usp = new URLSearchParams(window.location.search);
  const raw = usp.get("redirect");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) {
    // The Wouter base path is already on the page; redirect targets
    // come in as Wouter-relative (e.g. "/account"). Make them
    // browser-absolute by prepending basePath, but don't double up
    // when the caller already prepended.
    if (basePath && raw.startsWith(basePath)) return raw;
    return `${basePath}${raw}`;
  }
  return `${basePath}/admin`;
}

export function SignInPage() {
  useDocumentTitle("Sign in");
  const redirectUrl = readRedirect();
  return (
    <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-12">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up?redirect=${encodeURIComponent(
          redirectUrl.startsWith(basePath)
            ? redirectUrl.slice(basePath.length) || "/"
            : redirectUrl,
        )}`}
        forceRedirectUrl={redirectUrl}
      />
    </div>
  );
}
