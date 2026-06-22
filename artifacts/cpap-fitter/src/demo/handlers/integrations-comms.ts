// Integrations / FHIR / multi-channel-comms handlers.
//
// These admin surfaces (Device-data integrations, webhook subscriptions,
// the FHIR R4 read API, and the voice / video / fax / email / staffing
// operations pages) read deeply-nested, fully-shaped responses from their
// API endpoints. The demo router's benign empty-object/empty-list fallback
// would leave them blank or crash a `.length`/nested deref, so each route
// here returns realistic sample data matching the live route's exact JSON
// shape. FHIR routes return FHIR R4 resources (CapabilityStatement /
// Patient / searchset Bundle). All data is fictional — no real PHI.
//
// Both `/resupply-api` and `/api` mount the same server router; the SPA's
// hand-rolled clients all call the `/resupply-api/...` form, so that's what
// is seeded here (mirroring the rest of the demo handlers).

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoIntegrationsStatus,
  demoIntegrationsErrors,
  demoIntegrationsRetry,
  demoNightlySyncResult,
  demoPatientIntegrations,
  demoWebhookSubscriptions,
  demoWebhookDeliveries,
  demoWebhookEventCatalog,
  demoVoiceMetrics,
  demoVideoVisits,
  demoCreateVideoVisit,
  demoInboundFaxes,
  demoInboundFaxDetail,
  demoFaxSettings,
  demoOutboundMessages,
  demoEmailInbox,
  demoStaffingLive,
  demoOfficeHours,
  demoSupportTickets,
  demoSupportTicketDetail,
  demoOpsStatus,
  demoFhirCapabilityStatement,
  demoFhirPatient,
  demoFhirEverything,
} from "../fixtures/integrations-comms";

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** FHIR responses carry the `application/fhir+json` content-type. The demo
 *  clients parse it like any JSON body; matching the type keeps the wire
 *  shape faithful to the live FHIR routes. */
function fhirJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/fhir+json" },
  });
}

export const integrationsCommsHandlers: DemoHandler[] = [
  // ── Integrations: status / errors / nightly-sync ─────────────────────
  route("GET", "/resupply-api/admin/integrations/status", () =>
    json(demoIntegrationsStatus()),
  ),
  route("GET", "/resupply-api/admin/integrations/errors", () =>
    json(demoIntegrationsErrors()),
  ),
  route("POST", "/resupply-api/admin/integrations/errors/retry", (req) => {
    const body = req.json<{ snapshotIds?: string[] }>() ?? {};
    return json(demoIntegrationsRetry(body.snapshotIds ?? []));
  }),
  route("POST", "/resupply-api/admin/integrations/nightly-sync", () =>
    json(demoNightlySyncResult()),
  ),

  // ── Patient unified Device-data view + refresh ───────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/integrations",
    (_req, { id }) => json(demoPatientIntegrations(id)),
  ),
  route(
    "POST",
    "/resupply-api/admin/patients/:id/integrations/refresh",
    (_req, { id }) => {
      const view = demoPatientIntegrations(id);
      return json({
        snapshot: view.sources[0]!.snapshot,
        nightsPersisted: 14,
        settingsChanges: [],
        equipment: { kind: "matched", assetId: "demo-asset-1" },
        recallNotificationsQueued: 0,
        smartTriggers: null,
      });
    },
  ),

  // ── Webhooks: subscriptions / deliveries / event catalog ─────────────
  route("GET", "/resupply-api/admin/webhook-subscriptions", () =>
    json(demoWebhookSubscriptions()),
  ),
  route("GET", "/resupply-api/admin/webhook-deliveries", (req) =>
    json(demoWebhookDeliveries(req.query.get("subscriptionId"))),
  ),
  route("GET", "/resupply-api/admin/webhook-event-catalog", () =>
    json(demoWebhookEventCatalog()),
  ),
  // Prominent mutations — benign success in the live shape.
  route("POST", "/resupply-api/admin/webhook-subscriptions", () =>
    json(
      { id: "demo-wh-sub-new", signingSecret: "demo-whsec-not-a-real-secret" },
      201,
    ),
  ),
  route("POST", "/resupply-api/admin/webhook-subscriptions/:id/test-send", () =>
    json(
      {
        ok: true,
        deliveryId: "demo-wh-del-test",
        note: "queued; the dispatcher will attempt within ~60 seconds",
      },
      202,
    ),
  ),

  // ── Voice metrics ────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/voice/metrics", (req) =>
    json(demoVoiceMetrics(intParam(req, "days", 30))),
  ),

  // ── Video visits ─────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/video-visits", () =>
    json(demoVideoVisits()),
  ),
  route("POST", "/resupply-api/admin/patients/:id/video-visits", () =>
    json(demoCreateVideoVisit("demo-vv-new"), 201),
  ),
  route("POST", "/resupply-api/admin/video-visits", () =>
    json(demoCreateVideoVisit("demo-vv-new"), 201),
  ),

  // ── Inbound faxes ────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/inbound-faxes", () =>
    json(demoInboundFaxes()),
  ),
  // `:id` matches one segment, so it would also shadow the static
  // sub-routes (/media, /ocr, /auto-file). Those are POST or media-stream
  // paths, while this is the GET detail — only answer the GET detail here.
  route("GET", "/resupply-api/admin/inbound-faxes/:id", (_req, { id }) =>
    json(demoInboundFaxDetail(id)),
  ),
  route("PATCH", "/resupply-api/admin/inbound-faxes/:id", (_req, { id }) =>
    json({ id, changed: true }),
  ),

  // ── Fax settings (tenant's own number) ───────────────────────────────
  route("GET", "/resupply-api/admin/organization/fax-settings", () =>
    json(demoFaxSettings()),
  ),

  // ── Outbound message send log ────────────────────────────────────────
  route("GET", "/resupply-api/admin/outbound-messages", (req) =>
    json(
      demoOutboundMessages({
        channel: req.query.get("channel"),
        result: req.query.get("result"),
        sinceDays: intParam(req, "sinceDays", 14),
        limit: intParam(req, "limit", 50),
        offset: intParam(req, "offset", 0),
      }),
    ),
  ),

  // ── Email inbox ──────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/email-inbox", (req) => {
    const mailbox =
      req.query.get("mailbox") === "responded"
        ? ("responded" as const)
        : ("needs_response" as const);
    return json(
      demoEmailInbox({
        mailbox,
        limit: intParam(req, "limit", 25),
        offset: intParam(req, "offset", 0),
      }),
    );
  }),

  // ── Live staffing snapshot ───────────────────────────────────────────
  route("GET", "/resupply-api/admin/staffing/live", () =>
    json(demoStaffingLive()),
  ),

  // ── Office hours ─────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/office-hours", () =>
    json(demoOfficeHours()),
  ),

  // ── Support tickets ──────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/support/tickets", () =>
    json(demoSupportTickets()),
  ),
  route("GET", "/resupply-api/admin/support/tickets/:id", (_req, { id }) =>
    json(demoSupportTicketDetail(id)),
  ),

  // ── Operations center status ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/ops-status", () => json(demoOpsStatus())),

  // ── FHIR R4 (read-only interop surface) ──────────────────────────────
  route("GET", "/resupply-api/fhir/r4/metadata", () =>
    fhirJson(demoFhirCapabilityStatement()),
  ),
  // `$everything` is a literal segment with a `$`; register it BEFORE the
  // bare Patient/:id so the more-specific operation path wins.
  route(
    "GET",
    "/resupply-api/fhir/r4/Patient/:id/$everything",
    (_req, { id }) => fhirJson(demoFhirEverything(id)),
  ),
  route("GET", "/resupply-api/fhir/r4/Patient/:id", (_req, { id }) =>
    fhirJson(demoFhirPatient(id)),
  ),
];
