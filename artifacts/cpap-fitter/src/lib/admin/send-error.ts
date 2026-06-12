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
    }
  }
  return describeError(err).detail ?? fallback;
}
