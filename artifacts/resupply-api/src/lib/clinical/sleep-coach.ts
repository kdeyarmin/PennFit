// Sleep coach LLM endpoint.
//
// 24/7 patient-portal-scoped LLM assistant for CPAP therapy
// troubleshooting (modeled on ResMed myAir "Dawn", 2025-2026).
// The patient asks "why is my mask leaking?" / "what's a normal AHI?"
// and we ground the reply in their last 7-day therapy snapshot.
//
// PHI posture:
//   The model gets:
//     - patient initials + DOB year only
//     - last-7-day rollup: avg usage minutes, avg AHI, max leak,
//       compliant-nights-out-of-7
//     - device model + mask type when present
//   The model does NOT get:
//     - full name, address, member id, phone
//     - any free-text clinical note
//   Same containment posture as the AI claim scrubber.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 15_000;

export const SLEEP_COACH_PROMPT_VERSION = "coach-1.0";

const SYSTEM_PROMPT = [
  "You are a HIPAA-compliant CPAP sleep-therapy coach. The patient is",
  "logged into a Pennsylvania DME's patient portal. They ask a question",
  "about their CPAP therapy; you reply with practical, friendly,",
  "evidence-aligned guidance grounded in their last 7 days of therapy",
  "data (provided in the context payload).",
  "",
  "RULES:",
  "- Be conversational. Address the patient as 'you'.",
  "- Quote specific numbers from their data when relevant.",
  "- Recommend concrete, non-medical actions (mask refit, headgear",
  "  check, humidifier setting). Do NOT give clinical advice like",
  "  changing pressure settings or stopping therapy — defer to their",
  "  physician for those.",
  "- If they describe a symptom you cannot address (chest pain,",
  "  severe daytime sleepiness, suspected infection), recommend they",
  "  contact their physician or 911 as appropriate.",
  "- Maximum 200 words. Plain text only — no markdown, no headings,",
  "  no bullet points (the patient app renders plain text).",
  "- NEVER reveal patient PHI even though some context is provided.",
  "  You may reference their data (\"your average usage is 5.2 hours\")",
  "  but never their name, DOB, address, or member ID — those are",
  "  not in the context anyway.",
].join("\n");

export interface SleepCoachInput {
  patientId: string;
  question: string;
  /** Optional thread of prior turns for context (oldest first). */
  thread?: Array<{ role: "patient" | "coach"; body: string }>;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SleepCoachReply {
  reply: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}

export async function askSleepCoach(input: SleepCoachInput): Promise<SleepCoachReply> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      reply: null,
      errorMessage: "OPENAI_API_KEY not configured",
      latencyMs: null,
    };
  }
  const context = await assembleContext(input.patientId);
  const userMessage = buildUserMessage(input.question, input.thread ?? [], context);
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
        model: input.apiKey ? DEFAULT_MODEL : DEFAULT_MODEL,
        temperature: 0.3,
        max_tokens: 350,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logger.warn(
        {
          event: "sleep_coach_http_error",
          status: res.status,
          detail: detail.slice(0, 200),
        },
        "sleep-coach: openai HTTP error",
      );
      return {
        reply: null,
        errorMessage: `openai http ${res.status}`,
        latencyMs,
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim() ?? "";
    return {
      reply: content ? content.slice(0, 1500) : null,
      errorMessage: null,
      latencyMs,
    };
  } catch (err) {
    return {
      reply: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function assembleContext(
  patientId: string,
): Promise<Record<string, unknown>> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("legal_first_name, legal_last_name, date_of_birth")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: nights } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("night_date, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o")
    .eq("patient_id", patientId)
    .gte("night_date", since)
    .limit(14);
  const withData = (nights ?? []).filter((n) => n.usage_minutes !== null);
  const avgUsageMin = withData.length
    ? Math.round(
        withData.reduce((s, n) => s + (n.usage_minutes ?? 0), 0) / withData.length,
      )
    : null;
  // ahi + leak_rate are stored as numeric → strings; parseFloat per-row.
  const ahiVals = withData
    .map((n) => (n.ahi ? Number.parseFloat(n.ahi) : Number.NaN))
    .filter((a) => Number.isFinite(a));
  const avgAhi = ahiVals.length
    ? Number((ahiVals.reduce((s, v) => s + v, 0) / ahiVals.length).toFixed(1))
    : null;
  const leakVals = withData
    .map((n) =>
      n.leak_rate_l_min ? Number.parseFloat(n.leak_rate_l_min) : 0,
    )
    .filter((v) => Number.isFinite(v));
  const maxLeak = leakVals.length ? Math.round(Math.max(...leakVals)) : null;
  const compliantNights = withData.filter(
    (n) => (n.usage_minutes ?? 0) >= 240,
  ).length;
  return {
    patient: {
      initials: initials(
        patient?.legal_first_name ?? "",
        patient?.legal_last_name ?? "",
      ),
      dobYear: yearOf(patient?.date_of_birth ?? null),
    },
    last7Days: {
      daysWithData: withData.length,
      compliantNightsOf7: compliantNights,
      avgUsageMinutes: avgUsageMin,
      avgAhi,
      maxLeakRateLMin: maxLeak,
    },
  };
}

function buildUserMessage(
  question: string,
  thread: Array<{ role: "patient" | "coach"; body: string }>,
  context: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push("CONTEXT (patient's therapy data, PHI-safe):");
  lines.push(JSON.stringify(context));
  if (thread.length > 0) {
    lines.push("");
    lines.push("PRIOR CONVERSATION (oldest first):");
    for (const t of thread.slice(-6)) {
      lines.push(`- ${t.role}: ${t.body.slice(0, 400)}`);
    }
  }
  lines.push("");
  lines.push("PATIENT QUESTION:");
  lines.push(question.slice(0, 1000));
  return lines.join("\n");
}

function initials(first: string, last: string): string {
  const f = first.trim()[0] ?? "";
  const l = last.trim()[0] ?? "";
  return `${f.toUpperCase()}${l.toUpperCase()}`;
}
function yearOf(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})/.exec(iso);
  return m ? Number(m[1]) : null;
}
