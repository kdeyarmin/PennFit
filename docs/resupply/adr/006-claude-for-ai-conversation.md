# ADR 006 — Anthropic Claude for the AI conversation agent

## Context

The conversation agent (Phase 6) holds multi-turn dialogues with patients
across SMS, voice, and email about reorder timing, shipping address
confirmation, mask fit issues, and Medicare-required disclosures. The model
must:

1. Refuse to give clinical advice beyond pre-approved language.
2. Be reliable with structured tool use (we will give it tools to look up
   eligibility, place an order draft, escalate to a human).
3. Have a vendor BAA covering PHI in prompts and responses.
4. Be steerable enough that we can pin its responses to a tight script for
   regulatory replies.

## Decision

Use Anthropic Claude (Sonnet tier as the default; Opus for the hardest
escalation reasoning if cost allows) via the Anthropic API.

- BAA: Anthropic enterprise BAA must be executed before any real PHI is
  sent in prompts.
- Adapter: `lib/resupply-ai` exposes a `ConversationModel` interface; the
  Anthropic implementation lives behind it. Tests use a mock that returns
  scripted replies.
- Prompts: versioned and stored in the repo under
  `lib/resupply-ai/src/prompts/`. Every change goes through code review.
  The system prompt always includes the patient's pseudonymous id (not
  name) and any in-flight order context — the patient's identifying PHI
  is redacted from the prompt by a redaction layer in
  `lib/resupply-ai/src/redact.ts`.

## Consequences

- One model vendor. One BAA.
- Switching to OpenAI / Google later is a swap of the
  `ConversationModel` implementation, not a rewrite.
- The redaction layer is load-bearing. If it has bugs, real PHI leaks to
  Anthropic. Test it like consent code: 100% branch coverage required.

## Alternatives Considered

- **OpenAI GPT-4 / GPT-4o** — comparable quality. Anthropic's tool-use
  reliability and instruction-following on regulatory scripts have been
  better in our internal evals at the time of writing.
- **Self-hosted open-source model (Llama 3, Mistral)** — avoids vendor BAA
  but operating an LLM at production reliability is a separate company.
- **No AI** — rule-based only. Rejected for this product because the
  conversation surface is too varied (free-text replies about fit issues,
  shipping changes, complaints).

## TODO

- [DONE] Anthropic enterprise BAA is executed.
