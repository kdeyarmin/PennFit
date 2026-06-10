// Patient packet document content layer.
//
// Bridges the code-defined templates (templates.ts) and the two levels
// of operator editing introduced by migration 0301:
//
//   * PERMANENT edits — one patient_packet_template_overrides row per
//     document key. The override's structured sections replace the code
//     default for every packet sent afterwards. Deleting the row
//     reverts to the code default.
//   * TEMPORARY (per-packet) edits — at send time the effective
//     sections (default or override, plus any one-off edit for that
//     packet alone) are snapshotted onto
//     patient_packet_documents.content_sections, so a later template
//     edit never rewrites what a patient saw or signed.
//
// Editable content is stored in TOKEN form: strings may carry
// {{merge_tokens}} (company name/phone/…, patient name, today's date)
// that are substituted at render time from app data. The code defaults
// are converted to token form mechanically by building each template
// with a token-bearing CompanyProfile — so the operator's editor shows
// {{company_name}} exactly where the code interpolates the legal name,
// and a renamed organization flows into customized documents too.
//
// Content stays structured (headings / paragraphs / bullets — never
// HTML), preserving the no-markup-injection property of the signing UI.

import { z } from "zod";

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  buildDeliveryDetailSections,
  getPacketTemplate,
  PROOF_OF_DELIVERY_KEY,
  type CompanyProfile,
  type DeliveryDetails,
  type PacketDocumentSection,
} from "./templates";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

// ── Merge tokens ──────────────────────────────────────────────────

/** Everything a token can resolve from at render time. */
export interface MergeTokenContext {
  company: CompanyProfile;
  /** The packet's snapshotted recipient (the patient or contact). */
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  /** Injectable for deterministic tests. Defaults to now. */
  now?: Date;
}

interface MergeTokenDef {
  token: string;
  label: string;
  resolve: (ctx: MergeTokenContext) => string;
}

const MERGE_TOKEN_DEFS: readonly MergeTokenDef[] = [
  {
    token: "company_name",
    label: "Company legal name",
    resolve: (c) => c.company.legalName,
  },
  {
    token: "company_phone",
    label: "Company phone",
    resolve: (c) => c.company.phone,
  },
  {
    token: "company_email",
    label: "Company email",
    resolve: (c) => c.company.email,
  },
  {
    token: "company_address",
    label: "Company street address",
    resolve: (c) => c.company.addressLine1,
  },
  {
    token: "company_city_state_zip",
    label: "Company city/state/ZIP",
    resolve: (c) => c.company.cityStateZip,
  },
  {
    token: "company_npi",
    label: "Company NPI",
    resolve: (c) => c.company.npi ?? "",
  },
  {
    token: "patient_name",
    label: "Patient / recipient name",
    resolve: (c) => c.recipientName?.trim() || "the patient",
  },
  {
    token: "patient_first_name",
    label: "Patient first name",
    resolve: (c) =>
      (c.recipientName?.trim().split(/\s+/u)[0] ?? "") || "the patient",
  },
  {
    token: "patient_email",
    label: "Patient email on the packet",
    resolve: (c) => c.recipientEmail ?? "",
  },
  {
    token: "patient_phone",
    label: "Patient phone on the packet",
    resolve: (c) => c.recipientPhone ?? "",
  },
  {
    token: "today",
    label: "Today's date",
    resolve: (c) =>
      (c.now ?? new Date()).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
  },
];

const MERGE_TOKEN_BY_NAME = new Map(MERGE_TOKEN_DEFS.map((d) => [d.token, d]));

/** Token catalog for the admin editor's helper UI. */
export function listMergeTokens(): Array<{ token: string; label: string }> {
  return MERGE_TOKEN_DEFS.map((d) => ({ token: d.token, label: d.label }));
}

const TOKEN_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/giu;

/** Substitute every known {{token}} in one string. Unknown tokens are
 *  left verbatim (saves reject them, but legacy data must never crash
 *  a render). */
export function substituteTokens(text: string, ctx: MergeTokenContext): string {
  return text.replace(TOKEN_PATTERN, (whole, name: string) => {
    const def = MERGE_TOKEN_BY_NAME.get(name.toLowerCase());
    return def ? def.resolve(ctx) : whole;
  });
}

/** Every unknown {{token}} mentioned anywhere in the sections — used by
 *  the save routes to reject typos with an actionable message. */
export function findUnknownTokens(sections: PacketDocumentSection[]): string[] {
  const unknown = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(TOKEN_PATTERN)) {
      const name = m[1]!.toLowerCase();
      if (!MERGE_TOKEN_BY_NAME.has(name)) unknown.add(name);
    }
  };
  for (const s of sections) {
    if (s.heading) scan(s.heading);
    for (const p of s.paragraphs ?? []) scan(p);
    for (const b of s.bullets ?? []) scan(b);
  }
  return [...unknown];
}

// ── Section schema (shared by the save + send routes) ─────────────

export const packetSectionSchema = z
  .object({
    heading: z.string().trim().max(200).optional(),
    paragraphs: z.array(z.string().trim().min(1).max(4000)).max(30).optional(),
    bullets: z.array(z.string().trim().min(1).max(1500)).max(40).optional(),
  })
  .strict()
  .refine(
    (s) =>
      Boolean(s.heading) ||
      (s.paragraphs?.length ?? 0) > 0 ||
      (s.bullets?.length ?? 0) > 0,
    { message: "A section needs a heading, a paragraph, or a bullet." },
  );

export const packetSectionsSchema = z.array(packetSectionSchema).min(1).max(60);

/** Tolerant parse of sections persisted as jsonb. Returns null when the
 *  stored value doesn't look like sections (render then falls back to
 *  the code template). */
export function parseStoredSections(
  raw: unknown,
): PacketDocumentSection[] | null {
  const parsed = packetSectionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ── Code defaults in token form ───────────────────────────────────

// Building a template with this profile converts its interpolations to
// merge tokens mechanically — the single source of truth for default
// wording stays templates.ts.
const TOKEN_COMPANY: CompanyProfile = {
  legalName: "{{company_name}}",
  phone: "{{company_phone}}",
  email: "{{company_email}}",
  addressLine1: "{{company_address}}",
  cityStateZip: "{{company_city_state_zip}}",
  npi: "{{company_npi}}",
};

/** The code default for a document, in editable token form. The Proof
 *  of Delivery's dynamic itemization is intentionally absent — it is
 *  spliced back in at render time (see renderPacketDocumentSections). */
export function defaultTemplateSections(
  documentKey: string,
): PacketDocumentSection[] {
  const t = getPacketTemplate(documentKey);
  return t ? t.build(TOKEN_COMPANY) : [];
}

// ── Permanent overrides ───────────────────────────────────────────

export interface TemplateOverrideRow {
  document_key: string;
  title: string;
  sections: unknown;
  revision: number;
  updated_by_email: string | null;
  updated_at: string;
}

export async function loadTemplateOverrides(
  supabase: SupabaseClient,
): Promise<Map<string, TemplateOverrideRow>> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_packet_template_overrides")
    .select(
      "document_key, title, sections, revision, updated_by_email, updated_at",
    );
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.document_key, r]));
}

export interface EffectiveTemplateContent {
  title: string;
  /** Token-form sections — the effective editable content. */
  sections: PacketDocumentSection[];
  /** Version string snapshotted onto packets (records the revision). */
  version: string;
  customized: boolean;
}

/** The effective content for a document key: the operator's permanent
 *  override when one exists (and parses), else the code default. */
export function effectiveTemplateContent(
  documentKey: string,
  overrides: Map<string, TemplateOverrideRow>,
): EffectiveTemplateContent | null {
  const t = getPacketTemplate(documentKey);
  if (!t) return null;
  const override = overrides.get(documentKey);
  if (override) {
    const sections = parseStoredSections(override.sections);
    if (sections) {
      return {
        title: override.title,
        sections,
        version: `${t.version}+custom.r${override.revision}`,
        customized: true,
      };
    }
  }
  return {
    title: t.title,
    sections: defaultTemplateSections(documentKey),
    version: t.version,
    customized: false,
  };
}

// ── Rendering ─────────────────────────────────────────────────────

export interface RenderPacketDocumentInput {
  documentKey: string;
  /** The send-time snapshot (token form), or null on legacy rows. */
  storedSections: unknown;
  company: CompanyProfile;
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  deliveryDetails?: DeliveryDetails | null;
  now?: Date;
}

/**
 * Render a packet document's final sections for the signing UI and the
 * signed PDF (the two must stay identical). Snapshot rows substitute
 * merge tokens from app data; legacy rows (no snapshot) build from the
 * code template exactly as before. For the Proof of Delivery the
 * CMS-required itemization is spliced in after the opening section so
 * an operator edit to the wording can never drop the item list.
 */
export function renderPacketDocumentSections(
  input: RenderPacketDocumentInput,
): PacketDocumentSection[] {
  const stored = parseStoredSections(input.storedSections);
  const ctx: MergeTokenContext = {
    company: input.company,
    recipientName: input.recipientName,
    recipientEmail: input.recipientEmail,
    recipientPhone: input.recipientPhone,
    now: input.now,
  };
  if (!stored) {
    const t = getPacketTemplate(input.documentKey);
    return t
      ? t.build(input.company, {
          deliveryDetails: input.deliveryDetails ?? null,
        })
      : [];
  }
  const resolved = stored.map((s) => ({
    ...(s.heading ? { heading: substituteTokens(s.heading, ctx) } : {}),
    ...(s.paragraphs
      ? { paragraphs: s.paragraphs.map((p) => substituteTokens(p, ctx)) }
      : {}),
    ...(s.bullets
      ? { bullets: s.bullets.map((b) => substituteTokens(b, ctx)) }
      : {}),
  }));
  if (input.documentKey === PROOF_OF_DELIVERY_KEY) {
    const dynamic = buildDeliveryDetailSections(input.deliveryDetails ?? null);
    if (dynamic.length > 0) {
      return [...resolved.slice(0, 1), ...dynamic, ...resolved.slice(1)];
    }
  }
  return resolved;
}
