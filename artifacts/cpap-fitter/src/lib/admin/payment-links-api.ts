// Hand-rolled fetch wrapper for the staff "send a payment link" endpoint
// (POST /resupply-api/admin/patients/:id/payment-link). Auth rides on the
// in-house `pf_session` cookie via `credentials: "include"`; admin
// mutations need the CSRF header.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type PaymentLinkChannel = "email" | "sms";

export interface SendPaymentLinkBody {
  channel: PaymentLinkChannel;
  /** Amount to collect, in whole cents (Stripe USD minimum is 50). */
  amountCents: number;
  /** Optional memo shown to the patient on the Stripe page + receipt. */
  memo?: string;
  /** Optional contact overrides when the chart has none on file. */
  email?: string;
  phoneE164?: string;
}

export interface SendPaymentLinkResponse {
  paymentId: string;
  channel: PaymentLinkChannel;
  /** True when the email/SMS was handed to the vendor. False when the
   *  vendor isn't configured in this env — the link is still returned. */
  delivered: boolean;
  deliveryError: string | null;
  amountCents: number;
  /** Hosted Stripe Checkout URL — always returned so staff can copy and
   *  share it directly. */
  paymentUrl: string;
}

export async function sendPatientPaymentLink(
  patientId: string,
  body: SendPaymentLinkBody,
): Promise<SendPaymentLinkResponse> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(
    patientId,
  )}/payment-link`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SendPaymentLinkResponse | unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "POST", url });
  return json as SendPaymentLinkResponse;
}
