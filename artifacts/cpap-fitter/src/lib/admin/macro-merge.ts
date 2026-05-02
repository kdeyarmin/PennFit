// Merge-field substitution for CSR macros.
//
// Tokens are {{namespace.key}} and resolve from a flat lookup table
// passed in by the caller (the conversation detail page already has
// the patient + episode context loaded). Unresolved tokens fall back
// to a sensible default ("there" for first names, today's date for
// timestamps, etc) rather than leaking the raw {{token}} into the
// outgoing message.
//
// PHI safety: substitution happens client-side using data already on
// screen. The macro body itself is patient-agnostic; only the
// rendered output contains patient-specific text, and that output is
// the same payload the CSR was about to type by hand.

export interface MacroContext {
  patient?: {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
  };
  episode?: {
    dueDate?: Date | string | null;
    itemsList?: string | null;
  };
  rep?: {
    firstName?: string | null;
  };
}

const FALLBACKS: Record<string, string> = {
  "patient.firstName": "there",
  "patient.lastName": "",
  "patient.fullName": "there",
  "episode.dueDate": formatDate(new Date()),
  "episode.itemsList": "your supplies",
  "rep.firstName": "the team",
};

const RE = /\{\{\s*([a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g;

export function applyMacro(body: string, ctx: MacroContext): string {
  return body.replace(RE, (_match, token: string) => {
    const resolved = resolve(token, ctx);
    if (resolved !== null) return resolved;
    // Legacy `{firstName}` is also supported in case any historical
    // body slipped through; the regex above only matches double-brace,
    // so legacy single-brace bodies fall through to a separate pass.
    return FALLBACKS[token] ?? "";
  });
}

function resolve(token: string, ctx: MacroContext): string | null {
  switch (token) {
    case "patient.firstName": {
      const v = ctx.patient?.firstName?.trim();
      return v && v.length > 0 ? v : null;
    }
    case "patient.lastName": {
      const v = ctx.patient?.lastName?.trim();
      return v && v.length > 0 ? v : null;
    }
    case "patient.fullName": {
      const explicit = ctx.patient?.fullName?.trim();
      if (explicit && explicit.length > 0) return explicit;
      const composed = [ctx.patient?.firstName, ctx.patient?.lastName]
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .join(" ")
        .trim();
      return composed.length > 0 ? composed : null;
    }
    case "episode.dueDate": {
      const v = ctx.episode?.dueDate;
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? null : formatDate(d);
    }
    case "episode.itemsList": {
      const v = ctx.episode?.itemsList?.trim();
      return v && v.length > 0 ? v : null;
    }
    case "rep.firstName": {
      const v = ctx.rep?.firstName?.trim();
      return v && v.length > 0 ? v : null;
    }
    case "date.today":
      return formatDate(new Date());
    case "date.tomorrow": {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return formatDate(d);
    }
    default:
      return null;
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Apply legacy `{firstName}` substitution as a separate pass, for
 * backwards compatibility with bodies authored before the
 * {{namespace.key}} migration.
 */
export function applyLegacyFirstName(body: string, firstName: string): string {
  const safe = firstName.trim() || "there";
  return body.replaceAll("{firstName}", safe);
}
