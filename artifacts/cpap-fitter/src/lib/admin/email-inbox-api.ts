// Hand-rolled fetch wrapper + React Query hook for /admin/email-inbox.
//
// Powers the Email Inbox page: inbound patient emails split into two
// mailboxes — "needs response" (a human still owes a reply) and
// "responded" (answered by the chatbot auto-reply or a CSR). Opening an
// email reuses the existing /admin/conversations/:id thread view, so this
// module only needs the list + the two mailbox counts.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { ApiError } from "@workspace/api-client-react/admin";

export type EmailMailbox = "needs_response" | "responded";

export interface EmailInboxItem {
  id: string;
  patientId: string | null;
  patientFirstName: string;
  patientLastName: string;
  patientEmail: string | null;
  episodeId: string | null;
  status: string;
  subject: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  lastMessagePreview: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  lastMessageSenderRole: string | null;
  lastMessageAutoReply: boolean;
}

export interface EmailInboxResponse {
  mailbox: EmailMailbox;
  items: EmailInboxItem[];
  total: number;
  limit: number;
  offset: number;
  counts: {
    needsResponse: number;
    responded: number;
  };
}

export interface EmailInboxParams {
  mailbox: EmailMailbox;
  limit: number;
  offset: number;
}

export async function fetchEmailInbox(
  params: EmailInboxParams,
): Promise<EmailInboxResponse> {
  const search = new URLSearchParams({
    mailbox: params.mailbox,
    limit: String(params.limit),
    offset: String(params.offset),
  });
  const url = `/resupply-api/admin/email-inbox?${search.toString()}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as EmailInboxResponse;
}

export function emailInboxQueryKey(params: EmailInboxParams) {
  return ["admin", "email-inbox", params.mailbox, params.limit, params.offset];
}

export function useEmailInbox(params: EmailInboxParams) {
  return useQuery({
    queryKey: emailInboxQueryKey(params),
    queryFn: () => fetchEmailInbox(params),
    placeholderData: keepPreviousData,
  });
}
