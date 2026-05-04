// Hand-rolled fetch wrappers for the admin shop-return notes
// endpoints (Phase 15). Mirrors order-notes-api.ts.

export interface AdminReturnNote {
  id: string;
  body: string;
  authorEmail: string;
  authorUserId: string | null;
  createdAt: string;
}

export interface AdminReturnNotesListResponse {
  notes: AdminReturnNote[];
}

export interface CreateAdminReturnNoteResponse {
  id: string;
  createdAt: string;
}

export class AdminReturnNotesNotFoundError extends Error {
  constructor() {
    super("Return not found.");
  }
}

export async function listAdminReturnNotes(
  returnId: string,
): Promise<AdminReturnNotesListResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/returns/${encodeURIComponent(returnId)}/notes`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new AdminReturnNotesNotFoundError();
  }
  if (!res.ok) {
    throw new Error(`Failed to load notes (${res.status})`);
  }
  return (await res.json()) as AdminReturnNotesListResponse;
}

export async function createAdminReturnNote(
  returnId: string,
  body: string,
): Promise<CreateAdminReturnNoteResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/returns/${encodeURIComponent(returnId)}/notes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (res.status === 404) {
    throw new AdminReturnNotesNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to save note (${res.status}): ${text}`);
  }
  return (await res.json()) as CreateAdminReturnNoteResponse;
}
