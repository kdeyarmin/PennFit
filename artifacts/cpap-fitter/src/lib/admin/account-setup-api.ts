// Hand-rolled fetch wrapper for the Account Setup page
// (Settings -> Account Setup). Auth flows over the `pf_session` cookie,
// sent automatically by the browser on same-origin requests.
//
// The response mirrors the resupply-api route
// `artifacts/resupply-api/src/routes/admin/account-setup.ts`: a flat
// list of checklist items split across a "required" and an "optional"
// tab. Auto-detected items carry a live status; operator-run steps
// carry status "manual" and are ticked off in the browser.

import { ApiError } from "@workspace/api-client-react/admin";

export type AccountSetupItemStatus =
  | "complete"
  | "incomplete"
  | "manual"
  | "unknown";

export interface AccountSetupItem {
  id: string;
  tab: "required" | "optional";
  group: string;
  title: string;
  description: string;
  status: AccountSetupItemStatus;
  detail: string | null;
  docHref: string | null;
  command: string | null;
}

export interface AccountSetupResponse {
  generatedAt: string;
  environment: string | null;
  items: AccountSetupItem[];
}

export async function fetchAccountSetup(): Promise<AccountSetupResponse> {
  const url = "/resupply-api/admin/account-setup";
  const res = await fetch(url, {
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
  return (await res.json()) as AccountSetupResponse;
}
