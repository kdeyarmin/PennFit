// Fetch wrapper for POST /admin/conversations/:id/draft-reply (CSR #15).
// Asks the server to AI-draft the next reply; returns a soft result the
// composer uses to populate the textarea (the CSR edits before sending).
// Degrades to available:false when AI isn't configured.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type DraftUnavailableReason =
  | "offline"
  | "provider_unsupported"
  | "model_error"
  | "empty";

export type DraftReplyResponse =
  | { available: true; draft: string; provider: string; redactions: number }
  | {
      available: false;
      reason: DraftUnavailableReason;
      redactions: number;
    };

export async function draftConversationReply(
  conversationId: string,
): Promise<DraftReplyResponse> {
  const url = `/resupply-api/admin/conversations/${encodeURIComponent(
    conversationId,
  )}/draft-reply`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as DraftReplyResponse;
}

/** Human-friendly note for the degraded reasons. */
export function draftUnavailableNote(reason: DraftUnavailableReason): string {
  switch (reason) {
    case "offline":
      return "AI drafting is offline (no model configured).";
    case "provider_unsupported":
      return "AI drafting needs Anthropic configured on the server.";
    case "model_error":
      return "The model didn't respond — try again or write the reply manually.";
    case "empty":
      return "The model returned an empty draft — try again.";
  }
}
