import { createHash } from "node:crypto";

//
// Two emitter functions, sharing one input shape:

export interface QuickbooksRowInput {
  /**
   * Stable per-transaction identifier the operator can search for in
   * QuickBooks ("TXN-3e29ab"). Falls back to the order id if no
   * stripe session was recorded.
   */
  txnId: string;
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Positive: revenue. Negative: refund / credit. */
  amountUsd: number;
  /** "ORDER" | "REFUND". Drives the account name in IIF. */
  kind: "ORDER" | "REFUND";
  /** Free-form memo (typically the Stripe session id). */
  memo: string;
  /** Stable customer key — hashed prefix, not a name. */
  customerKey: string;
  /**
   * Optional override for the offsetting SPL (income / category)
   * account. When unset, ORDER rows post to "Sales:Online Orders"
   * and REFUND rows to "Sales Returns and Allowances" (the historical
   * defaults). Set this to route a distinct revenue stream — e.g.
   * patient-responsibility collections — to its own income account so
   * it lands on its own P&L line in QuickBooks instead of being lumped
   * in with storefront sales. The TRNS (clearing) account is
   * unaffected. The QBO CSV has no account column, so this only
   * influences the IIF output.
   */
  incomeAccount?: string;
}

export interface QuickbooksExportInput {
  /** Date range for the filename + header line. */
  from: string;
  to: string;
  /** Practice name shown in the IIF header. */
  practiceName: string;
  rows: QuickbooksRowInput[];
  /** Optional configurable GL account names (IIF only, owner #O3). */
  accounts?: QuickbooksAccounts;
}

/**
 * Configurable GL account names (owner #O3). Each unset field falls back
 * to the historical hardcoded default, so exports are byte-for-byte
 * unchanged until an owner configures a mapping. A per-row
 * `incomeAccount` override still wins over `revenue`/`refund`.
 */
export interface QuickbooksAccounts {
  /** TRNS clearing account every transaction posts to. */
  deposit?: string;
  /** SPL income account for ORDER rows. */
  revenue?: string;
  /** SPL account for REFUND rows. */
  refund?: string;
}

// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────

const REVENUE_ACCOUNT = "Sales:Online Orders";
const REFUND_ACCOUNT = "Sales Returns and Allowances";
const DEPOSIT_ACCOUNT = "Stripe Clearing";

function fmtAmount(usd: number): string {
  // IIF wants amounts with two decimals and a sign. Negative values
  // (refunds) keep the leading minus.
  return usd.toFixed(2);
}

function escIif(value: string): string {
  // IIF is tab-separated. Tabs and newlines inside a field break
  // the import. Strip them; QuickBooks doesn't support escaping.
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function escCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────
// IIF
// ─────────────────────────────────────────────────────────────────

/**
 * Render the input rows as a QuickBooks Desktop IIF file.
 *
 * Format (one !-prefixed header line per record type, followed by
 * data rows with one TRNS + one SPL + one ENDTRNS each):
 *
 *   !TRNS<TAB>TRNSID<TAB>TRNSTYPE<TAB>DATE<TAB>ACCNT<TAB>NAME<TAB>AMOUNT<TAB>MEMO
 *   !SPL<TAB>SPLID<TAB>TRNSTYPE<TAB>DATE<TAB>ACCNT<TAB>AMOUNT<TAB>MEMO
 *   !ENDTRNS
 *   TRNS<TAB>...<TAB>+amount<TAB>memo
 *   SPL<TAB>...<TAB>-amount<TAB>memo
 *   ENDTRNS
 *
 * Each TRNS posts the gross amount to the DEPOSIT_ACCOUNT (Stripe
 * clearing) and each SPL credits REVENUE_ACCOUNT (positive) or debits
 * REFUND_ACCOUNT (negative). QuickBooks balances each transaction
 * because the SPL amount has the OPPOSITE sign of the TRNS amount —
 * required by the IIF format.
 */
export function renderIif(input: QuickbooksExportInput): string {
  const lines: string[] = [];
  // Comment header — QuickBooks ignores `;`-prefixed lines.
  lines.push(`; PennPaps QuickBooks export — ${escIif(input.practiceName)}`);
  lines.push(`; Range: ${escIif(input.from)} to ${escIif(input.to)}`);
  lines.push(`; Rows: ${input.rows.length}`);
  lines.push("");
  // Schema lines.
  lines.push(
    [
      "!TRNS",
      "TRNSID",
      "TRNSTYPE",
      "DATE",
      "ACCNT",
      "NAME",
      "AMOUNT",
      "MEMO",
    ].join("\t"),
  );
  lines.push(
    ["!SPL", "SPLID", "TRNSTYPE", "DATE", "ACCNT", "AMOUNT", "MEMO"].join("\t"),
  );
  lines.push("!ENDTRNS");

  const depositAccount = input.accounts?.deposit ?? DEPOSIT_ACCOUNT;
  const revenueAccount = input.accounts?.revenue ?? REVENUE_ACCOUNT;
  const refundAccount = input.accounts?.refund ?? REFUND_ACCOUNT;

  let splId = 1;
  for (const r of input.rows) {
    const trnsType = r.kind === "REFUND" ? "CREDIT MEMO" : "DEPOSIT";
    const splAccnt =
      r.incomeAccount ?? (r.kind === "REFUND" ? refundAccount : revenueAccount);
    // TRNS holds the gross amount posted to the Stripe clearing
    // account.
    lines.push(
      [
        "TRNS",
        escIif(r.txnId),
        trnsType,
        escIif(r.date),
        depositAccount,
        escIif(r.customerKey),
        fmtAmount(r.amountUsd),
        escIif(r.memo),
      ].join("\t"),
    );
    // SPL is the offsetting income/refund posting — sign is FLIPPED
    // from the TRNS row so QuickBooks balances the transaction.
    lines.push(
      [
        "SPL",
        String(splId++),
        trnsType,
        escIif(r.date),
        splAccnt,
        fmtAmount(-r.amountUsd),
        escIif(r.memo),
      ].join("\t"),
    );
    lines.push("ENDTRNS");
  }

  // IIF files end with a trailing newline. QuickBooks rejects a file
  // that doesn't.
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────
// QBO-friendly CSV
// ─────────────────────────────────────────────────────────────────

/**
 * QuickBooks Online's bank-import / sales-receipt upload wizard
 * recognizes a small set of column headers automatically. Using
 * those exact spellings (case-insensitive on QBO's side) lets the
 * operator skip the manual column-mapping step in QBO.
 */
const QBO_HEADERS = [
  "Date",
  "Description",
  "Customer",
  "Amount",
  "Type",
  "Reference",
] as const;

export function renderQboCsv(input: QuickbooksExportInput): string {
  const lines: string[] = [];
  lines.push(QBO_HEADERS.join(","));
  for (const r of input.rows) {
    const type = r.kind === "REFUND" ? "Credit Memo" : "Sales Receipt";
    lines.push(
      [
        escCsv(r.date),
        escCsv(r.memo),
        escCsv(r.customerKey),
        // QBO uses positive amounts for both sales receipts and
        // credit memos — the Type column distinguishes them. We
        // preserve the absolute value here so a CSV that's
        // partially mis-mapped doesn't accidentally subtract.
        escCsv(Math.abs(r.amountUsd).toFixed(2)),
        escCsv(type),
        escCsv(r.txnId),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Build a stable customer key from an opaque customer id (Stripe
 * customer id or PennPaps customer id). QuickBooks uses the
 * customer name to match rows to the customer list; emitting the
 * raw uuid is too unfriendly, so we emit "cust-<hash>".
 * Exported for tests + so reports.ts can share the algorithm.
 */
export function customerKeyForId(rawId: string | null): string {
  if (!rawId) return "cust-unknown";
  // Use a deterministic cryptographic hash to avoid leaking source-ID
  // structure. SHA-256 with a fixed salt produces a stable, opaque key.
  const hash = createHash("sha256")
    .update("pennpaps-customer-key-v1")
    .update(rawId)
    .digest("hex");
  return `cust-${hash.slice(0, 12)}`;
}
