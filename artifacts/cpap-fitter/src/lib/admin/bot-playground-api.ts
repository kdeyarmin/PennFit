// Hand-rolled fetch wrappers for /admin/bot-playground — backs the
// admin Bot Playground page. Same pattern as connection-tests-api.ts
// (cookie auth + CSRF header on the POST).
//
// The playground runs the storefront / account / voice bots against
// synthetic context and simulated tools, so nothing here touches real
// customer data. Each run returns the bot's reply plus the list of tool
// calls it made (so the team can see tool-selection behaviour).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type BotKind = "storefront" | "account" | "voice";
export type LlmProvider = "anthropic" | "openai" | "offline";
export type VoiceCallerKind = "patient" | "shop_customer";

export interface PlaygroundScenario {
  id: string;
  bot: BotKind;
  label: string;
  description: string;
  firstUserMessage: string;
  config?: PlaygroundConfig;
}

export interface PlaygroundLatestOrder {
  orderId: string;
  sessionId: string;
  amountTotalCents: number;
  paidAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  shipCityState: string | null;
}

export interface PlaygroundAccountConfig {
  displayName?: string | null;
  memberSince?: string | null;
  totalPaidOrders?: number;
  activeSubscriptionCount?: number;
  latestOrder?: PlaygroundLatestOrder | null;
  device?: {
    manufacturer: string;
    model: string;
    pressureSetting: string | null;
  } | null;
}

export interface PlaygroundVoiceConfig {
  practiceName?: string;
  callerName?: string;
  callContext?: string;
  callerKind?: VoiceCallerKind;
}

export interface PlaygroundConfig {
  account?: PlaygroundAccountConfig;
  voice?: PlaygroundVoiceConfig;
}

export interface PlaygroundInfo {
  provider: LlmProvider;
  scenarios: PlaygroundScenario[];
  limits: { maxTurns: number; maxMessageChars: number };
}

export interface PlaygroundMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlaygroundToolCall {
  name: string;
  input: Record<string, unknown>;
  simulated: boolean;
  resultPreview: string;
}

export interface PlaygroundRunResult {
  reply: string;
  toolCalls: PlaygroundToolCall[];
  provider: LlmProvider;
  model: string;
  rounds: number;
  offline?: boolean;
  degraded?: boolean;
}

export interface PlaygroundPromptInfo {
  bot: BotKind;
  systemPrompt: string;
  chars: number;
  promptVersion?: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const getPlaygroundInfo = () =>
  jsonFetch<PlaygroundInfo>("/admin/bot-playground/info");

export const getPlaygroundPrompt = (
  bot: BotKind,
  callerKind?: VoiceCallerKind,
) => {
  const params = new URLSearchParams({ bot });
  if (bot === "voice" && callerKind) params.set("callerKind", callerKind);
  return jsonFetch<PlaygroundPromptInfo>(
    `/admin/bot-playground/prompt?${params.toString()}`,
  );
};

export const runPlayground = (body: {
  bot: BotKind;
  messages: PlaygroundMessage[];
  config?: PlaygroundConfig;
}) =>
  jsonFetch<PlaygroundRunResult>("/admin/bot-playground/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
