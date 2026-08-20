// Client for /admin/message-previews — the patient's-eye view of every
// outbound SMS and email, plus the send-a-test action.
//
// Gated server-side by requirePermission("admin.tools.manage"). Mirrors
// the jsonFetch pattern in the other hand-rolled admin clients.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export type PreviewGroup = "resupply" | "orders" | "clinical" | "billing";

export interface PreviewEmail {
  subject: string;
  html: string;
  text: string;
}

export interface PreviewSms {
  body: string;
  /** One non-GSM-7 character flips the whole message to UCS-2. */
  encoding: "GSM-7" | "UCS-2";
  characters: number;
  units: number;
  segments: number;
}

export interface MessagePreview {
  id: string;
  group: PreviewGroup;
  label: string;
  description: string;
  trigger: string;
  /**
   * `exact` — the preview calls the production renderer, so it is
   * byte-for-byte what the patient gets. `mirrored` — the copy is
   * duplicated from a send path that can't be imported; a drift test
   * pins it to the source.
   */
  fidelity: "exact" | "mirrored";
  source: string;
  email: PreviewEmail | null;
  sms: PreviewSms | null;
}

export interface MessagePreviewsResponse {
  brand: {
    name: string;
    legalName: string;
    supportPhoneDisplay: string;
    baseUrl: string;
  };
  previews: MessagePreview[];
}

export type SendTestResult =
  | { ok: true; channel: "email" | "sms"; id: string; segments?: number }
  | {
      ok: false;
      channel: "email" | "sms";
      code: "not_configured" | "upstream_error";
      message: string;
    };

export function fetchMessagePreviews(): Promise<MessagePreviewsResponse> {
  return jsonFetch<MessagePreviewsResponse>("/admin/message-previews");
}

/**
 * Deliver one catalog scenario, for real, to `to`. The body is chosen by
 * `id` server-side — this cannot send arbitrary text.
 *
 * A vendor that isn't configured resolves to a 200 with `ok: false` (the
 * request succeeded; the send reported failure), so callers inspect `ok`
 * rather than catching.
 */
export function sendMessagePreview(
  id: string,
  channel: "email" | "sms",
  to: string,
): Promise<SendTestResult> {
  return jsonFetch<SendTestResult>(
    `/admin/message-previews/${encodeURIComponent(id)}/send`,
    { method: "POST", body: JSON.stringify({ channel, to }) },
  );
}

export const GROUP_LABELS: Record<PreviewGroup, string> = {
  resupply: "Resupply reminders",
  orders: "Orders & shipping",
  clinical: "Clinical & compliance",
  billing: "Billing",
};

export const GROUP_ORDER: PreviewGroup[] = [
  "resupply",
  "orders",
  "clinical",
  "billing",
];
