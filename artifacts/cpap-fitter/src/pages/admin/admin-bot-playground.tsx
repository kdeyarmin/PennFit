// /admin/bot-playground — admin sandbox for testing the three customer-
// facing bots (storefront PennBot, the signed-in account assistant, and
// the voice agent's text brain) against scripted situations, so the team
// can see how each behaves and tune its prompt.
//
// Everything here is safe: the account + voice bots run against synthetic
// context and simulated tools (no real customer data, no orders placed,
// no CSR messages filed). The storefront bot's mask tools touch only the
// public catalog and run for real.
//
// The outer <div> needs no `admin-root` wrapper — the AppShell content
// slot it renders into already provides one (same as the sibling
// Connection tests page).

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bot,
  FlaskConical,
  Loader2,
  Phone,
  RotateCcw,
  Send,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  getPlaygroundInfo,
  getPlaygroundPrompt,
  placeVoiceTestCall,
  runPlayground,
  type BotKind,
  type PlaygroundConfig,
  type PlaygroundPromptInfo,
  type PlaygroundScenario,
  type PlaygroundToolCall,
  type VoiceCallerKind,
} from "@/lib/admin/bot-playground-api";

interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: PlaygroundToolCall[];
  meta?: {
    provider: string;
    model: string;
    rounds: number;
    degraded?: boolean;
  };
}

const BOT_LABELS: Record<BotKind, string> = {
  storefront: "Storefront PennBot",
  account: "Account assistant",
  voice: "Voice agent",
};

const BOT_BLURB: Record<BotKind, string> = {
  storefront:
    "Public pre-purchase chatbot. Real mask tools run live (public catalog).",
  account:
    "Signed-in account assistant. Runs against synthetic account data; order/subscription/escalation tools are simulated.",
  voice:
    "Phone agent's text brain. Identity, ordering, and handoff tools are simulated so you can walk the flow without a real call.",
};

function nextId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function AdminBotPlaygroundPage() {
  const { toast } = useToast();
  const [bot, setBot] = useState<BotKind>("storefront");
  const [callerKind, setCallerKind] = useState<VoiceCallerKind>("patient");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [scenarioConfig, setScenarioConfig] = useState<PlaygroundConfig>({});
  const [prompt, setPrompt] = useState<PlaygroundPromptInfo | null>(null);
  const [callPhone, setCallPhone] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const info = useQuery({
    queryKey: ["bot-playground-info"],
    queryFn: getPlaygroundInfo,
    staleTime: 60_000,
  });

  const effectiveConfig = useMemo<PlaygroundConfig>(() => {
    if (bot !== "voice") return scenarioConfig;
    return {
      ...scenarioConfig,
      voice: { ...(scenarioConfig.voice ?? {}), callerKind },
    };
  }, [bot, scenarioConfig, callerKind]);

  const runMutation = useMutation({
    mutationFn: runPlayground,
    onSuccess: (result) => {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          content: result.reply,
          toolCalls: result.toolCalls,
          meta: {
            provider: result.provider,
            model: result.model,
            rounds: result.rounds,
            degraded: result.degraded,
          },
        },
      ]);
      if (result.offline) {
        toast({
          title: "No AI provider configured",
          description:
            "Set ANTHROPIC_API_KEY or OPENAI_API_KEY to test the bots.",
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Playground request failed",
        description: err.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  });

  const callMutation = useMutation({
    mutationFn: placeVoiceTestCall,
    onSuccess: () => {
      toast({
        title: "Calling you now",
        description:
          "Pick up and talk to the voice agent. It runs the real persona; account tools are disabled on test calls.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't place the call",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const busy = runMutation.isPending;

  function send(text: string, history: TranscriptMessage[]) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    const userMsg: TranscriptMessage = {
      id: nextId(),
      role: "user",
      content: trimmed,
    };
    const next = [...history, userMsg];
    setMessages(next);
    setDraft("");
    runMutation.mutate({
      bot,
      messages: next.map((m) => ({ role: m.role, content: m.content })),
      config: effectiveConfig,
    });
  }

  function loadScenario(s: PlaygroundScenario) {
    setBot(s.bot);
    setScenarioConfig(s.config ?? {});
    if (s.bot === "voice" && s.config?.voice?.callerKind) {
      setCallerKind(s.config.voice.callerKind);
    }
    // Fresh transcript per scenario, then send the opening line.
    const seedConfig =
      s.bot === "voice"
        ? {
            ...(s.config ?? {}),
            voice: {
              ...(s.config?.voice ?? {}),
              callerKind: s.config?.voice?.callerKind ?? callerKind,
            },
          }
        : (s.config ?? {});
    const userMsg: TranscriptMessage = {
      id: nextId(),
      role: "user",
      content: s.firstUserMessage,
    };
    setMessages([userMsg]);
    runMutation.mutate({
      bot: s.bot,
      messages: [{ role: "user", content: s.firstUserMessage }],
      config: seedConfig,
    });
  }

  function changeBot(next: BotKind) {
    setBot(next);
    setScenarioConfig({});
    setMessages([]);
    setPrompt(null);
  }

  function reset() {
    setMessages([]);
    setScenarioConfig({});
    setDraft("");
  }

  async function viewPrompt() {
    try {
      const p = await getPlaygroundPrompt(
        bot,
        bot === "voice" ? callerKind : undefined,
      );
      setPrompt(p);
    } catch (err) {
      toast({
        title: "Couldn't load the system prompt",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }

  const scenariosForBot = (info.data?.scenarios ?? []).filter(
    (s) => s.bot === bot,
  );

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="space-y-1">
        <h1
          className="text-2xl font-semibold flex items-center gap-2"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          <FlaskConical className="h-6 w-6" /> Bot playground
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Rehearse the chat and voice bots against tricky situations to see how
          they respond and tune their prompts. Account and voice runs use
          synthetic data and simulated tools — nothing here touches a real
          customer, places an order, or messages support.
        </p>
        {info.isError && (
          <div
            className="flex items-center gap-3 p-3 rounded-lg border text-sm"
            style={{
              borderColor: "hsl(var(--destructive) / 0.4)",
              color: "hsl(var(--destructive))",
            }}
          >
            <span>
              Couldn't load playground config — scenarios may be incomplete.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void info.refetch()}
              style={{ flexShrink: 0 }}
            >
              Retry
            </Button>
          </div>
        )}
        {info.data && (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Active AI provider:{" "}
            <Badge
              variant={
                info.data.provider === "offline" ? "destructive" : "secondary"
              }
            >
              {info.data.provider}
            </Badge>
            {info.data.provider === "offline" && (
              <span className="ml-2">
                Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run the bots.
              </span>
            )}
          </p>
        )}
      </header>

      {/* Bot selector */}
      <div
        className="flex flex-wrap gap-2"
        data-testid="bot-playground-bot-tabs"
      >
        {(Object.keys(BOT_LABELS) as BotKind[]).map((b) => (
          <Button
            key={b}
            type="button"
            variant={bot === b ? "default" : "outline"}
            size="sm"
            onClick={() => changeBot(b)}
            disabled={busy}
          >
            <Bot className="h-4 w-4 mr-1" />
            {BOT_LABELS[b]}
          </Button>
        ))}
      </div>
      <p className="text-xs -mt-3" style={{ color: "hsl(var(--ink-3))" }}>
        {BOT_BLURB[bot]}
      </p>

      {/* Voice caller-kind toggle */}
      {bot === "voice" && (
        <div className="flex items-center gap-2 text-sm">
          <span style={{ color: "hsl(var(--ink-2))" }}>Caller kind:</span>
          {(["patient", "shop_customer"] as VoiceCallerKind[]).map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={callerKind === k ? "default" : "outline"}
              onClick={() => setCallerKind(k)}
              disabled={busy}
            >
              {k === "patient"
                ? "Patient (clinical)"
                : "Shop customer (cash-pay)"}
            </Button>
          ))}
        </div>
      )}

      {/* Live test call — actually talk to the voice agent on the phone */}
      {bot === "voice" && (
        <Card data-testid="bot-playground-voice-call">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Phone className="h-4 w-4" /> Talk to the voice agent
            </CardTitle>
            <CardDescription>
              We&apos;ll call your phone and connect you to the live voice agent
              so you can hear its greeting, prosody, turn-taking, and how it
              handles scope and hand-offs. It runs the real persona for the{" "}
              <strong>
                {callerKind === "patient" ? "patient" : "shop customer"}
              </strong>{" "}
              kind selected above; account tools (identity, ordering) are
              disabled on test calls, and no real customer data is touched. The
              voice agent must be enabled in Control Center.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (callPhone.trim().length === 0) return;
                callMutation.mutate({
                  to: callPhone.trim(),
                  callerKind,
                  callContext: scenarioConfig.voice?.callContext,
                });
              }}
            >
              <div className="flex-1 min-w-[12rem]">
                <label
                  className="text-xs block mb-1"
                  style={{ color: "hsl(var(--ink-3))" }}
                  htmlFor="bot-playground-call-phone"
                >
                  Your phone number
                </label>
                <Input
                  id="bot-playground-call-phone"
                  type="tel"
                  inputMode="tel"
                  placeholder="(814) 555-0123"
                  value={callPhone}
                  onChange={(e) => setCallPhone(e.target.value)}
                  disabled={callMutation.isPending}
                  data-testid="bot-playground-call-phone"
                />
              </div>
              <Button
                type="submit"
                disabled={
                  callMutation.isPending ||
                  callPhone.trim().length === 0 ||
                  info.data?.provider === "offline"
                }
                data-testid="bot-playground-call-button"
              >
                {callMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Phone className="h-4 w-4 mr-1" />
                )}
                Call me
              </Button>
            </form>
            {scenarioConfig.voice?.callContext && (
              <p
                className="text-xs mt-2"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Framing the call as: “{scenarioConfig.voice.callContext}”
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        {/* Conversation */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{BOT_LABELS[bot]}</CardTitle>
              <CardDescription>Multi-turn conversation</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={viewPrompt}
              >
                View system prompt
              </Button>
              {messages.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={reset}
                  disabled={busy}
                >
                  <RotateCcw className="h-4 w-4 mr-1" /> Reset
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              ref={listRef}
              className="max-h-[28rem] overflow-y-auto rounded-md border border-border/40 bg-white/60 p-3 space-y-3"
              data-testid="bot-playground-transcript"
            >
              {messages.length === 0 && (
                <p
                  className="text-sm italic"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Pick a scenario on the right, or type a message below to
                  start.
                </p>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {busy && (
                <div
                  className="flex items-center gap-2 text-sm"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <Loader2 className="h-4 w-4 animate-spin" /> thinking…
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(draft, messages);
              }}
              className="flex items-end gap-2"
            >
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(draft, messages);
                  }
                }}
                placeholder="Type a customer message and press Enter…"
                rows={2}
                maxLength={info.data?.limits.maxMessageChars ?? 2000}
                disabled={busy || info.data?.provider === "offline"}
                data-testid="bot-playground-input"
                className="flex-1 resize-none"
              />
              <Button
                type="submit"
                disabled={
                  busy ||
                  draft.trim().length === 0 ||
                  info.data?.provider === "offline"
                }
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span className="sr-only">Send</span>
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Scenarios */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scenarios</CardTitle>
            <CardDescription>
              One-click situations for {BOT_LABELS[bot]}. Loading one starts a
              fresh conversation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {info.isPending && (
              <div
                className="flex items-center gap-2 text-sm"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                <Loader2 className="h-4 w-4 animate-spin" /> loading…
              </div>
            )}
            {scenariosForBot.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => loadScenario(s)}
                disabled={busy || info.data?.provider === "offline"}
                className="w-full text-left rounded-md border border-border/60 bg-white/70 px-3 py-2 hover:bg-[hsl(var(--penn-navy))]/5 disabled:opacity-50 transition-colors"
                data-testid="bot-playground-scenario"
              >
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                  {s.description}
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* System prompt inspector */}
      {prompt && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">
                System prompt — {BOT_LABELS[prompt.bot]}
              </CardTitle>
              <CardDescription>
                {prompt.chars.toLocaleString()} characters
                {prompt.promptVersion
                  ? ` · version ${prompt.promptVersion}`
                  : ""}
                . This is exactly what the bot is told — edit it in code to
                change behaviour.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPrompt(null)}
            >
              Hide
            </Button>
          </CardHeader>
          <CardContent>
            <pre
              className="max-h-96 overflow-auto rounded-md border border-border/40 bg-muted/40 p-3 text-xs whitespace-pre-wrap"
              data-testid="bot-playground-prompt"
            >
              {prompt.systemPrompt}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: TranscriptMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[88%] space-y-1">
        <div
          className={[
            "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
            isUser
              ? "bg-[hsl(var(--penn-navy))] text-white"
              : "bg-white border border-border/40",
          ].join(" ")}
        >
          {message.content}
        </div>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1">
            {message.toolCalls.map((t, i) => (
              <details
                key={`${t.name}-${i}`}
                className="rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1 text-xs"
              >
                <summary className="cursor-pointer font-medium flex items-center gap-1">
                  <Wrench className="h-3 w-3" />
                  {t.name}
                  <Badge
                    variant={t.simulated ? "outline" : "secondary"}
                    className="ml-1"
                  >
                    {t.simulated ? "simulated" : "live"}
                  </Badge>
                </summary>
                <div className="mt-1 space-y-1">
                  <div>
                    <span className="font-medium">args:</span>{" "}
                    <code>{JSON.stringify(t.input)}</code>
                  </div>
                  <div>
                    <span className="font-medium">result:</span>{" "}
                    <code className="break-all">{t.resultPreview}</code>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
        {message.meta && (
          <div className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
            {message.meta.provider} · {message.meta.model} ·{" "}
            {message.meta.rounds} tool round
            {message.meta.rounds === 1 ? "" : "s"}
            {message.meta.degraded ? " · degraded" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
