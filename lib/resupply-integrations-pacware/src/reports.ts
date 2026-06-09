// Canonical catalog of the PacWare <-> PennFit file exchanges we
// support. This is the SINGLE SOURCE OF TRUTH for column layouts: the
// parser (import), the exporter, the `/admin/pacware/status` endpoint,
// and the operator manual (docs/runbooks/pacware-import-export.md) all
// read from here so they can never drift apart.
//
// Background — why files, not an API:
//   PacWare is a legacy Windows client-server HME/DME billing package
//   (Billing, Inventory, Reporting, Cash Application). It was acquired
//   by Brightree and has no public/network API to integrate against.
//   The supported, durable integration is therefore a file exchange:
//   PennFit ingests CSV reports exported from PacWare, and emits CSV
//   files shaped for PacWare's import screens. See
//   docs/integrations/pacware.md for the full rationale.

export const PACWARE_REPORT_KINDS = [
  // Patient demographics + insurance. PacWare report -> PennFit roster.
  // Also emitted by PennFit so the roster can round-trip.
  "patient_roster",
  // Resupply episodes that are due / ready to action. PennFit -> PacWare
  // order-entry & billing. Export only.
  "resupply_due",
] as const;

export type PacwareReportKind = (typeof PACWARE_REPORT_KINDS)[number];

export type PacwareDirection = "import" | "export" | "both";

export interface PacwareColumnSpec {
  /** Canonical camelCase field name used throughout the code path. */
  field: string;
  /** Canonical CSV header label PennFit emits on export. */
  header: string;
  /**
   * Additional header spellings accepted on import. Matched after
   * normalisation (lowercase, alphanumerics only), so "Pacware ID",
   * "pacware_id", and "PacwareID" all collapse to the same key — list
   * only spellings that differ once normalised (e.g. "dob" vs
   * "dateofbirth", "zip" vs "postalcode"). The canonical `header` is
   * always accepted and does not need to be repeated here.
   */
  aliases: string[];
  required: boolean;
  /** One-line human description for the manual + status endpoint. */
  description: string;
}

export interface PacwareReportSpec {
  kind: PacwareReportKind;
  direction: PacwareDirection;
  /** Short human label. */
  label: string;
  /** What this exchange is for + which PacWare screen it maps to. */
  description: string;
  columns: PacwareColumnSpec[];
}

// ---------------------------------------------------------------------------
// patient_roster — demographics + insurance (import + export).
//
// Mirrors the columns the existing /patients/import-csv + /patients/
// export.csv already speak (they were always "Pacware-style"), and adds
// the address + insurance columns so a re-run keeps those in sync. The
// export uses these exact headers so an admin can export, edit, and
// re-import without column re-mapping.
// ---------------------------------------------------------------------------
const PATIENT_ROSTER: PacwareReportSpec = {
  kind: "patient_roster",
  direction: "both",
  label: "Patient roster",
  description:
    "Patient demographics + insurance. In PacWare, run the Patient List / " +
    "Patient Demographics report. Joins to PennFit patients on the PacWare " +
    "account number (pacware_id).",
  columns: [
    {
      field: "pacwareId",
      header: "pacware_id",
      aliases: [
        "accountnumber",
        "acctno",
        "accountno",
        "patientid",
        "patientnumber",
      ],
      required: true,
      description: "PacWare patient account number — the stable join key.",
    },
    {
      field: "legalFirstName",
      header: "legal_first_name",
      aliases: ["firstname", "first"],
      required: true,
      description: "Patient legal first name.",
    },
    {
      field: "legalLastName",
      header: "legal_last_name",
      aliases: ["lastname", "last"],
      required: true,
      description: "Patient legal last name.",
    },
    {
      field: "dateOfBirth",
      header: "date_of_birth",
      aliases: ["dob", "birthdate"],
      required: true,
      description: "Date of birth in YYYY-MM-DD.",
    },
    {
      field: "phoneE164",
      header: "phone_e164",
      aliases: ["phone", "phonenumber", "mobile", "cell"],
      required: false,
      description: "Phone in E.164 (+14155551212). Blank is allowed.",
    },
    {
      field: "email",
      header: "email",
      aliases: ["emailaddress"],
      required: false,
      description: "Email address. Blank is allowed.",
    },
    {
      field: "addressLine1",
      header: "address_line1",
      aliases: ["address1", "address", "street", "addressline1"],
      required: false,
      description: "Street address line 1. Provide the full address or none.",
    },
    {
      field: "addressLine2",
      header: "address_line2",
      aliases: ["address2", "addressline2", "apt", "unit", "suite"],
      required: false,
      description: "Street address line 2 (apt/suite).",
    },
    {
      field: "city",
      header: "city",
      aliases: [],
      required: false,
      description: "City.",
    },
    {
      field: "state",
      header: "state",
      aliases: ["province", "stateprovince"],
      required: false,
      description: "State / province.",
    },
    {
      field: "postalCode",
      header: "postal_code",
      aliases: ["zip", "zipcode", "postal"],
      required: false,
      description: "Postal / ZIP code.",
    },
    {
      field: "country",
      header: "country",
      aliases: [],
      required: false,
      description: "Country (defaults to US when an address is present).",
    },
    {
      field: "insurancePayer",
      header: "insurance_payer",
      aliases: ["payer", "insurance", "primaryinsurance", "primarypayer"],
      required: false,
      description:
        "Primary insurance payer name (used for resupply cadence rules).",
    },
  ],
};

// ---------------------------------------------------------------------------
// resupply_due — episodes ready to bill/fulfil in PacWare (export only).
//
// PennFit owns the resupply engine (cadence rules + outreach); PacWare
// owns billing + warehouse. When a resupply episode is approved/ready,
// PennFit hands it to PacWare as a one-line order via this report so the
// DME can pick/ship and bill from its system of record.
// ---------------------------------------------------------------------------
const RESUPPLY_DUE: PacwareReportSpec = {
  kind: "resupply_due",
  direction: "export",
  label: "Resupply due",
  description:
    "Resupply episodes that are due/ready to action. Import into PacWare " +
    "order entry to pick, ship, and bill. One line per due item.",
  columns: [
    {
      field: "pacwareId",
      header: "pacware_id",
      aliases: [],
      required: true,
      description: "PacWare patient account number.",
    },
    {
      field: "legalLastName",
      header: "patient_last_name",
      aliases: [],
      required: true,
      description: "Patient legal last name.",
    },
    {
      field: "legalFirstName",
      header: "patient_first_name",
      aliases: [],
      required: true,
      description: "Patient legal first name.",
    },
    {
      field: "itemSku",
      header: "item_sku",
      aliases: [],
      required: true,
      description: "Prescribed item SKU to dispense.",
    },
    {
      field: "quantity",
      header: "quantity",
      aliases: [],
      required: true,
      description: "Quantity to ship (1 per resupply line).",
    },
    {
      field: "dueDate",
      header: "due_date",
      aliases: [],
      required: true,
      description: "Date the resupply is due (YYYY-MM-DD).",
    },
    {
      field: "episodeStatus",
      header: "status",
      aliases: [],
      required: true,
      description: "PennFit episode status at export time.",
    },
    {
      field: "insurancePayer",
      header: "insurance_payer",
      aliases: [],
      required: false,
      description: "Primary insurance payer name (for billing routing).",
    },
    {
      field: "episodeId",
      header: "pennfit_episode_id",
      aliases: [],
      required: true,
      description:
        "PennFit episode id — reconciliation handle, store in PacWare notes.",
    },
  ],
};

const REGISTRY: Record<PacwareReportKind, PacwareReportSpec> = {
  patient_roster: PATIENT_ROSTER,
  resupply_due: RESUPPLY_DUE,
};

export function getPacwareReportSpec(
  kind: PacwareReportKind,
): PacwareReportSpec {
  return REGISTRY[kind];
}

export function listPacwareReportSpecs(): PacwareReportSpec[] {
  return PACWARE_REPORT_KINDS.map((k) => REGISTRY[k]);
}

/**
 * Build the normalized-header -> canonical-field lookup for one report.
 * The canonical `header` plus every alias map to the field. Used by the
 * importer to accept the many header spellings a hand-run PacWare report
 * can produce.
 */
export function buildHeaderFieldMap(
  spec: PacwareReportSpec,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of spec.columns) {
    map.set(normalize(col.header), col.field);
    for (const alias of col.aliases) {
      map.set(normalize(alias), col.field);
    }
  }
  return map;
}

function normalize(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}
