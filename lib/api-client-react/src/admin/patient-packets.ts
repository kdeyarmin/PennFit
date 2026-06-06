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

export interface PatientPacketTemplate {
  key: string;
  title: string;
  category: PacketDocumentCategory;
  version: string;
  summary: string;
  requiresSignature: boolean;
  defaultIncluded: boolean;
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
  patient_id: string;
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
  expiresInDays?: number;
}

export interface SendPatientPacketResponse {
  id: string;
  status: string;
  emailSent: boolean;
  smsSent: boolean;
  signingLink: string;
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
  query?: Partial<
    UseQueryOptions<{ templates: PatientPacketTemplate[] }, PacketError>
  >;
}) {
  return useQuery<{ templates: PatientPacketTemplate[] }, PacketError>({
    queryKey: getPatientPacketTemplatesQueryKey(),
    queryFn: ({ signal }) =>
      customFetch<{ templates: PatientPacketTemplate[] }>(TEMPLATES_URL, {
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
