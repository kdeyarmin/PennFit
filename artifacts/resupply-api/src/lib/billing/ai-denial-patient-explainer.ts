// AI patient-facing denial explainer.
//
// Different audience + prompt from the AI denial analyzer (which is
// CSR-facing). This module returns a friendly, plain-English email
// the patient can understand: what was denied, why (in non-jargon),
// what we're doing about it, and what (if anything) they need to do.
//
// Triggered by the CSR after a denial lands so the patient hears
// from us before they call asking "why was my claim denied?".
//
// PHI posture: same as the CSR-facing analyzer — initials + DOB year +
// HCPCS / modifiers / amounts only.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

export const EXPLAINER_PROMPT_VERSION = "patient-explainer-1.0";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 15_000;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = [
  "You write friendly, plain-English emails explaining insurance",
  "denials to patients of a Pennsylvania DME (durable medical",
  "equipment) supplier. The patient just had a claim denied by their",
  "insurance and may not understand why.",
  "",
  "RULES:",
  "- Address the patient as 'you'. Keep the tone warm and matter-of-fact.",
  "- Translate every CARC/RARC code into plain English. Never quote",
  "  the raw codes back to the patient unless absolutely necessary.",
  "- State what we're doing next on their behalf. We typically file",
  "  an appeal, contact the payer, or work with the prescriber to",
  "  resubmit. Make it clear they don't have to do anything unless",
  "  we explicitly ask.",
  "- If the denial is for missing prior authorization, explain that",
  "  we'll work with their doctor to file it.",
  "- If the denial is for missing documentation (sleep study, etc.),",
  "  explain that we'll request the records.",
  "- If the denial is a coverage-limit (LTM reached, item not covered),",
  "  explain the financial implications honestly and mention they may",
  "  be billed.",
  "- DO NOT promise specific outcomes. Use language like 'we expect'",
  "  / 'we are confident'.",
  "- Maximum 200 words. Plain text — no markdown, no headings.",
  "- NEVER include the patient's full name, DOB, address, or member",
  "  ID — those aren't in the context anyway.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the object:",
  "{",
  '  "subject": "<email subject line, max 80 chars>",',
  '  "body": "<email body, max 1500 chars>",',
  '  "tone": "informational" | "action_required" | "billing_notice"',
  "}",
].join("\n");

export interface ExplainerInput {
  claimId: string;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ExplainerOutput {
  subject: string;
  body: string;
  tone: "informational" | "action_required" | "billing_notice";
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export async function explainDenialToPatient(
  input: ExplainerInput,
): Promise<ExplainerOutput> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return errored("OPENAI_API_KEY not configured");
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, status, payer_name, date_of_service, total_billed_cents, denial_reason",
    )
    .eq("id", input.claimId)
    .limit(1)
    .maybeSingle();
  if (!claim || claim.status !== "denied") {
    return errored("claim not found or not denied");
  }
  const { data: lines } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("hcpcs_code, denial_reason, paid_cents, allowed_cents")
    .eq("claim_id", claim.id);

  const context = {
    claim: {
      payerName: claim.payer_name,
      dateOfService: claim.date_of_service,
      headerDenialReason: claim.denial_reason,
      totalBilledCents: claim.total_billed_cents,
    },
    lines: (lines ?? []).map((l) => ({
      hcpcsCode: l.hcpcs_code,
      denialReason: l.denial_reason,
      paidCents: l.paid_cents,
      allowedCents: l.allowed_cents,
    })),
  };

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(OPENAI_API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model ?? DEFAULT_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 800,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context, null, 2) },
        ],
      }),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        "ai-denial-patient-explainer: openai HTTP error",
      );
      return errored(`openai http ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseOutput(content);
    return {
      ...parsed,
      latencyMs,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      errorMessage: null,
    };
  } catch (err) {
    return errored(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function errored(message: string): ExplainerOutput {
  return {
    subject: "An update about your recent insurance claim",
    body:
      "We're working on an update about your recent claim. " +
      "A member of our billing team will reach out shortly with " +
      "specifics about what was denied and what we're doing on " +
      "your behalf. You don't need to do anything yet.",
    tone: "informational",
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    errorMessage: message,
  };
}

function parseOutput(
  content: string,
): Omit<
  ExplainerOutput,
  "latencyMs" | "promptTokens" | "completionTokens" | "errorMessage"
> {
  try {
    const parsed = JSON.parse(content) as {
      subject?: unknown;
      body?: unknown;
      tone?: unknown;
    };
    const subject =
      typeof parsed.subject === "string"
        ? parsed.subject.slice(0, 200)
        : "An update about your recent insurance claim";
    const body =
      typeof parsed.body === "string"
        ? parsed.body.slice(0, 2000)
        : "We're working on an update.";
    const tone =
      parsed.tone === "action_required" || parsed.tone === "billing_notice"
        ? parsed.tone
        : "informational";
    return { subject, body, tone };
  } catch {
    return {
      subject: "An update about your recent insurance claim",
      body: "We're preparing an update for you.",
      tone: "informational",
    };
  }
}
