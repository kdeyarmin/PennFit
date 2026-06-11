// VideoCallRoom — full-screen telehealth call surface shared by the
// admin console (staff seat) and the public patient join page.
//
// Deliberately styled with a fixed dark palette (slate / white / red
// utility classes) rather than theme tokens: it renders on BOTH the
// storefront and the admin console, so it must not depend on
// `.admin-root`-scoped variables (CLAUDE.md "admin theme stays
// scoped") or on storefront brand tokens.

import { useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  PhoneOff,
  Video as VideoIcon,
  VideoOff,
} from "lucide-react";

import { useVideoCall, type VideoCallOptions } from "./useVideoCall";

function MediaVideo({
  stream,
  muted,
  mirrored,
  className,
}: {
  stream: MediaStream | null;
  muted: boolean;
  mirrored: boolean;
  className: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) {
      void el.play().catch(() => {
        /* autoplay with user gesture already granted; ignore */
      });
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`${className} ${mirrored ? "-scale-x-100" : ""}`}
    />
  );
}

function ControlButton({
  onClick,
  active,
  danger,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
        danger
          ? "bg-red-600 text-white hover:bg-red-500"
          : active === false
            ? "bg-red-600/90 text-white hover:bg-red-500"
            : "bg-slate-700 text-white hover:bg-slate-600"
      }`}
    >
      {children}
    </button>
  );
}

export function VideoCallRoom({
  title,
  peerLabel,
  waitingMessage,
  endLabel,
  onExit,
  ...callOptions
}: VideoCallOptions & {
  /** Header line, e.g. the practice name or the patient's name. */
  title: string;
  /** What to call the other side, e.g. "your care team" / "the patient". */
  peerLabel: string;
  waitingMessage: string;
  /** Hang-up button label — "End visit" (staff) / "Leave visit" (patient). */
  endLabel: string;
  /** Called after the call is over and the user dismisses the room. */
  onExit: () => void;
}) {
  const call = useVideoCall(callOptions);

  const statusText =
    call.phase === "requesting-media"
      ? "Requesting camera and microphone…"
      : call.phase === "connecting"
        ? "Connecting…"
        : call.phase === "waiting"
          ? waitingMessage
          : call.phase === "in-call" && !call.remoteStream
            ? `Connecting to ${peerLabel}…`
            : null;

  const isOver =
    call.phase === "ended" ||
    call.phase === "error" ||
    call.phase === "media-error";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white">
      <header className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-slate-400">
            Secure video visit — encrypted peer-to-peer, never recorded
          </p>
        </div>
      </header>

      <div className="relative mx-auto flex w-full max-w-5xl flex-1 items-center justify-center overflow-hidden px-4">
        {/* Remote (main) video */}
        <div className="relative h-full max-h-[70vh] w-full overflow-hidden rounded-xl bg-slate-900">
          <MediaVideo
            stream={call.remoteStream}
            muted={false}
            mirrored={false}
            className="h-full w-full object-cover"
          />
          {(statusText || isOver) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950/70 px-6 text-center">
              {isOver ? (
                <>
                  <p className="text-lg font-semibold">
                    {call.phase === "ended"
                      ? "The visit has ended"
                      : "Something went wrong"}
                  </p>
                  {call.errorMessage && (
                    <p className="max-w-md text-sm text-slate-300">
                      {call.errorMessage}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={onExit}
                    className="mt-2 rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-200"
                  >
                    Close
                  </button>
                </>
              ) : (
                <>
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-500 border-t-white" />
                  <p className="text-sm text-slate-200">{statusText}</p>
                </>
              )}
            </div>
          )}

          {/* Local picture-in-picture */}
          {!isOver && call.localStream && (
            <div className="absolute bottom-3 right-3 h-28 w-40 overflow-hidden rounded-lg border border-slate-700 bg-slate-800 shadow-lg sm:h-32 sm:w-48">
              <MediaVideo
                stream={call.localStream}
                muted
                mirrored
                className="h-full w-full object-cover"
              />
              {!call.cameraOn && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90">
                  <VideoOff className="h-6 w-6 text-slate-400" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="flex items-center justify-center gap-4 px-4 py-5">
        {!isOver && (
          <>
            <ControlButton
              onClick={call.toggleMic}
              active={call.micOn}
              label={call.micOn ? "Mute microphone" : "Unmute microphone"}
            >
              {call.micOn ? (
                <Mic className="h-5 w-5" />
              ) : (
                <MicOff className="h-5 w-5" />
              )}
            </ControlButton>
            <ControlButton
              onClick={call.toggleCamera}
              active={call.cameraOn}
              label={call.cameraOn ? "Turn camera off" : "Turn camera on"}
            >
              {call.cameraOn ? (
                <VideoIcon className="h-5 w-5" />
              ) : (
                <VideoOff className="h-5 w-5" />
              )}
            </ControlButton>
            <button
              type="button"
              onClick={() => {
                call.endCall();
              }}
              className="flex h-12 items-center gap-2 rounded-full bg-red-600 px-5 text-sm font-semibold text-white hover:bg-red-500"
            >
              <PhoneOff className="h-5 w-5" />
              {endLabel}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

/** Builds the signaling WebSocket URL against the current origin. */
export function buildSignalWsUrl(wsPath: string, token: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${wsPath}?token=${encodeURIComponent(token)}`;
}
