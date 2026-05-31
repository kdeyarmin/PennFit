// /admin/work-items — the unified, prioritized CSR work queue (roadmap
// F4). One call UNIONs the OPEN work across every triage source —
// conversations, returns, reviews, patient documents, followups (shop +
// patient), inbound faxes — into a single list, oldest / most-overdue
// first. Mirrors the source set + filters of /admin/inbox-counts (which
// counts the same queues for the nav badges); this returns the rows.
//
// A read model: no new writes. Each source query is index-backed + capped
// and runs in parallel; the merge + sort is a pure, tested helper. No PHI
// in the payload — ids + timestamps + kind only (per-source patient
// context / snippets are a follow-up enrichment).

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const PER_SOURCE_LIMIT = 50;

export type WorkItemKind =
  | "conversation"
  | "return"
  | "review"
  | "patient_document"
  | "followup"
  | "fax";

export interface WorkItem {
  kind: WorkItemKind;
  refId: string;
  createdAt: string;
  dueAt: string | null;
  /** The timestamp urgency sorts on: dueAt for followups, else createdAt. */
  sortAt: string;
  /** Hours past due for followups (>= 0); null for non-due items. */
  overdueHours: number | null;
}

type RawRow = Record<string, unknown>;

export interface WorkItemSources {
  conversations: RawRow[];
  returns: RawRow[];
  reviews: RawRow[];
  documents: RawRow[];
  shopFollowups: RawRow[];
  patientFollowups: RawRow[];
  faxes: RawRow[];
}

/**
 * Merge + normalize + sort the open rows from every source into one
 * prioritized queue. Pure + exported for testing. Oldest sortAt first =
 * longest-waiting / most-overdue at the top.
 */
export function buildWorkItems(
  sources: WorkItemSources,
  nowIso: string,
): WorkItem[] {
  const now = Date.parse(nowIso);
  const items: WorkItem[] = [];

  const add = (kind: WorkItemKind, rows: RawRow[], withDue: boolean): void => {
    for (const r of rows) {
      const refId = typeof r.id === "string" ? r.id : String(r.id ?? "");
      if (refId === "") continue;
      const createdAt =
        typeof r.created_at === "string" ? r.created_at : nowIso;
      const dueAt = withDue && typeof r.due_at === "string" ? r.due_at : null;
      const sortAt = dueAt ?? createdAt;
      const overdueHours =
        dueAt != null
          ? Math.max(0, (now - Date.parse(dueAt)) / 3_600_000)
          : null;
      items.push({ kind, refId, createdAt, dueAt, sortAt, overdueHours });
    }
  };

  add("conversation", sources.conversations, false);
  add("return", sources.returns, false);
  add("review", sources.reviews, false);
  add("patient_document", sources.documents, false);
  add("followup", sources.shopFollowups, true);
  add("followup", sources.patientFollowups, true);
  add("fax", sources.faxes, false);

  items.sort((a, b) => Date.parse(a.sortAt) - Date.parse(b.sortAt));
  return items;
}

router.get("/admin/work-items", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  const results = await Promise.all([
    supabase
      .schema("resupply")
      .from("conversations")
      .select("id, created_at")
      .eq("status", "awaiting_admin")
      .order("created_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    supabase
      .schema("resupply")
      .from("shop_returns")
      .select("id, created_at")
      .in("status", ["requested", "shipped_back", "received"])
      .order("created_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    supabase
      .schema("resupply")
      .from("shop_reviews")
      .select("id, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, created_at")
      .is("reviewed_at", null)
      .order("created_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    supabase
      .schema("resupply")
      .from("shop_customer_followups")
      .select("id, created_at, due_at")
      .is("completed_at", null)
      .lt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    supabase
      .schema("resupply")
      .from("patient_followups")
      .select("id, created_at, due_at")
      .is("completed_at", null)
      .lt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
    supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, created_at")
      .eq("status", "new")
      .order("created_at", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
  ]);
  for (const r of results) {
    if (r.error) throw r.error;
  }
  const rows = results.map((r) => (r.data ?? []) as RawRow[]);

  const workItems = buildWorkItems(
    {
      conversations: rows[0] ?? [],
      returns: rows[1] ?? [],
      reviews: rows[2] ?? [],
      documents: rows[3] ?? [],
      shopFollowups: rows[4] ?? [],
      patientFollowups: rows[5] ?? [],
      faxes: rows[6] ?? [],
    },
    nowIso,
  );

  res.json({ workItems, count: workItems.length, serverTime: nowIso });
});

export default router;
