// /admin/conversations-search?q= — search conversations by message
// CONTENT (CSR #13). The inbox is filterable by status / channel / view
// but had no search-by-content; this runs a bounded ILIKE over message
// bodies and returns the matching conversations (most-recent matching
// message as a snippet), so a CSR can find "that thread about a leaking
// mask".
//
// Distinct path (not /admin/conversations/search) so it can't be shadowed
// by the /admin/conversations/:id routes.
//
// PHI posture: message bodies ARE PHI. A snippet is returned to the
// authenticated CSR (it's their tool) but NEVER logged — the safe log is
// the result count + query length only, never the term or any body. No
// pg_trgm index (the DB runs extension-free); a bounded LIMIT keeps the
// on-demand seq-scan cheap.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z.object({
  q: z.string().trim().min(2).max(120),
});

router.get(
  "/admin/conversations-search",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_query", message: "q must be 2–120 chars." });
      return;
    }
    const q = parsed.data.q;
    // Escape LIKE wildcards so a literal term isn't treated as a pattern.
    const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("messages")
      .select("conversation_id, body, direction, created_at")
      .ilike("body", `%${esc}%`)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    // Dedupe to one hit per conversation — the rows are newest-first, so
    // the first time we see a conversation_id is its most-recent match.
    const seen = new Map<
      string,
      {
        conversationId: string;
        snippet: string;
        direction: string;
        matchedAt: string;
      }
    >();
    for (const m of (data ?? []) as Array<Record<string, unknown>>) {
      const cid =
        typeof m.conversation_id === "string" ? m.conversation_id : "";
      if (cid === "" || seen.has(cid)) continue;
      seen.set(cid, {
        conversationId: cid,
        snippet: String(m.body ?? "").slice(0, 200),
        direction: typeof m.direction === "string" ? m.direction : "",
        matchedAt: typeof m.created_at === "string" ? m.created_at : "",
      });
    }
    const results = [...seen.values()].slice(0, 50);

    // Count + query LENGTH only — never the term or any snippet (PHI).
    req.log?.info(
      { count: results.length, qLength: q.length, adminEmail: req.adminEmail },
      "admin.conversations.search",
    );

    res.json({ results, count: results.length });
  },
);

export default router;
