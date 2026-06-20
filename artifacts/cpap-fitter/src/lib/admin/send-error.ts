// Friendly text for the error codes the document send/attach endpoints
// return (manual documents, packets, prescription requests, fax
// outreach all share the same codes); falls back to describeError for
// everything else.

import { ApiError } from "@workspace/api-client-react/admin";

import { describeError } from "@/components/admin/ErrorPanel";

export function sendErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | null)?.error;
    switch (code) {
      case "email_not_configured":
        return "Email sending isn't configured on this server — download the PDF instead.";
      case "fax_not_configured":
        return "Fax sending isn't configured on this server — download the PDF instead.";
      case "no_recipient_email":
        return "Enter an email address first.";
      case "no_recipient_fax":
        return "The document has no fax number on it — open it and add a recipient fax first.";
      case "packet_documents_missing":
        return "Some documents in this packet have been deleted — save the packet to drop them, then resend.";
      case "document_incomplete": {
        const data = err.data as {
          missingFields?: Array<{ label: string }>;
          incompleteDocuments?: Array<{
            title: string;
            missingFields: Array<{ label: string }>;
          }>;
        } | null;
        if (data?.missingFields?.length) {
          return `Fill in these required fields before sending: ${data.missingFields
            .map((f) => f.label)
            .join(", ")}.`;
        }
        if (data?.incompleteDocuments?.length) {
          const parts = data.incompleteDocuments.map(
            (d) =>
              `${d.title} (${d.missingFields.map((f) => f.label).join(", ")})`,
          );
          return `Some documents in this packet are missing required fields — ${parts.join(
            "; ",
          )}.`;
        }
        return "This document is missing required fields — fill them in before sending.";
      }
    }
  }
  return describeError(err).detail ?? fallback;
}
