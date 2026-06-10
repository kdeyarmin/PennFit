// Hand-authored React Query hooks for the patient signature-packet
// admin endpoints (no OpenAPI/orval pipeline — see CLAUDE.md). Mirrors
// the shape of the generated hooks but stays compact.

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";

export type PacketDocumentCategory =
  | "instructions"
  | "consent"
  | "privacy"
  | "rights"
  | "financial"
  | "delivery";

/** One structured block of document content. Strings may carry
 *  {{merge_tokens}} resolved server-side at send/render time. */
export interface PacketDocumentSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface PacketMergeToken {
  token: string;
  label: string;
}

export interface PatientPacketTemplate {
  key: string;
  /** Effective title (the operator's override when customized). */
  title: string;
  defaultTitle: string;
  category: PacketDocumentCategory;
  version: string;
  summary: string;
  requiresSignature: boolean;
  defaultIncluded: boolean;
  /** Compliance-mandatory documents the UI locks into every packet. */
  required: boolean;
  /** True when a permanent operator override is in effect. */
  customized: boolean;
  /** Effective content in token form (override or code default). */
  sections: PacketDocumentSection[];
  /** The built-in default, for diffing / revert preview. */
  defaultSections: PacketDocumentSection[];
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export interface PatientPacketTemplatesResponse {
  templates: PatientPacketTemplate[];
  mergeTokens: PacketMergeToken[];
}

/** A one-off content edit applied to a single packet's document. */
export interface PacketDocumentOverride {
  documentKey: string;
  title?: string;
  sections: PacketDocumentSection[];
}

export interface PacketDeliveryItem {
  description: string;
  hcpcs?: string | null;
  quantity?: number | null;
}

export interface PacketDeliveryDetails {
  items?: PacketDeliveryItem[];
  deliveryDate?: string | null;
  deliveryAddress?: string | null;
  orderRef?: string | null;
}

export type PatientPacketStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "completed"
  | "voided"
  | "expired";

export interface PatientPacketSummary {
  id: string;
  /** Null when the packet was sent to a contact that matched no patient. */
  patient_id: string | null;
  title: string;
  status: PatientPacketStatus;
  recipient_name: string;
  recipient_email: string | null;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface PatientPacketDocumentRow {
  id: string;
  packet_id: string;
  document_key: string;
  title: string;
  content_version: string;
  sort_order: number;
  requires_signature: boolean;
  acknowledged: boolean;
  acknowledged_at: string | null;
  /** Send-time content snapshot (token form); null on legacy rows. */
  content_sections: PacketDocumentSection[] | null;
  created_at: string;
}

export interface PatientPacketSignatureRow {
  id: string;
  signer_name: string;
  signer_relationship: string;
  consent_esign: boolean;
  acknowledged_document_keys: string[];
  signed_at: string;
  signer_ip: string | null;
  created_at: string;
}

export interface PatientPacketDetail {
  packet: PatientPacketSummary & {
    link_version: number;
    first_viewed_at: string | null;
    voided_at: string | null;
    voided_reason: string | null;
    created_by_email: string | null;
    updated_at: string;
    /** Itemized Proof of Delivery snapshot, when one was captured. */
    delivery_details: PacketDeliveryDetails | null;
  };
  documents: PatientPacketDocumentRow[];
  signature: PatientPacketSignatureRow | null;
  signingLink: string | null;
}

export type PacketChannel = "email" | "sms";

export interface SendPatientPacketRequest {
  documentKeys?: string[];
  title?: string;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  /** Delivery channels. Omitted = every channel the patient has on file. */
  channels?: PacketChannel[];
  /** Itemized Proof of Delivery snapshot. */
  deliveryDetails?: PacketDeliveryDetails | null;
  /** One-off content edits for this packet alone. */
  documentOverrides?: PacketDocumentOverride[];
  expiresInDays?: number;
}

export interface SendPatientPacketResponse {
  id: string;
  status: string;
  emailSent: boolean;
  smsSent: boolean;
  signingLink: string;
}

/**
 * Send a packet to a typed-in email and/or phone with no patient
 * selected. At least one of `email` / `phone` must be provided. When
 * the contact resolves to a single patient (directly, or via a linked
 * portal account) the packet is filed onto that patient's chart.
 */
export interface SendPacketToContactRequest {
  email?: string | null;
  phone?: string | null;
  recipientName?: string | null;
  documentKeys?: string[];
  title?: string;
  channels?: PacketChannel[];
  /** Itemized Proof of Delivery snapshot. */
  deliveryDetails?: PacketDeliveryDetails | null;
  /** One-off content edits for this packet alone. */
  documentOverrides?: PacketDocumentOverride[];
  expiresInDays?: number;
}

/**
 * Edit an open (unsigned) packet: change its document set, title, and/or
 * the itemized Proof of Delivery snapshot. Every field is optional; send
 * only what changed. Rejected (409) on completed or voided packets.
 */
export interface UpdatePatientPacketRequest {
  documentKeys?: string[];
  title?: string;
  deliveryDetails?: PacketDeliveryDetails | null;
  /** One-off content edits for this open packet's documents. */
  documentOverrides?: PacketDocumentOverride[];
}

export interface UpdatePatientPacketResponse {
  status: string;
  documentCount: number | null;
}

export interface SendPacketToContactResponse {
  id: string;
  status: string;
  emailSent: boolean;
  smsSent: boolean;
  signingLink: string;
  /** The patient chart the packet was filed under, or null if unlinked. */
  matchedPatientId: string | null;
  matchedPatientName: string | null;
  /** True when the contact matched 2+ patients, so it was left unlinked. */
  matchAmbiguous: boolean;
}

type PacketError = ErrorType<{ error?: string; message?: string }>;

// ── URLs + query keys ─────────────────────────────────────────────
const TEMPLATES_URL = "/resupply-api/admin/patient-packet-templates";
const ALL_PACKETS_URL = "/resupply-api/admin/patient-packets";

export const getPatientPacketTemplatesQueryKey = () => [TEMPLATES_URL] as const;
export const getAllPatientPacketsQueryKey = (status?: string) =>
  [ALL_PACKETS_URL, ...(status ? [status] : [])] as const;
export const getPatientPacketsQueryKey = (patientId: string) =>
  [`/resupply-api/admin/patients/${patientId}/packets`] as const;
export const getPatientPacketQueryKey = (packetId: string) =>
  [`/resupply-api/admin/packets/${packetId}`] as const;

export const patientPacketPdfUrl = (packetId: string): string =>
  `/resupply-api/admin/packets/${packetId}/pdf`;

// ── Queries ───────────────────────────────────────────────────────
export function usePatientPacketTemplates(options?: {
  query?: Partial<UseQueryOptions<PatientPacketTemplatesResponse, PacketError>>;
}) {
  return useQuery<PatientPacketTemplatesResponse, PacketError>({
    queryKey: getPatientPacketTemplatesQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<PatientPacketTemplatesResponse>(TEMPLATES_URL, {
        method: "GET",
        signal,
      }),
    ...options?.query,
  });
}

export function useAllPatientPackets(
  status?: string,
  options?: {
    query?: Partial<
      UseQueryOptions<{ packets: PatientPacketSummary[] }, PacketError>
    >;
  },
) {
  const url = status
    ? `${ALL_PACKETS_URL}?status=${encodeURIComponent(status)}`
    : ALL_PACKETS_URL;
  return useQuery<{ packets: PatientPacketSummary[] }, PacketError>({
    queryKey: getAllPatientPacketsQueryKey(status),
    queryFn: ({ signal }) =>
      customFetch<{ packets: PatientPacketSummary[] }>(url, {
        method: "GET",
        signal,
      }),
    ...options?.query,
  });
}

export function usePatientPackets(
  patientId: string,
  options?: {
    query?: Partial<
      UseQueryOptions<{ packets: PatientPacketSummary[] }, PacketError>
    >;
  },
) {
  return useQuery<{ packets: PatientPacketSummary[] }, PacketError>({
    queryKey: getPatientPacketsQueryKey(patientId),
    queryFn: ({ signal }) =>
      customFetch<{ packets: PatientPacketSummary[] }>(
        `/resupply-api/admin/patients/${patientId}/packets`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

export function usePatientPacket(
  packetId: string,
  options?: {
    query?: Partial<UseQueryOptions<PatientPacketDetail, PacketError>>;
  },
) {
  return useQuery<PatientPacketDetail, PacketError>({
    queryKey: getPatientPacketQueryKey(packetId),
    queryFn: ({ signal }) =>
      customFetch<PatientPacketDetail>(
        `/resupply-api/admin/packets/${packetId}`,
        { method: "GET", signal },
      ),
    ...options?.query,
  });
}

// ── Template editing ──────────────────────────────────────────────

export interface SavePacketTemplateRequest {
  title?: string;
  sections: PacketDocumentSection[];
}

/** PUT a permanent template override (applies to all future packets). */
export function useSavePacketTemplate(options?: {
  mutation?: UseMutationOptions<
    { key: string; revision: number; customized: boolean },
    PacketError,
    { key: string; data: SavePacketTemplateRequest }
  >;
}) {
  return useMutation<
    { key: string; revision: number; customized: boolean },
    PacketError,
    { key: string; data: SavePacketTemplateRequest }
  >({
    mutationFn: ({ key, data }) =>
      customFetch(`${TEMPLATES_URL}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}

/** Revert a template to the built-in default (deletes the override). */
export function useResetPacketTemplate(options?: {
  mutation?: UseMutationOptions<
    { key: string; customized: boolean },
    PacketError,
    { key: string }
  >;
}) {
  return useMutation<
    { key: string; customized: boolean },
    PacketError,
    { key: string }
  >({
    mutationFn: ({ key }) =>
      customFetch(`${TEMPLATES_URL}/${encodeURIComponent(key)}`, {
        method: "DELETE",
      }),
    ...options?.mutation,
  });
}

export interface PreviewPacketTemplateResponse {
  key: string;
  title: string;
  /** Sections with merge tokens resolved against live company data. */
  sections: PacketDocumentSection[];
}

/** Preview a template (optionally with unsaved draft sections) exactly
 *  as a patient would see it. Read-only despite the POST. */
export function usePreviewPacketTemplate(options?: {
  mutation?: UseMutationOptions<
    PreviewPacketTemplateResponse,
    PacketError,
    { key: string; title?: string; sections?: PacketDocumentSection[] }
  >;
}) {
  return useMutation<
    PreviewPacketTemplateResponse,
    PacketError,
    { key: string; title?: string; sections?: PacketDocumentSection[] }
  >({
    mutationFn: ({ key, title, sections }) =>
      customFetch(`${TEMPLATES_URL}/${encodeURIComponent(key)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sections }),
      }),
    ...options?.mutation,
  });
}

// ── Mutations ─────────────────────────────────────────────────────
export function useSendPatientPacket(options?: {
  mutation?: UseMutationOptions<
    SendPatientPacketResponse,
    PacketError,
    { patientId: string; data: SendPatientPacketRequest }
  >;
}) {
  return useMutation<
    SendPatientPacketResponse,
    PacketError,
    { patientId: string; data: SendPatientPacketRequest }
  >({
    mutationFn: ({ patientId, data }) =>
      customFetch<SendPatientPacketResponse>(
        `/resupply-api/admin/patients/${patientId}/packets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      ),
    ...options?.mutation,
  });
}

export function useSendPacketToContact(options?: {
  mutation?: UseMutationOptions<
    SendPacketToContactResponse,
    PacketError,
    SendPacketToContactRequest
  >;
}) {
  return useMutation<
    SendPacketToContactResponse,
    PacketError,
    SendPacketToContactRequest
  >({
    mutationFn: (data) =>
      customFetch<SendPacketToContactResponse>(ALL_PACKETS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}

export function useResendPatientPacket(options?: {
  mutation?: UseMutationOptions<
    {
      status: string;
      emailSent: boolean;
      smsSent: boolean;
      signingLink: string;
    },
    PacketError,
    { packetId: string; channels?: PacketChannel[] }
  >;
}) {
  return useMutation<
    {
      status: string;
      emailSent: boolean;
      smsSent: boolean;
      signingLink: string;
    },
    PacketError,
    { packetId: string; channels?: PacketChannel[] }
  >({
    mutationFn: ({ packetId, channels }) =>
      customFetch(`/resupply-api/admin/packets/${packetId}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(channels ? { channels } : {}),
      }),
    ...options?.mutation,
  });
}

export function useVoidPatientPacket(options?: {
  mutation?: UseMutationOptions<
    { status: string },
    PacketError,
    { packetId: string; reason?: string }
  >;
}) {
  return useMutation<
    { status: string },
    PacketError,
    { packetId: string; reason?: string }
  >({
    mutationFn: ({ packetId, reason }) =>
      customFetch(`/resupply-api/admin/packets/${packetId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }),
    ...options?.mutation,
  });
}

export function useUpdatePatientPacket(options?: {
  mutation?: UseMutationOptions<
    UpdatePatientPacketResponse,
    PacketError,
    { packetId: string; data: UpdatePatientPacketRequest }
  >;
}) {
  return useMutation<
    UpdatePatientPacketResponse,
    PacketError,
    { packetId: string; data: UpdatePatientPacketRequest }
  >({
    mutationFn: ({ packetId, data }) =>
      customFetch<UpdatePatientPacketResponse>(
        `/resupply-api/admin/packets/${packetId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      ),
    ...options?.mutation,
  });
}
