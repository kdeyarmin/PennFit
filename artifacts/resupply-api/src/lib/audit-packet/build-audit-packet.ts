// Audit-packet orchestrator.
//
// Given an operator's selection of catalog items + the data/documents already
// resolved for them, produce ONE audit-response PDF: a cover sheet + table of
// contents, the system-generated summaries (adherence, equipment, claim,
// continued use, replacement schedule), and the stored chart documents, in
// catalog (print) order. The route does all the DB / object-storage I/O and
// hands resolved data in here; this module is pure PDF composition so it can
// be unit-tested with synthetic buffers.
//
// Missing on-file items are NOT rendered as "missing" pages — advertising a
// gap to an auditor is the opposite of helpful. They are reported back in
// `items` so the operator can see, before sending, exactly which selected
// documents had nothing on file.

import {
  type AuditPacketItem,
  type AuditScope,
  normalizeSelection,
} from "@workspace/resupply-domain";

import { assemblePacket, type PacketPart, type SkippedPart } from "./assemble";
import { type Block, renderPdfPage } from "./sections";

export interface AuditPacketCompany {
  legalName: string;
  npi?: string | null;
  addressLines?: string[];
  phone?: string | null;
}

export interface AuditPacketPatient {
  name: string;
  dateOfBirth?: string | null;
  memberId?: string | null;
}

export interface AuditPacketClaimContext {
  claimNumber?: string | null;
  payerName?: string | null;
  datesOfService?: string | null;
  hcpcs?: string[];
  modifiers?: string[];
  billedCents?: number | null;
  allowedCents?: number | null;
  paidCents?: number | null;
  rentalMonth?: number | null;
}

export interface AuditAdherence {
  windowStart?: string | null;
  windowEnd?: string | null;
  nightsUsed?: number | null;
  nightsTotal?: number | null;
  avgHoursPerNight?: number | null;
  meetsCms?: boolean | null;
}

export interface AuditEquipmentLine {
  hcpcs: string;
  description: string;
  serialNumber?: string | null;
  manufacturer?: string | null;
  dispensedOn?: string | null;
}

export interface AuditReplacementRow {
  item: string;
  hcpcs?: string | null;
  lastReplaced?: string | null;
  quantity?: number | null;
  maxPerPeriod?: string | null;
  withinPolicy?: boolean | null;
}

export interface AuditContinuedUse {
  lastUsageDate?: string | null;
  lastContactDate?: string | null;
  method?: string | null;
  note?: string | null;
}

export interface FetchedDocument {
  label: string;
  bytes: Buffer;
  contentType: string;
  filename?: string | null;
}

export interface AuditPacketAdrContext {
  source?: string | null;
  contractorName?: string | null;
  payerName?: string | null;
  adrReference?: string | null;
  receivedAt?: string | null;
  responseDue?: string | null;
}

export interface AuditPacketBuildInput {
  scope: AuditScope;
  selectedKeys: string[];
  adr?: AuditPacketAdrContext | null;
  company: AuditPacketCompany;
  patient: AuditPacketPatient;
  claim?: AuditPacketClaimContext | null;
  adherence?: AuditAdherence | null;
  equipment?: AuditEquipmentLine[];
  replacement?: AuditReplacementRow[];
  continuedUse?: AuditContinuedUse | null;
  /** Stored chart documents fetched for on_file/hybrid items, keyed by the
   *  catalog item key. */
  documentsByItem?: Record<string, FetchedDocument[]>;
  generatedOn: Date;
}

export type AuditItemStatus =
  | "generated"
  | "attached"
  | "fallback"
  | "missing"
  | "unknown";

export interface AuditItemResult {
  key: string;
  label: string;
  status: AuditItemStatus;
  documentCount: number;
}

export interface AuditPacketResult {
  pdf: Buffer;
  pageCount: number;
  items: AuditItemResult[];
  /** Selected keys that were not in the catalog. */
  unknownKeys: string[];
  /** Stored parts that could not be embedded (with reason). */
  skipped: SkippedPart[];
}

function fmtMoney(cents?: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(value: Date): string {
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Build the cover sheet + table of contents from the resolved item list. */
function coverBlocks(
  input: AuditPacketBuildInput,
  toc: AuditItemResult[],
): Block[] {
  const blocks: Block[] = [];
  blocks.push({
    t: "title",
    text: input.company.legalName,
    sub: "Audit Documentation Response Packet",
  });
  if (input.company.npi) {
    blocks.push({
      t: "field",
      label: "Supplier NPI",
      value: input.company.npi,
    });
  }
  if (input.company.addressLines?.length) {
    blocks.push({
      t: "field",
      label: "Address",
      value: input.company.addressLines.join(", "),
    });
  }
  if (input.company.phone) {
    blocks.push({ t: "field", label: "Phone", value: input.company.phone });
  }

  blocks.push({ t: "heading", text: "Audit request" });
  const adr = input.adr ?? {};
  blocks.push({
    t: "field",
    label: "Contractor / source",
    value: [adr.contractorName, adr.source?.toUpperCase()]
      .filter(Boolean)
      .join(" · "),
  });
  if (adr.adrReference) {
    blocks.push({
      t: "field",
      label: "ADR reference",
      value: adr.adrReference,
    });
  }
  if (adr.payerName) {
    blocks.push({ t: "field", label: "Payer", value: adr.payerName });
  }
  if (adr.receivedAt) {
    blocks.push({ t: "field", label: "ADR received", value: adr.receivedAt });
  }
  if (adr.responseDue) {
    blocks.push({ t: "field", label: "Response due", value: adr.responseDue });
  }

  blocks.push({ t: "heading", text: "Beneficiary" });
  blocks.push({ t: "field", label: "Name", value: input.patient.name });
  if (input.patient.dateOfBirth) {
    blocks.push({
      t: "field",
      label: "Date of birth",
      value: input.patient.dateOfBirth,
    });
  }
  if (input.patient.memberId) {
    blocks.push({
      t: "field",
      label: "Member ID",
      value: input.patient.memberId,
    });
  }

  if (input.claim) {
    blocks.push({ t: "heading", text: "Claim under review" });
    if (input.claim.claimNumber) {
      blocks.push({
        t: "field",
        label: "Claim number",
        value: input.claim.claimNumber,
      });
    }
    if (input.claim.datesOfService) {
      blocks.push({
        t: "field",
        label: "Date(s) of service",
        value: input.claim.datesOfService,
      });
    }
    if (input.claim.hcpcs?.length) {
      blocks.push({
        t: "field",
        label: "HCPCS",
        value: input.claim.hcpcs.join(", "),
      });
    }
  }

  // Table of contents — only items that actually contributed pages.
  const included = toc.filter(
    (i) =>
      i.status === "generated" ||
      i.status === "attached" ||
      i.status === "fallback",
  );
  blocks.push({ t: "heading", text: `Contents (${included.length})` });
  blocks.push({
    t: "list",
    items: included.map((i) =>
      i.documentCount > 0 ? `${i.label} (${i.documentCount})` : i.label,
    ),
  });

  blocks.push({ t: "spacer", n: 0.5 });
  blocks.push({
    t: "paragraph",
    text: `Prepared ${fmtDate(input.generatedOn)}. This packet was assembled from the supplier's records for the claim(s) identified above and is provided in response to the documentation request.`,
  });
  return blocks;
}

/** Render the generated summary page(s) for a generated/fallback item, or
 *  null when the item has no data to render. */
async function renderGenerated(
  item: AuditPacketItem,
  input: AuditPacketBuildInput,
): Promise<Buffer | null> {
  switch (item.key) {
    case "compliance_report": {
      const a = input.adherence;
      if (!a) return null;
      const pct =
        a.nightsUsed != null && a.nightsTotal
          ? `${Math.round((a.nightsUsed / a.nightsTotal) * 100)}%`
          : "—";
      return renderPdfPage([
        { t: "title", text: "PAP Adherence / Compliance Report" },
        {
          t: "paragraph",
          text: "Objective device-usage summary. Medicare adherence is use of the PAP device for ≥4 hours per night on ≥70% of nights during a 30-consecutive-day period within the first 90 days of therapy.",
        },
        {
          t: "field",
          label: "Review window",
          value:
            [a.windowStart, a.windowEnd].filter(Boolean).join(" – ") || "—",
        },
        {
          t: "field",
          label: "Nights used (≥4 hrs)",
          value:
            a.nightsUsed != null && a.nightsTotal != null
              ? `${a.nightsUsed} of ${a.nightsTotal} (${pct})`
              : "—",
        },
        {
          t: "field",
          label: "Average hours / night",
          value:
            a.avgHoursPerNight != null ? a.avgHoursPerNight.toFixed(1) : "—",
        },
        {
          t: "field",
          label: "Meets Medicare adherence",
          value: a.meetsCms == null ? "—" : a.meetsCms ? "Yes" : "No",
        },
      ]);
    }
    case "equipment_detail": {
      const lines = input.equipment ?? [];
      if (lines.length === 0) return null;
      return renderPdfPage([
        { t: "title", text: "Dispensed Equipment Detail" },
        {
          t: "table",
          columns: ["HCPCS", "Description", "Serial", "Mfr", "Dispensed"],
          rows: lines.map((l) => [
            l.hcpcs,
            l.description,
            l.serialNumber ?? "—",
            l.manufacturer ?? "—",
            l.dispensedOn ?? "—",
          ]),
        },
      ]);
    }
    case "claim_detail": {
      const c = input.claim;
      if (!c) return null;
      return renderPdfPage([
        { t: "title", text: "Claim & Billing Summary" },
        { t: "field", label: "Claim number", value: c.claimNumber ?? "—" },
        { t: "field", label: "Payer", value: c.payerName ?? "—" },
        {
          t: "field",
          label: "Date(s) of service",
          value: c.datesOfService ?? "—",
        },
        {
          t: "field",
          label: "HCPCS",
          value: (c.hcpcs ?? []).join(", ") || "—",
        },
        {
          t: "field",
          label: "Modifiers",
          value: (c.modifiers ?? []).join(", ") || "—",
        },
        {
          t: "field",
          label: "Rental month",
          value: c.rentalMonth != null ? String(c.rentalMonth) : "—",
        },
        { t: "field", label: "Billed", value: fmtMoney(c.billedCents) },
        { t: "field", label: "Allowed", value: fmtMoney(c.allowedCents) },
        { t: "field", label: "Paid", value: fmtMoney(c.paidCents) },
      ]);
    }
    case "continued_use": {
      const u = input.continuedUse;
      if (!u) return null;
      return renderPdfPage([
        { t: "title", text: "Continued Use / Continued Medical Need" },
        {
          t: "paragraph",
          text: "Evidence the beneficiary continues to use the device and the supplies remain medically necessary.",
        },
        {
          t: "field",
          label: "Most recent usage",
          value: u.lastUsageDate ?? "—",
        },
        {
          t: "field",
          label: "Most recent contact",
          value: u.lastContactDate ?? "—",
        },
        { t: "field", label: "Contact method", value: u.method ?? "—" },
        ...(u.note ? [{ t: "paragraph" as const, text: u.note }] : []),
      ]);
    }
    case "replacement_schedule": {
      const rows = input.replacement ?? [];
      if (rows.length === 0) return null;
      return renderPdfPage([
        { t: "title", text: "Supply Replacement-Quantity Record" },
        {
          t: "paragraph",
          text: "Replacement dates and quantities against the usual Medicare maximum replacement schedule.",
        },
        {
          t: "table",
          columns: ["Item", "HCPCS", "Last replaced", "Qty", "Max", "Within"],
          rows: rows.map((r) => [
            r.item,
            r.hcpcs ?? "—",
            r.lastReplaced ?? "—",
            r.quantity != null ? String(r.quantity) : "—",
            r.maxPerPeriod ?? "—",
            r.withinPolicy == null ? "—" : r.withinPolicy ? "Yes" : "No",
          ]),
        },
      ]);
    }
    default:
      return null;
  }
}

/** Render a divider page introducing the stored documents that follow. */
function dividerBlocks(item: AuditPacketItem, count: number): Block[] {
  return [
    { t: "title", text: item.label },
    { t: "paragraph", text: item.description },
    {
      t: "paragraph",
      text:
        count === 1
          ? "The following 1 document on file is enclosed."
          : `The following ${count} documents on file are enclosed.`,
    },
  ];
}

/**
 * Build the merged audit packet. Pure composition over resolved data — no I/O.
 */
export async function buildAuditPacket(
  input: AuditPacketBuildInput,
): Promise<AuditPacketResult> {
  const { items, unknown } = normalizeSelection(input.selectedKeys);
  const docsByItem = input.documentsByItem ?? {};

  // First pass: decide each item's outcome + collect its parts (cover sheet is
  // rendered last but placed first, once the TOC is known).
  const parts: PacketPart[] = [];
  const results: AuditItemResult[] = [];

  for (const item of items) {
    if (item.key === "cover_sheet") {
      // Placeholder; filled after the rest so the TOC is accurate.
      results.push({
        key: item.key,
        label: item.label,
        status: "generated",
        documentCount: 0,
      });
      continue;
    }

    const stored = docsByItem[item.key] ?? [];

    if (item.source === "on_file") {
      if (stored.length === 0) {
        results.push({
          key: item.key,
          label: item.label,
          status: "missing",
          documentCount: 0,
        });
        continue;
      }
      parts.push({
        kind: "pdf",
        label: `${item.label} — divider`,
        bytes: await renderPdfPage(dividerBlocks(item, stored.length)),
      });
      for (const d of stored) {
        parts.push(toPart(d));
      }
      results.push({
        key: item.key,
        label: item.label,
        status: "attached",
        documentCount: stored.length,
      });
      continue;
    }

    if (item.source === "hybrid") {
      if (stored.length > 0) {
        parts.push({
          kind: "pdf",
          label: `${item.label} — divider`,
          bytes: await renderPdfPage(dividerBlocks(item, stored.length)),
        });
        for (const d of stored) parts.push(toPart(d));
        results.push({
          key: item.key,
          label: item.label,
          status: "attached",
          documentCount: stored.length,
        });
        continue;
      }
      const fallback = await renderGenerated(item, input);
      if (fallback) {
        parts.push({ kind: "pdf", label: item.label, bytes: fallback });
        results.push({
          key: item.key,
          label: item.label,
          status: "fallback",
          documentCount: 0,
        });
      } else {
        results.push({
          key: item.key,
          label: item.label,
          status: "missing",
          documentCount: 0,
        });
      }
      continue;
    }

    // Generated item.
    const page = await renderGenerated(item, input);
    if (page) {
      parts.push({ kind: "pdf", label: item.label, bytes: page });
      results.push({
        key: item.key,
        label: item.label,
        status: "generated",
        documentCount: 0,
      });
    } else {
      results.push({
        key: item.key,
        label: item.label,
        status: "missing",
        documentCount: 0,
      });
    }
  }

  // Cover sheet first, if it was selected.
  const wantsCover = items.some((i) => i.key === "cover_sheet");
  if (wantsCover) {
    const cover = await renderPdfPage(coverBlocks(input, results));
    parts.unshift({ kind: "pdf", label: "Cover sheet", bytes: cover });
  }

  const assembled = await assemblePacket(parts);
  return {
    pdf: assembled.pdf,
    pageCount: assembled.pageCount,
    items: results,
    unknownKeys: unknown,
    skipped: assembled.skipped,
  };
}

function toPart(d: FetchedDocument): PacketPart {
  const ct = d.contentType.toLowerCase();
  if (ct.includes("pdf")) {
    return { kind: "pdf", label: d.label, bytes: d.bytes };
  }
  return {
    kind: "image",
    label: d.label,
    bytes: d.bytes,
    contentType: d.contentType,
  };
}
