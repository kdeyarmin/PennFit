// Hand-authored React Query hooks for the public patient signature
// packet flow (token-gated, no login). Used by the cpap-fitter signing
// page. See lib/api-client-react/src/admin/patient-packets.ts for the
// admin-side hooks.

import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { customFetch, type ErrorType } from "./custom-fetch";

export interface PacketDocumentSection {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
}

/** One selectable option on a choice document (e.g. an ABN option). */
export interface PacketDocumentChoiceOption {
  key: string;
  label: string;
  detail: string;
}

/** A required signer-side selection (the ABN's Option 1/2/3): exactly
 *  one option must be picked before the packet can be signed. */
export interface PacketDocumentChoice {
  prompt: string;
  options: PacketDocumentChoiceOption[];
}

export interface PublicPacketDocument {
  key: string;
  title: string;
  category: string;
  requiresSignature: boolean;
  /** Present when the signer must select one option at signing time. */
  choice?: PacketDocumentChoice | null;
  sections: PacketDocumentSection[];
}

export interface PublicPacketView {
  status: "open" | "completed";
  title?: string;
  recipientName?: string;
  company?: { legalName: string; phone: string; email: string };
  /** True when the packet has a Proof of Delivery — the signer must
   *  record the date they received the equipment (a Medicare field). */
  requiresDateReceived?: boolean;
  documents: PublicPacketDocument[];
}

export type SignerRelationship =
  | "self"
  | "spouse"
  | "guardian"
  | "power_of_attorney"
  | "caregiver"
  | "other";

export interface SignPacketRequest {
  token: string;
  signerName: string;
  signerRelationship: SignerRelationship;
  signatureImage?: string | null;
  /** Required when signing as someone other than the patient. */
  signerReason?: string | null;
  /** Required (YYYY-MM-DD) when the packet has a Proof of Delivery. */
  dateReceived?: string | null;
  consentEsign: true;
  acknowledgedDocumentKeys: string[];
  /** Selections for choice documents (document key → option key);
   *  required for every document that carries a `choice`. */
  documentChoices?: Record<string, string>;
}

export interface SignPacketResponse {
  status: "completed";
  completedAt: string;
}

type PacketError = ErrorType<{ error?: string; message?: string }>;

export const getViewPatientPacketQueryKey = (token: string) =>
  ["/api/patient-packets/view", token] as const;

export function useViewPatientPacket(
  token: string,
  options?: {
    query?: Partial<UseQueryOptions<PublicPacketView, PacketError>>;
  },
) {
  return useQuery<PublicPacketView, PacketError>({
    queryKey: getViewPatientPacketQueryKey(token),
    queryFn: ({ signal }) =>
      customFetch<PublicPacketView>(
        `/api/patient-packets/view?token=${encodeURIComponent(token)}`,
        { method: "GET", signal },
      ),
    enabled: token.length > 0,
    retry: false,
    ...options?.query,
  });
}

export function useSignPatientPacket(options?: {
  mutation?: UseMutationOptions<
    SignPacketResponse,
    PacketError,
    SignPacketRequest
  >;
}) {
  return useMutation<SignPacketResponse, PacketError, SignPacketRequest>({
    mutationFn: (data) =>
      customFetch<SignPacketResponse>("/api/patient-packets/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    ...options?.mutation,
  });
}
