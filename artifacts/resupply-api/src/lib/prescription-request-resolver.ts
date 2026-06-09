// Resolve a prescription_request_packets row into the typed input
// shape the PDF renderer consumes. Performs the joins (patient,
// provider) the route would otherwise do inline and projects the
// jsonb columns into the renderer's TypeScript types.
//
// Pure-ish: takes a Supabase client and a packet id, performs reads,
// returns the typed result. No logging side effects.

import type {
  PrescriptionRequestHcpcsLine,
  PrescriptionRequestInputs,
  PrescriptionRequestSettings,
  DeviceClass,
} from "./prescription-request-pdf";

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type ResolveOutcome =
  | { kind: "ok"; inputs: PrescriptionRequestInputs }
  | { kind: "not_found" }
  | { kind: "invalid_inputs"; missing: string[] };

export async function resolvePrescriptionRequestInputs(
  supabase: SupabaseClient,
  packetId: string,
): Promise<ResolveOutcome> {
  const { data: packet } = await supabase
    .schema("resupply")
    .from("prescription_request_packets")
    .select(
      "id, patient_id, provider_id, hcpcs_items_json, icd10_codes_json, device_settings_json, length_of_need_months, return_fax_e164, return_email, clinical_notes, created_at",
    )
    .eq("id", packetId)
    .limit(1)
    .maybeSingle();
  if (!packet) return { kind: "not_found" };

  const [{ data: patient }, { data: provider }, { data: coverage }] =
    await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select(
          "legal_first_name, legal_last_name, date_of_birth, address, phone_e164",
        )
        .eq("id", packet.patient_id)
        .limit(1)
        .maybeSingle(),
      packet.provider_id
        ? supabase
            .schema("resupply")
            .from("providers")
            .select("legal_name, npi, practice_name, fax_e164")
            .eq("id", packet.provider_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Primary payer on file. "primary" < "secondary" < "tertiary"
      // alphabetically, so an ascending sort surfaces the primary
      // coverage first. Missing coverage is non-fatal — the PDF just
      // omits the Insurance section.
      supabase
        .schema("resupply")
        .from("insurance_coverages")
        .select("payer_name, member_id, plan_name, rank")
        .eq("patient_id", packet.patient_id)
        .order("rank", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

  if (!patient || !provider) {
    return {
      kind: "invalid_inputs",
      missing: [
        ...(patient ? [] : ["patient"]),
        ...(provider ? [] : ["provider"]),
      ],
    };
  }

  const supplierFax =
    process.env.RESUPPLY_SUPPLIER_FAX_E164?.trim() ||
    process.env.TELNYX_FAX_FROM_NUMBER?.trim() ||
    "";

  const inputs: PrescriptionRequestInputs = {
    patient: {
      legalFirstName: patient.legal_first_name ?? "",
      legalLastName: patient.legal_last_name ?? "",
      dateOfBirth: patient.date_of_birth ?? "",
      address: parseAddress(patient.address),
      phoneE164: patient.phone_e164 ?? null,
    },
    provider: {
      legalName: provider.legal_name ?? "",
      npi: provider.npi ?? "",
      practiceName: provider.practice_name ?? null,
      faxE164: provider.fax_e164 ?? null,
    },
    supplier: {
      practiceName: process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps",
      faxE164: supplierFax,
      email: process.env.RESUPPLY_SUPPLIER_RETURN_EMAIL?.trim() || null,
    },
    coverage: coverage
      ? {
          payerName: coverage.payer_name,
          memberId: coverage.member_id,
          planName: coverage.plan_name ?? null,
          rank: coverage.rank ?? null,
          isMedicare: /medicare/i.test(coverage.payer_name ?? ""),
        }
      : null,
    hcpcsLines: parseHcpcsLines(packet.hcpcs_items_json),
    icd10Codes: parseStringArray(packet.icd10_codes_json),
    settings: parseSettings(packet.device_settings_json),
    lengthOfNeedMonths: packet.length_of_need_months ?? 99,
    clinicalNotes: packet.clinical_notes ?? null,
    generatedOn: new Date(),
  };

  return { kind: "ok", inputs };
}

function parseAddress(
  raw: unknown,
): PrescriptionRequestInputs["patient"]["address"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<PrescriptionRequestInputs["patient"]["address"]> = {};
  if (typeof r.line1 === "string") out.line1 = r.line1;
  if (typeof r.line2 === "string") out.line2 = r.line2;
  if (typeof r.city === "string") out.city = r.city;
  if (typeof r.state === "string") out.state = r.state;
  if (typeof r.postalCode === "string") out.postalCode = r.postalCode;
  else if (typeof r.postal_code === "string") out.postalCode = r.postal_code;
  return Object.keys(out).length === 0 ? null : out;
}

function parseHcpcsLines(raw: unknown): PrescriptionRequestHcpcsLine[] {
  if (!Array.isArray(raw)) return [];
  const out: PrescriptionRequestHcpcsLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const hcpcs = typeof r.hcpcs === "string" ? r.hcpcs : null;
    if (!hcpcs) continue;
    const description = typeof r.description === "string" ? r.description : "—";
    const quantity =
      typeof r.quantity === "number" && r.quantity > 0
        ? Math.trunc(r.quantity)
        : 1;
    const cadenceDays =
      typeof r.cadenceDays === "number"
        ? r.cadenceDays
        : typeof r.cadence_days === "number"
          ? r.cadence_days
          : null;
    const modifiers = Array.isArray(r.modifiers)
      ? r.modifiers.filter((m): m is string => typeof m === "string")
      : [];
    out.push({ hcpcs, description, quantity, cadenceDays, modifiers });
  }
  return out;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

const DEVICE_CLASSES: ReadonlySet<DeviceClass> = new Set<DeviceClass>([
  "cpap",
  "auto_cpap",
  "bipap",
  "bipap_st",
  "asv",
]);

function parseSettings(raw: unknown): PrescriptionRequestSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const deviceClass =
    typeof r.deviceClass === "string"
      ? (r.deviceClass as DeviceClass)
      : typeof r.device_class === "string"
        ? (r.device_class as DeviceClass)
        : null;
  if (!deviceClass || !DEVICE_CLASSES.has(deviceClass)) return null;
  const num = (a: string, b: string): number | null => {
    const v = (r[a] ?? r[b]) as unknown;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const bool = (a: string, b: string): boolean | undefined => {
    const v = (r[a] ?? r[b]) as unknown;
    return typeof v === "boolean" ? v : undefined;
  };
  return {
    deviceClass,
    pressureCmh2o: num("pressureCmh2o", "pressure_cmh2o"),
    pressureMinCmh2o: num("pressureMinCmh2o", "pressure_min_cmh2o"),
    pressureMaxCmh2o: num("pressureMaxCmh2o", "pressure_max_cmh2o"),
    ipapCmh2o: num("ipapCmh2o", "ipap_cmh2o"),
    epapCmh2o: num("epapCmh2o", "epap_cmh2o"),
    rampMinutes: num("rampMinutes", "ramp_minutes"),
    rampStartCmh2o: num("rampStartCmh2o", "ramp_start_cmh2o"),
    humidifierSetting: num("humidifierSetting", "humidifier_setting"),
    heatedTube: bool("heatedTube", "heated_tube"),
    backupRateBpm: num("backupRateBpm", "backup_rate_bpm"),
  };
}
