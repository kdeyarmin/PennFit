// reports/shared.ts — helpers shared by every /admin/reports/* module:
// the report-slug/format catalog, date-range parsing + clamping, CSV
// escaping, download headers, the GL-account-aware IIF renderer, and
// the buffered-response shim used by the email-a-report flow.

import type { IRouter } from "express";

import {
  GL_ACCOUNT_DEFAULTS,
  loadGlAccounts,
} from "../../../lib/billing/gl-accounts";
import { getDocumentSupplierNameSync } from "../../../lib/company-info";
import {
  renderIif,
  type QuickbooksExportInput,
  type QuickbooksRowInput,
} from "../../../lib/quickbooks-export";
import { safeCsvCell } from "../../../lib/safe-csv-cell";

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;

export const REPORT_SLUGS = [
  "orders",
  "returns",
  "revenue-summary",
  "refunds-journal",
  "insurance-claims",
  "patient-payments",
  "all-financial",
  "customer-activity",
] as const;
export type ReportSlug = (typeof REPORT_SLUGS)[number];

export const REPORT_FORMATS = ["csv", "pdf", "iif", "qbo.csv"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

// One module per report slug. `register` mounts the GET download
// endpoints on the shared router; the `buildEmail*` builders produce
// the same bytes for the POST /admin/reports/email attachment path.
// `buildEmailQbRows` is only present on slugs with QuickBooks
// exports — its absence is what makes the email route 400 with
// `format_not_supported`.
export interface ReportModule {
  slug: ReportSlug;
  register(router: IRouter): void;
  buildEmailCsv(from: Date, to: Date): Promise<Buffer>;
  buildEmailPdf(from: Date, to: Date): Promise<Buffer>;
  buildEmailQbRows?(from: Date, to: Date): Promise<QuickbooksRowInput[]>;
}

// Read at call time (not module load) so the boot/save-time company-
// info hydration is honoured without a restart. Reports carry the
// registered DME legal name, not the storefront brand.
export const practiceName = (): string => getDocumentSupplierNameSync();

export function parseRange(req: import("express").Request): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  const toRaw = typeof req.query.to === "string" ? req.query.to : null;
  const fromRaw = typeof req.query.from === "string" ? req.query.from : null;
  let to = toRaw ? new Date(toRaw + "T23:59:59Z") : now;
  let from = fromRaw
    ? new Date(fromRaw + "T00:00:00Z")
    : new Date(now.getTime() - DEFAULT_DAYS * 86400_000);
  // A junk ?from/?to yields an Invalid Date: every NaN comparison is
  // false, so the MAX_DAYS clamp silently disengages and the first
  // `.toISOString()` downstream throws a RangeError (500 for a typo'd
  // date). Fall back to the defaults instead — same guard the email
  // endpoint applies to its own date inputs.
  if (Number.isNaN(to.getTime())) to = now;
  if (Number.isNaN(from.getTime())) {
    from = new Date(to.getTime() - DEFAULT_DAYS * 86400_000);
  }
  const days = (to.getTime() - from.getTime()) / 86400_000;
  if (days > MAX_DAYS) {
    return {
      from: new Date(to.getTime() - MAX_DAYS * 86400_000),
      to,
    };
  }
  return { from, to };
}

export function rangeLabel(from: Date, to: Date): string {
  return `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`;
}

export function rangeSlug(from: Date, to: Date): string {
  return `${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}`;
}

// Delegates to the shared helper for formula-injection
// neutralisation + `\r`-line-ending detection. tracking_number,
// tracking_carrier, and delivery_error flow from carrier APIs and
// aren't fully system-controlled.
export function escapeCsv(v: unknown): string {
  return safeCsvCell(v);
}

export function setDownloadHeaders(
  res: import("express").Response,
  contentType: string,
  filename: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

export function centsToDollars(cents: number | null | undefined): number {
  return cents == null ? 0 : cents / 100;
}

// Render an IIF with the owner-configured GL accounts (owner #O3).
// Loads the mapping once, applies deposit/revenue/refund to the export,
// and remaps patient-pay rows (tagged with the default patient-pay
// account) to the configured one. Defaults leave the output unchanged.
export async function renderIifWithAccounts(
  base: Omit<QuickbooksExportInput, "accounts">,
): Promise<string> {
  const accounts = await loadGlAccounts();
  const rows =
    accounts.patientPay === GL_ACCOUNT_DEFAULTS.patientPay
      ? base.rows
      : base.rows.map((r) =>
          r.incomeAccount === GL_ACCOUNT_DEFAULTS.patientPay
            ? { ...r, incomeAccount: accounts.patientPay }
            : r,
        );
  return renderIif({
    ...base,
    rows,
    accounts: {
      deposit: accounts.deposit,
      revenue: accounts.revenue,
      refund: accounts.refund,
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Buffered-response shim for the email endpoint.
//
// The existing CSV writers (writeOrdersCsv, etc.) stream directly to
// the express Response via .write() / .end(). For the email-a-report
// flow we need the same bytes as a Buffer so we can attach them to a
// SendGrid message. Rather than parameterise every writer, we hand
// them this tiny shim — it has the only two methods they call.
//
// Any future writer that reaches for additional Response methods
// (.setHeader, .status, etc.) will fail the .csv buffered path; we
// keep the surface intentionally small so an accidental extension
// surfaces as a build error instead of a silent broken email.
// ─────────────────────────────────────────────────────────────────

export interface BufferedRes {
  write(chunk: string): boolean;
  end(): void;
}

export function bufferedRes(): {
  res: BufferedRes;
  collect: () => Buffer;
} {
  const chunks: Buffer[] = [];
  return {
    res: {
      write(chunk: string) {
        chunks.push(Buffer.from(chunk, "utf8"));
        return true;
      },
      end() {
        // No-op: the caller pulls the bytes via collect().
      },
    },
    collect: () => Buffer.concat(chunks),
  };
}
