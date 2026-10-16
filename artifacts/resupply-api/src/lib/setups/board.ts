// Assemble the New setups board from live records. The patient_setups
// row contributes the owner and the reminder stamps. Stage, blocker,
// and the deep link are classified here and are not stored.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { redactDbErr } from "../redact-db-err";
import {
  FIRST_NIGHT_STEP_KEYS,
  REQUIRED_PAPERWORK,
  classifySetup,
  type SetupSignals,
  type SetupStage,
} from "./blocker";
import { olderThanOneBusinessDay } from "./business-day";
import { matchUniquePatientsByEmail } from "./open-setup";
import { chooseSetupOrder, isMachineFulfillment } from "./machine-order";
import { e0601PriorAuthRequired } from "./prior-auth";

const BOARD_CAP = 50;
const BATCH_CAP = 500;

export interface SetupBoardRow {
  id: string;
  kind: "setup" | "fit_request";
  patientId: string | null;
  displayName: string;
  source: string;
  openedAt: string;
  ageHours: number;
  stage: SetupStage;
  blocker: string | null;
  href: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
}

export interface MorningCounts {
  openReferralReviews: number;
  staleFitRequests: number;
  unsignedPackets: number;
  priorAuthsInSla: number;
}

export interface SignatureTarget {
  id: string;
  linkVersion: number;
  sentAt: string;
  email: string | null;
  phone: string | null;
  customerName: string;
  orderReference: string;
  hasDocuments: boolean;
  timezone: string | null;
  expiresAt: string | null;
}

export interface SetupWorkItem extends SetupBoardRow {
  blockerClearedNotifiedAt: string | null;
  signatureReminder24At: string | null;
  signatureReminder48At: string | null;
  reminderOrderId: string | null;
  reminderLinkVersion: number | null;
  checklistComplete: boolean;
  order: SetupSignals["order"];
  priorAuth: SetupSignals["priorAuth"];
  signatureTarget: SignatureTarget | null;
}

export interface SetupBoard {
  rows: SetupBoardRow[];
  morning: MorningCounts;
  work: SetupWorkItem[];
}

interface SetupRow {
  id: string;
  patient_id: string;
  source: string;
  opened_at: string;
  owner_user_id: string | null;
  owner_email: string | null;
  blocker_cleared_notified_at: string | null;
  signature_reminder_24_at: string | null;
  signature_reminder_48_at: string | null;
  reminder_order_id: string | null;
  reminder_link_version: number | null;
  csr_order_request_id: string | null;
}

interface PatientRow {
  id: string;
  legal_first_name: string | null;
  legal_last_name: string | null;
  email: string | null;
  timezone: string | null;
}

interface CoverageRow {
  id: string;
  patient_id: string;
  payer_name: string | null;
  member_id: string | null;
}

interface EligibilityRow {
  patient_id: string;
  insurance_coverage_id: string | null;
  service_hcpcs: string | null;
  status: string;
  is_active: boolean | null;
  requires_prior_auth: boolean | null;
  requested_at: string;
}

interface SameOrSimilarRow {
  patient_id: string;
  hcpcs_code: string;
  status: string;
  checked_at: string;
}

interface FormRow {
  patient_id: string;
  form_kind: string;
}

interface OrderRow {
  id: string;
  patient_id: string | null;
  status: string;
  signed_at: string | null;
  sent_at: string | null;
  link_version: number;
  customer_email: string | null;
  customer_phone: string | null;
  customer_name: string;
  order_reference: string;
  documents: unknown;
  items: unknown;
  expires_at: string | null;
  created_at: string;
}

interface FulfillmentRow {
  patient_id: string;
  status: string;
  shipped_at: string | null;
  csr_order_request_id: string | null;
  item_sku: string | null;
}

interface PriorAuthRow {
  patient_id: string;
  hcpcs_code: string;
  status: string;
}

interface ChecklistRow {
  patient_id: string;
  step_key: string;
  status: string;
}

interface FitRequestRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  recommended_mask_name: string | null;
  created_at: string;
}

function asRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function ageHours(openedAt: string, now: Date): number {
  const t = Date.parse(openedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((now.getTime() - t) / (60 * 60 * 1000)));
}

function displayName(patient: PatientRow | undefined): string {
  const name = [patient?.legal_first_name, patient?.legal_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || "Patient";
}

function latestBy<T>(rows: T[], id: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = id(row);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

function priorAuthState(rows: PriorAuthRow[]): SetupSignals["priorAuth"] {
  const mine = rows.filter((row) => row.hcpcs_code === "E0601");
  if (mine.some((row) => row.status === "approved")) return "approved";
  if (
    mine.some((row) => row.status === "submitted" || row.status === "appealed")
  )
    return "submitted";
  if (mine.some((row) => row.status === "draft")) return "draft";
  if (mine.some((row) => row.status === "denied")) return "denied";
  return "missing";
}

function eligibilityState(
  row: EligibilityRow | undefined,
): SetupSignals["eligibility"] {
  if (!row) return "none";
  if (row.status === "queued" || row.status === "submitted") return "pending";
  if (row.status === "parsed" && row.is_active === true) return "active";
  if (row.status === "parsed" && row.is_active === false) return "inactive";
  if (row.status === "rejected" || row.status === "transport_failed")
    return "inactive";
  return "pending";
}

const SETUP_COLUMNS =
  "id, patient_id, source, opened_at, owner_user_id, owner_email, blocker_cleared_notified_at, signature_reminder_24_at, signature_reminder_48_at, reminder_order_id, reminder_link_version, csr_order_request_id";

const ORDER_COLUMNS =
  "id, patient_id, status, signed_at, sent_at, link_version, customer_email, customer_phone, customer_name, order_reference, documents, items, expires_at, created_at";

export async function loadSetupBoard(
  orgId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<SetupBoard> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? BOARD_CAP, 1), BOARD_CAP);
  const supabase = getOrgScopedClient(orgId);

  const [setupRes, fitRes, morning] = await Promise.all([
    supabase
      .from("patient_setups")
      .select(SETUP_COLUMNS)
      .eq("status", "open")
      .order("opened_at", { ascending: true })
      .limit(limit),
    supabase
      .from("fitter_fit_requests")
      .select("id, email, full_name, status, recommended_mask_name, created_at")
      .neq("status", "closed")
      .order("created_at", { ascending: true })
      .limit(BATCH_CAP),
    loadMorningCounts(orgId, now),
  ]);
  if (setupRes.error) throw setupRes.error;
  if (fitRes.error) throw fitRes.error;

  const setups = asRows<SetupRow>(setupRes.data);
  const fitRequests = asRows<FitRequestRow>(fitRes.data);
  const work = await assembleWork(orgId, setups, fitRequests, now);

  const emailToPatient = await matchUniquePatientsByEmail(
    supabase,
    fitRequests.map((row) => row.email),
  );
  const setupPatientIds = new Set(setups.map((row) => row.patient_id));
  const synthetic: SetupBoardRow[] = [];
  for (const request of fitRequests) {
    const email = request.email.trim().toLowerCase();
    const patientId = emailToPatient.get(email) ?? null;
    if (patientId && setupPatientIds.has(patientId)) continue;
    if (synthetic.length + work.length >= limit) break;
    synthetic.push({
      id: `fit:${request.id}`,
      kind: "fit_request",
      patientId,
      displayName: request.full_name?.trim() || "Fit request",
      source: "fit_request",
      openedAt: request.created_at,
      ageHours: ageHours(request.created_at, now),
      stage: "fit",
      blocker: patientId
        ? "Fit request is waiting. Open a setup on the chart to assign an owner."
        : "Fit request is waiting. Match it to one chart before opening a setup.",
      href: "/admin/fitter-requests",
      ownerUserId: null,
      ownerEmail: null,
    });
  }

  const rows = [...work, ...synthetic]
    .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt))
    .slice(0, limit);

  return { rows, morning, work };
}

export interface SetupWorkPage {
  work: SetupWorkItem[];
  next: { openedAt: string; id: string } | null;
}

/** One page of open setups for the chase. The cursor is independent
 *  of the board's display cap, so a blocked first page cannot hide
 *  the rest. */
export async function loadSetupWorkPage(
  orgId: string,
  opts: {
    limit: number;
    after?: { openedAt: string; id: string } | null;
    now?: Date;
  },
): Promise<SetupWorkPage> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const supabase = getOrgScopedClient(orgId);
  let query = supabase
    .from("patient_setups")
    .select(SETUP_COLUMNS)
    .eq("status", "open")
    .order("opened_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (opts.after) {
    query = query.or(
      `opened_at.gt.${opts.after.openedAt},and(opened_at.eq.${opts.after.openedAt},id.gt.${opts.after.id})`,
    );
  }
  const [setupRes, fitRes] = await Promise.all([
    query,
    supabase
      .from("fitter_fit_requests")
      .select("id, email, full_name, status, recommended_mask_name, created_at")
      .neq("status", "closed")
      .order("created_at", { ascending: true })
      .limit(BATCH_CAP),
  ]);
  if (setupRes.error) throw setupRes.error;
  if (fitRes.error) throw fitRes.error;
  const fetched = asRows<SetupRow>(setupRes.data);
  const page = fetched.slice(0, limit);
  const work = await assembleWork(
    orgId,
    page,
    asRows<FitRequestRow>(fitRes.data),
    now,
  );
  const tail = page[page.length - 1];
  return {
    work,
    next:
      fetched.length > limit && tail
        ? { openedAt: tail.opened_at, id: tail.id }
        : null,
  };
}

async function assembleWork(
  orgId: string,
  setups: SetupRow[],
  fitRequests: FitRequestRow[],
  now: Date,
): Promise<SetupWorkItem[]> {
  const patientIds = [...new Set(setups.map((row) => row.patient_id))];
  const signals = await loadSignals(
    orgId,
    patientIds,
    setups
      .map((row) => row.csr_order_request_id)
      .filter((id): id is string => Boolean(id)),
  );
  const emailIndex = await matchUniquePatientsByEmail(
    getOrgScopedClient(orgId),
    [
      ...fitRequests.map((row) => row.email),
      ...[...signals.patients.values()].flatMap((row) =>
        row.email ? [row.email] : [],
      ),
    ],
  );
  const links: Array<{
    id: string;
    stored: string | null;
    next: string | null;
  }> = [];
  const work = setups.map((row) => {
    const patient = signals.patients.get(row.patient_id);
    const classified = classifyPatient(
      row,
      patient,
      fitRequests,
      signals,
      emailIndex,
    );
    links.push({
      id: row.id,
      stored: row.csr_order_request_id,
      next: classified.orderId,
    });
    return {
      id: row.id,
      kind: "setup" as const,
      patientId: row.patient_id,
      displayName: displayName(patient),
      source: row.source,
      openedAt: row.opened_at,
      ageHours: ageHours(row.opened_at, now),
      stage: classified.classification.stage,
      blocker: classified.classification.blocker,
      href: classified.classification.href,
      ownerUserId: row.owner_user_id,
      ownerEmail: row.owner_email,
      blockerClearedNotifiedAt: row.blocker_cleared_notified_at,
      signatureReminder24At: row.signature_reminder_24_at,
      signatureReminder48At: row.signature_reminder_48_at,
      reminderOrderId: row.reminder_order_id,
      reminderLinkVersion: row.reminder_link_version,
      checklistComplete: classified.signals.checklistComplete,
      order: classified.signals.order,
      priorAuth: classified.signals.priorAuth,
      signatureTarget: classified.signatureTarget,
    };
  });
  await persistOrderLinks(orgId, links);
  return work;
}

async function persistOrderLinks(
  orgId: string,
  links: Array<{ id: string; stored: string | null; next: string | null }>,
): Promise<void> {
  const supabase = getOrgScopedClient(orgId);
  await Promise.all(
    links.map(async (row) => {
      if (!row.next || row.next === row.stored) return;
      let query = supabase
        .from("patient_setups")
        .update({
          csr_order_request_id: row.next,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "open");
      query = row.stored
        ? query.eq("csr_order_request_id", row.stored)
        : query.is("csr_order_request_id", null);
      const { error } = await query;
      if (error) {
        logger.warn(
          { err: redactDbErr(error) },
          "patient setup: order link persist failed",
        );
      }
    }),
  );
}

async function loadMorningCounts(
  orgId: string,
  now: Date,
): Promise<MorningCounts> {
  const supabase = getOrgScopedClient(orgId);
  const twoDaysAgo = new Date(
    now.getTime() - 2 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const [reviews, fits, packets, auths] = await Promise.all([
    supabase
      .from("referral_reviews")
      .select("id")
      .in("status", [
        "pending",
        "extracted",
        "failed",
        "offline",
        "unsupported",
      ])
      .limit(BATCH_CAP),
    supabase
      .from("fitter_fit_requests")
      .select("created_at")
      .neq("status", "closed")
      .lt(
        "created_at",
        new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      )
      .limit(BATCH_CAP),
    supabase
      .from("patient_packets")
      .select("id")
      .in("status", ["sent", "viewed"])
      .lt("sent_at", twoDaysAgo)
      .limit(BATCH_CAP),
    supabase
      .from("prior_authorizations")
      .select("mco_sla_status")
      .eq("status", "submitted")
      .limit(BATCH_CAP),
  ]);
  for (const res of [reviews, fits, packets, auths]) {
    if (res.error) throw res.error;
  }
  const stale = asRows<{ created_at: string }>(fits.data).filter((row) =>
    olderThanOneBusinessDay(new Date(row.created_at), now),
  ).length;
  const inSla = asRows<{ mco_sla_status: string | null }>(auths.data).filter(
    (row) =>
      row.mco_sla_status !== "missed" && row.mco_sla_status !== "decided",
  ).length;
  return {
    openReferralReviews: asRows(reviews.data).length,
    staleFitRequests: stale,
    unsignedPackets: asRows(packets.data).length,
    priorAuthsInSla: inSla,
  };
}

interface SignalBundle {
  patients: Map<string, PatientRow>;
  coverage: Map<string, CoverageRow>;
  eligibility: Map<string, EligibilityRow>;
  sameOrSimilar: Map<string, SameOrSimilarRow>;
  forms: Map<string, Set<string>>;
  orders: Map<string, OrderRow[]>;
  ordersById: Map<string, OrderRow>;
  fulfillments: FulfillmentRow[];
  payerRequires: Map<string, boolean | null>;
  priorAuths: Map<string, PriorAuthRow[]>;
  checklist: Map<string, Set<string>>;
}

function emptySignals(): SignalBundle {
  return {
    patients: new Map(),
    coverage: new Map(),
    eligibility: new Map(),
    sameOrSimilar: new Map(),
    forms: new Map(),
    orders: new Map(),
    ordersById: new Map(),
    fulfillments: [],
    payerRequires: new Map(),
    priorAuths: new Map(),
    checklist: new Map(),
  };
}

async function loadSignals(
  orgId: string,
  patientIds: string[],
  linkedOrderIds: string[],
): Promise<SignalBundle> {
  if (patientIds.length === 0) return emptySignals();

  const supabase = getOrgScopedClient(orgId);
  const [
    patients,
    coverages,
    eligibility,
    sameOrSimilar,
    forms,
    orders,
    fulfillments,
    priorAuths,
    checklist,
    payers,
  ] = await Promise.all([
    supabase
      .from("patients")
      .select("id, legal_first_name, legal_last_name, email, timezone")
      .in("id", patientIds),
    supabase
      .from("insurance_coverages")
      .select("id, patient_id, payer_name, member_id")
      .in("patient_id", patientIds)
      .eq("rank", "primary")
      .limit(BATCH_CAP),
    supabase
      .from("eligibility_checks")
      .select(
        "patient_id, insurance_coverage_id, service_hcpcs, status, is_active, requires_prior_auth, requested_at",
      )
      .in("patient_id", patientIds)
      .eq("service_hcpcs", "E0601")
      .order("requested_at", { ascending: false })
      .limit(BATCH_CAP),
    supabase
      .from("medicare_same_or_similar_checks")
      .select("patient_id, hcpcs_code, status, checked_at")
      .in("patient_id", patientIds)
      .eq("hcpcs_code", "E0601")
      .order("checked_at", { ascending: false })
      .limit(BATCH_CAP),
    supabase
      .from("patient_form_acknowledgements")
      .select("patient_id, form_kind")
      .in("patient_id", patientIds)
      .limit(BATCH_CAP),
    supabase
      .from("csr_order_requests")
      .select(ORDER_COLUMNS)
      .in("patient_id", patientIds)
      .order("sent_at", { ascending: false })
      .limit(BATCH_CAP),
    supabase
      .from("fulfillments")
      .select("patient_id, status, shipped_at, csr_order_request_id, item_sku")
      .in("patient_id", patientIds)
      .limit(BATCH_CAP),
    supabase
      .from("prior_authorizations")
      .select("patient_id, hcpcs_code, status")
      .in("patient_id", patientIds)
      .eq("hcpcs_code", "E0601")
      .limit(BATCH_CAP),
    supabase
      .from("setup_checklist_items")
      .select("patient_id, step_key, status")
      .in("patient_id", patientIds)
      .limit(BATCH_CAP),
    supabase
      .from("payer_profiles")
      .select("display_name, requires_prior_auth_dme")
      .eq("is_active", true)
      .limit(BATCH_CAP),
  ]);
  for (const res of [
    patients,
    coverages,
    eligibility,
    sameOrSimilar,
    forms,
    orders,
    fulfillments,
    priorAuths,
    checklist,
    payers,
  ]) {
    if (res.error) throw res.error;
  }

  const bundle = emptySignals();
  for (const row of asRows<PatientRow>(patients.data)) {
    bundle.patients.set(row.id, row);
  }
  bundle.coverage = latestBy(
    asRows<CoverageRow>(coverages.data),
    (row) => row.patient_id,
  );
  const primaryCoverageId = new Map<string, string>();
  for (const [patientId, coverage] of bundle.coverage) {
    primaryCoverageId.set(patientId, coverage.id);
  }
  bundle.eligibility = latestBy(
    asRows<EligibilityRow>(eligibility.data).filter(
      (row) =>
        row.service_hcpcs === "E0601" &&
        row.insurance_coverage_id === primaryCoverageId.get(row.patient_id),
    ),
    (row) => row.patient_id,
  );
  bundle.sameOrSimilar = latestBy(
    asRows<SameOrSimilarRow>(sameOrSimilar.data),
    (row) => row.patient_id,
  );
  for (const row of asRows<FormRow>(forms.data)) {
    const set = bundle.forms.get(row.patient_id) ?? new Set<string>();
    set.add(row.form_kind);
    bundle.forms.set(row.patient_id, set);
  }
  const rememberOrder = (row: OrderRow) => {
    bundle.ordersById.set(row.id, row);
    if (!row.patient_id) return;
    const list = bundle.orders.get(row.patient_id) ?? [];
    if (list.some((order) => order.id === row.id)) return;
    list.push(row);
    bundle.orders.set(row.patient_id, list);
  };
  for (const row of asRows<OrderRow>(orders.data)) rememberOrder(row);
  const missingOrderIds = [...new Set(linkedOrderIds)].filter(
    (id) => !bundle.ordersById.has(id),
  );
  if (missingOrderIds.length > 0) {
    const { data, error } = await supabase
      .from("csr_order_requests")
      .select(ORDER_COLUMNS)
      .in("id", missingOrderIds);
    if (error) throw error;
    for (const row of asRows<OrderRow>(data)) rememberOrder(row);
  }
  bundle.fulfillments = asRows<FulfillmentRow>(fulfillments.data);
  for (const row of asRows<PriorAuthRow>(priorAuths.data)) {
    const list = bundle.priorAuths.get(row.patient_id) ?? [];
    list.push(row);
    bundle.priorAuths.set(row.patient_id, list);
  }
  for (const row of asRows<ChecklistRow>(checklist.data)) {
    if (row.status !== "done" && row.status !== "na") continue;
    const set = bundle.checklist.get(row.patient_id) ?? new Set<string>();
    set.add(row.step_key);
    bundle.checklist.set(row.patient_id, set);
  }
  for (const row of asRows<{
    display_name: string | null;
    requires_prior_auth_dme: boolean | null;
  }>(payers.data)) {
    const key = row.display_name?.trim().toLowerCase();
    if (!key) continue;
    const value = row.requires_prior_auth_dme === true;
    const current = bundle.payerRequires.get(key);
    if (current === undefined) bundle.payerRequires.set(key, value);
    else if (current !== value) bundle.payerRequires.set(key, null);
  }
  return bundle;
}

function payerRequiresFlag(
  payerName: string | null | undefined,
  flags: Map<string, boolean | null>,
): boolean | null {
  const key = payerName?.trim().toLowerCase() ?? "";
  if (!key || !flags.has(key)) return null;
  return flags.get(key) ?? null;
}

function classifyPatient(
  row: SetupRow,
  patient: PatientRow | undefined,
  fitRequests: FitRequestRow[],
  signals: SignalBundle,
  emailIndex: Map<string, string>,
): {
  signals: SetupSignals;
  classification: ReturnType<typeof classifySetup>;
  signatureTarget: SignatureTarget | null;
  orderId: string | null;
} {
  const patientId = row.patient_id;
  const email = patient?.email?.trim().toLowerCase() ?? "";
  const ownsEmail = Boolean(email) && emailIndex.get(email) === patientId;
  const mine = ownsEmail
    ? fitRequests.filter(
        (request) => request.email.trim().toLowerCase() === email,
      )
    : [];
  const coverage = signals.coverage.get(patientId);
  const eligibility = signals.eligibility.get(patientId);
  const same = signals.sameOrSimilar.get(patientId);
  const acknowledged = signals.forms.get(patientId) ?? new Set<string>();
  const doneSteps = signals.checklist.get(patientId) ?? new Set<string>();
  const patientOrders = signals.orders.get(patientId) ?? [];
  const linked = row.csr_order_request_id
    ? signals.ordersById.get(row.csr_order_request_id)
    : undefined;
  const pool =
    linked && !patientOrders.some((order) => order.id === linked.id)
      ? [...patientOrders, linked]
      : patientOrders;
  const orderId = chooseSetupOrder({
    linkedOrderId: row.csr_order_request_id,
    openedAt: row.opened_at,
    orders: pool,
  });
  const chosen = orderId ? signals.ordersById.get(orderId) : undefined;
  const machineRows = chosen
    ? signals.fulfillments.filter(
        (fulfillment) =>
          fulfillment.csr_order_request_id === chosen.id &&
          isMachineFulfillment(fulfillment.item_sku, chosen.items),
      )
    : [];

  let order: SetupSignals["order"] = "none";
  if (machineRows.some((fulfillment) => fulfillment.shipped_at)) {
    order = "shipped";
  } else if (
    machineRows.some((fulfillment) => fulfillment.status === "queued")
  ) {
    order = "queued";
  } else if (chosen?.signed_at || chosen?.status === "signed") {
    order = "signed_needs_followup";
  } else if (
    chosen &&
    (chosen.status === "sent" || chosen.status === "viewed")
  ) {
    order = "awaiting_signature";
  }

  const medicare = /medicare/i.test(coverage?.payer_name ?? "");
  const authRecorded = priorAuthState(signals.priorAuths.get(patientId) ?? []);
  const priorAuth: SetupSignals["priorAuth"] = e0601PriorAuthRequired({
    payerRequiresPriorAuthDme: payerRequiresFlag(
      coverage?.payer_name,
      signals.payerRequires,
    ),
    eligibilityRequiresPriorAuth: eligibility?.requires_prior_auth ?? null,
  })
    ? authRecorded
    : "not_required";

  const hasMaskChoice =
    mine.some((request) => Boolean(request.recommended_mask_name?.trim())) ||
    order !== "none";

  const built: SetupSignals = {
    hasCoverage: Boolean(coverage),
    eligibility: eligibilityState(eligibility),
    medicare,
    sameOrSimilar: (same?.status as SetupSignals["sameOrSimilar"]) ?? "missing",
    missingForms: REQUIRED_PAPERWORK.filter((key) => !acknowledged.has(key)),
    hasMaskChoice,
    openFitRequest: mine.length > 0,
    order,
    priorAuth,
    checklistComplete: FIRST_NIGHT_STEP_KEYS.every((key) => doneSteps.has(key)),
  };

  const signatureTarget: SignatureTarget | null =
    order === "awaiting_signature" && chosen?.sent_at
      ? {
          id: chosen.id,
          linkVersion: chosen.link_version,
          sentAt: chosen.sent_at,
          email: chosen.customer_email,
          phone: chosen.customer_phone,
          customerName: chosen.customer_name,
          orderReference: chosen.order_reference,
          hasDocuments:
            Array.isArray(chosen.documents) && chosen.documents.length > 0,
          timezone: patient?.timezone ?? null,
          expiresAt: chosen.expires_at,
        }
      : null;

  return {
    signals: built,
    classification: classifySetup(built, patientId),
    signatureTarget,
    orderId,
  };
}

export function logSetupBoardFailure(err: unknown, event: string): void {
  logger.warn({ err: redactDbErr(err), event }, "patient setup board failed");
}
