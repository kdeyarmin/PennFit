// Assemble a packet's signed PDF from the database.
//
// One loader for every consumer of the rendered packet — the admin
// download route and the auto-file-to-chart hook — so the bytes a CSR
// downloads and the bytes filed on the chart can never drift. Loads
// the packet, its document snapshots (token-form sections resolved
// here), the latest signature, and the company profile, then renders
// via packet-pdf.ts.
//
// PHI posture: returns PDF bytes + ids only; nothing is logged here.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { resolveCompanyProfile } from "./company";
import { renderPacketDocumentSections } from "./content";
import { renderPatientPacketPdf, type PacketPdfInput } from "./packet-pdf";
import { PROOF_OF_DELIVERY_KEY } from "./templates";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface SignedPacketPdf {
  pdf: Buffer;
  packet: {
    id: string;
    patientId: string | null;
    title: string;
    status: string;
    completedAt: string | null;
  };
  /** True when the packet includes the Medicare Proof of Delivery —
   *  drives the stricter chart retention horizon at the call site. */
  includesProofOfDelivery: boolean;
}

/** Load + render one packet's signed PDF, or null when the packet does
 *  not exist. */
export async function buildSignedPacketPdf(
  supabase: SupabaseClient,
  packetId: string,
): Promise<SignedPacketPdf | null> {
  const { data: packet, error } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .select(
      "id, patient_id, title, status, recipient_name, recipient_email, recipient_phone, sent_at, completed_at, delivery_details",
    )
    .eq("id", packetId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!packet) return null;

  const [docsRes, sigRes, company] = await Promise.all([
    supabase
      .schema("resupply")
      .from("patient_packet_documents")
      .select(
        "document_key, title, requires_signature, content_version, content_sections, sort_order",
      )
      .eq("packet_id", packet.id)
      .order("sort_order", { ascending: true }),
    supabase
      .schema("resupply")
      .from("patient_packet_signatures")
      .select("*")
      .eq("packet_id", packet.id)
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    resolveCompanyProfile(supabase),
  ]);
  if (docsRes.error) throw docsRes.error;
  if (sigRes.error) throw sigRes.error;

  const sig = sigRes.data;
  const docs = docsRes.data ?? [];
  const deliveryDetails = (packet.delivery_details ??
    null) as PacketPdfInput["deliveryDetails"];
  const { pdf } = await renderPatientPacketPdf({
    packetId: packet.id,
    title: packet.title,
    company,
    patient: { name: packet.recipient_name },
    status: packet.status,
    sentAt: packet.sent_at,
    completedAt: packet.completed_at,
    documents: docs.map((d) => ({
      documentKey: d.document_key,
      title: d.title,
      requiresSignature: d.requires_signature,
      contentVersion: d.content_version,
      // Snapshot rows render their send-time content (tokens resolved
      // here); legacy rows fall back to the code template inside the
      // renderer.
      sections: d.content_sections
        ? renderPacketDocumentSections({
            documentKey: d.document_key,
            storedSections: d.content_sections,
            company,
            recipientName: packet.recipient_name,
            recipientEmail: packet.recipient_email,
            recipientPhone: packet.recipient_phone,
            deliveryDetails,
          })
        : null,
    })),
    deliveryDetails,
    signature: sig
      ? {
          signerName: sig.signer_name,
          signerRelationship: sig.signer_relationship,
          signatureImage: sig.signature_image,
          consentEsign: sig.consent_esign,
          signedAt: sig.signed_at,
          signerIp: sig.signer_ip,
          signerUserAgent: sig.signer_user_agent,
          signerReason: sig.signer_reason,
          dateReceived: sig.date_received,
          documentChoices:
            (sig.document_choices as Record<string, string> | null) ?? null,
        }
      : null,
  });

  return {
    pdf,
    packet: {
      id: packet.id,
      patientId: packet.patient_id,
      title: packet.title,
      status: packet.status,
      completedAt: packet.completed_at,
    },
    includesProofOfDelivery: docs.some(
      (d) => d.document_key === PROOF_OF_DELIVERY_KEY,
    ),
  };
}
