// Smart Notes — AI-reviewed, Medicare-compliance-checked clinical notes.
//
//   POST /patients/:id/smart-notes/review  — run the compliance review +
//        chart cross-check + trend comparison WITHOUT saving. Powers the
//        "review before you save" UX so the nurse can fix gaps first.
//   POST /patients/:id/smart-notes         — save the note. Re-runs the
//        review server-side (authoritative — never trusts a client-
//        supplied verdict) and freezes the review + trend snapshot onto
//        the row.
//   GET  /patients/:id/smart-notes         — newest-first timeline.
//
// Append-only by design (mirrors patient_notes): no PATCH/DELETE.
//
// PHI: note_text + review prose carry PHI. Audit + logs record only
// structural metadata (score, compliant, lengths) — never the bodies.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  assembleSmartNoteContext,
  compareSmartNote,
  reviewSmartNote,
  type PreviousSmartNote,
  type SmartNoteComparison,
  type SmartNoteReview,
} from "../../lib/clinical/smart-note-compliance";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const bodySchema = z
  .object({
    noteText: z
      .string()
      .trim()
      .min(1, "Note cannot be empty.")
      .max(6000, "Note must be 6000 characters or fewer."),
  })
  .strict();

const router: IRouter = Router();

type SmartNoteRow = {
  id: string;
  note_text: string | null;
  author_email: string | null;
  author_user_id: string | null;
  compliant: boolean | null;
  compliance_score: number | null;
  review: unknown;
  comparison: unknown;
  review_provider: string | null;
  prompt_version: string | null;
  created_at: string;
};

function serialize(row: SmartNoteRow) {
  return {
    id: row.id,
    noteText: row.note_text ?? "",
    authorEmail: row.author_email,
    authorUserId: row.author_user_id,
    compliant: row.compliant ?? false,
    complianceScore: row.compliance_score ?? 0,
    review: (row.review ?? {}) as unknown,
    comparison: (row.comparison ?? {}) as unknown,
    reviewProvider: row.review_provider ?? "offline",
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

// Resolve the patient (404 on miss) and the chart context + previous
// note needed by both the review and save paths. Returns null after
// writing the response when the patient is missing / tenant is absent.
async function loadContext(req: Request, res: Response, patientId: string) {
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return null;
  }
  const supabase = getOrgScopedClient(orgId);

  const { data: patient } = await supabase
    .from("patients")
    .select("id, status")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (!patient) {
    res.status(404).json({ error: "not_found" });
    return null;
  }

  const chart = await assembleSmartNoteContext(
    supabase as never,
    patientId,
    (patient as { status: string | null }).status ?? null,
  );

  const { data: prevRows } = await supabase
    .from("smart_notes")
    .select("id, note_text, review, created_at")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(1);
  const prevRow = (prevRows ?? [])[0] as
    | {
        id: string;
        note_text: string | null;
        review: unknown;
        created_at: string;
      }
    | undefined;
  const previous: PreviousSmartNote | null = prevRow
    ? {
        id: prevRow.id,
        noteText: prevRow.note_text ?? "",
        createdAt: prevRow.created_at,
        reviewSummary:
          (prevRow.review as { summary?: string } | null)?.summary ?? null,
      }
    : null;

  return { supabase, chart, previous };
}

async function runReview(
  noteText: string,
  ctx: {
    chart: Awaited<ReturnType<typeof assembleSmartNoteContext>>;
    previous: PreviousSmartNote | null;
  },
): Promise<{ review: SmartNoteReview; comparison: SmartNoteComparison }> {
  // Review + trend comparison are independent calls — run concurrently.
  const [review, comparison] = await Promise.all([
    reviewSmartNote({ noteText, chart: ctx.chart }),
    compareSmartNote({ noteText, previous: ctx.previous }),
  ]);
  return { review, comparison };
}

// POST /patients/:id/smart-notes/review — preview, no persistence.
router.post(
  "/patients/:id/smart-notes/review",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = bodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const ctx = await loadContext(req, res, idParsed.data.id);
    if (!ctx) return;

    const { review, comparison } = await runReview(
      bodyParsed.data.noteText,
      ctx,
    );

    logger.info(
      {
        event: "smart_note_review_preview",
        patient_id: idParsed.data.id,
        provider: review.provider,
        score: review.score,
        compliant: review.compliant,
      },
      "smart-note review preview",
    );

    res.json({ review, comparison });
  },
);

// POST /patients/:id/smart-notes — save (re-runs review authoritatively).
router.post(
  "/patients/:id/smart-notes",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = bodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const patientId = idParsed.data.id;
    const { noteText } = bodyParsed.data;

    const ctx = await loadContext(req, res, patientId);
    if (!ctx) return;

    const { review, comparison } = await runReview(noteText, ctx);

    const { data: row, error } = await ctx.supabase
      .from("smart_notes")
      .insert({
        patient_id: patientId,
        note_text: noteText,
        author_email: req.adminEmail ?? "<unknown>",
        author_user_id: req.adminUserId ?? null,
        compliant: review.compliant,
        compliance_score: review.score,
        review,
        comparison,
        review_provider: review.provider,
        prompt_version: review.promptVersion,
      })
      .select(
        "id, note_text, author_email, author_user_id, compliant, compliance_score, review, comparison, review_provider, prompt_version, created_at",
      )
      .single();
    if (error) throw error;

    await logAudit({
      action: "patient.smart_note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "smart_notes",
      targetId: row.id,
      // Structural metadata only — never the note body or review prose.
      metadata: {
        patient_id: patientId,
        note_length: noteText.length,
        compliant: review.compliant,
        score: review.score,
        provider: review.provider,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.smart_note.create audit write failed");
    });

    res.status(201).json(serialize(row as SmartNoteRow));
  },
);

// GET /patients/:id/smart-notes — newest-first timeline (up to 50).
router.get(
  "/patients/:id/smart-notes",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    const { data: patient } = await supabase
      .from("patients")
      .select("id")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: rows, error } = await supabase
      .from("smart_notes")
      .select(
        "id, note_text, author_email, author_user_id, compliant, compliance_score, review, comparison, review_provider, prompt_version, created_at",
      )
      .eq("patient_id", parsed.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    res.json({
      notes: ((rows ?? []) as SmartNoteRow[]).map(serialize),
    });
  },
);

export default router;
