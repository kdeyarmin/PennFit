// /video-visit?token=… — public patient join page for a telehealth
// video visit. The token is the HMAC-signed link from the SMS/email
// invite; no account or sign-in is required. The page validates the
// token, shows a small lobby (what the visit is, when, who with), and
// then enters the WebRTC call — media is peer-to-peer and never
// recorded (see components/video-call/).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Video } from "lucide-react";

import {
  VideoCallRoom,
  buildSignalWsUrl,
} from "@/components/video-call/VideoCallRoom";

interface SessionResponse {
  state: "ready" | "invalid" | "cancelled" | "completed" | "disabled";
  role?: "patient" | "staff";
  purpose?: string;
  scheduledAt?: string | null;
  practiceName?: string;
  wsPath?: string;
  iceServers?: RTCIceServer[];
}

const PURPOSE_LABEL: Record<string, string> = {
  setup: "equipment setup",
  troubleshooting: "equipment troubleshooting",
  follow_up: "follow-up",
  other: "care check-in",
};

async function fetchSession(token: string): Promise<SessionResponse> {
  const res = await fetch(
    `/resupply-api/video-visit/session?token=${encodeURIComponent(token)}`,
    { headers: { Accept: "application/json" } },
  );
  // Determinate non-OK states (invalid/disabled) also return a JSON
  // body with `state`; surface it rather than throwing.
  try {
    return (await res.json()) as SessionResponse;
  } catch {
    return { state: res.status === 503 ? "disabled" : "invalid" };
  }
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {children}
      </div>
    </div>
  );
}

export function VideoVisitPage() {
  const token =
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("token") ?? "")
      : "";
  const [joined, setJoined] = useState(false);

  const session = useQuery({
    queryKey: ["video-visit-session", token],
    queryFn: () => fetchSession(token),
    enabled: token.length > 0,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  if (!token || session.data?.state === "invalid") {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold text-slate-900">
          This link isn't valid
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Your video visit link may have expired or been replaced. Please
          contact your care team for a new link.
        </p>
      </CenteredCard>
    );
  }

  if (session.isPending) {
    return (
      <CenteredCard>
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
        <p className="mt-4 text-sm text-slate-600">Checking your visit link…</p>
      </CenteredCard>
    );
  }

  if (session.isError) {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold text-slate-900">
          We couldn't load your visit
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Please check your connection and try again. If the problem continues,
          contact your care team.
        </p>
        <button
          onClick={() => void session.refetch()}
          className="mt-5 px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors"
        >
          Try again
        </button>
      </CenteredCard>
    );
  }

  const data = session.data;

  if (data.state === "cancelled" || data.state === "completed") {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold text-slate-900">
          {data.state === "cancelled"
            ? "This visit was cancelled"
            : "This visit has ended"}
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          {data.state === "cancelled"
            ? "Your care team cancelled this video visit. If you still need help, please reach out and they'll set up a new one."
            : "Thanks for joining. If you need anything else, your care team is a call or message away."}
        </p>
      </CenteredCard>
    );
  }

  if (data.state === "disabled" || !data.wsPath || !data.iceServers) {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold text-slate-900">
          Video visits are unavailable right now
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Please contact your care team to continue by phone instead.
        </p>
      </CenteredCard>
    );
  }

  if (joined) {
    return (
      <VideoCallRoom
        wsUrl={buildSignalWsUrl(data.wsPath, token)}
        iceServers={data.iceServers}
        polite
        title={data.practiceName ?? "Your video visit"}
        peerLabel="your care team"
        waitingMessage="You're in! Waiting for your care team to join…"
        endLabel="Leave visit"
        onExit={() => setJoined(false)}
      />
    );
  }

  const when = data.scheduledAt ? new Date(data.scheduledAt) : null;
  const purposeText = PURPOSE_LABEL[data.purpose ?? ""] ?? "care check-in";

  return (
    <CenteredCard>
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
        <Video className="h-7 w-7 text-slate-700" />
      </div>
      <h1 className="mt-4 text-xl font-semibold text-slate-900">
        Your video visit
        {data.practiceName ? ` with ${data.practiceName}` : ""}
      </h1>
      <p className="mt-3 text-sm text-slate-600">
        Your care team set up this secure video call for your {purposeText}.
        {when && !Number.isNaN(when.getTime()) && (
          <>
            {" "}
            It's scheduled for{" "}
            <strong>
              {when.toLocaleString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </strong>
            .
          </>
        )}
      </p>
      <p className="mt-3 text-xs text-slate-500">
        When you join, your browser will ask permission to use your camera and
        microphone. The call is encrypted between you and your care team and is
        never recorded.
      </p>
      <button
        type="button"
        onClick={() => setJoined(true)}
        className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
      >
        Join video visit
      </button>
    </CenteredCard>
  );
}

export default VideoVisitPage;
