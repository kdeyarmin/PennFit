// Inline company-contact fragments for prose and link contexts.
//
// Pages that keep their copy in module-level data arrays (FAQ, learn,
// legal pages) can't call `useCompanyContact()` at array-build time —
// the array is constructed once at import, before the company-info
// fetch lands. Embedding these tiny components instead defers the
// read to render time, so the admin-saved values show up everywhere.

import { useCompanyContact } from "@/lib/contact";

/** The support phone as plain text, e.g. "(814) 471-0627". */
export function SupportPhoneText() {
  const c = useCompanyContact();
  return <>{c.phoneDisplay}</>;
}

/** The support mailbox as plain text. */
export function SupportEmailText() {
  const c = useCompanyContact();
  return <>{c.email}</>;
}

/** The support phone as a tel: link. */
export function SupportPhoneLink({ className }: { className?: string }) {
  const c = useCompanyContact();
  return (
    <a className={className} href={`tel:${c.phoneE164}`}>
      {c.phoneDisplay}
    </a>
  );
}

/** The support mailbox as a mailto: link. */
export function SupportEmailLink({ className }: { className?: string }) {
  const c = useCompanyContact();
  return (
    <a className={className} href={`mailto:${c.email}`}>
      {c.email}
    </a>
  );
}

/** The legal/privacy mailbox as a mailto: link (privacy + terms). */
export function GeneralEmailLink({ className }: { className?: string }) {
  const c = useCompanyContact();
  return (
    <a className={className} href={`mailto:${c.generalEmail}`}>
      {c.generalEmail}
    </a>
  );
}
