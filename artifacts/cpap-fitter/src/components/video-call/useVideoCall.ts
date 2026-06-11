// useVideoCall — WebRTC peer connection + signaling client for
// telehealth video visits. Shared by the admin console (staff seat)
// and the public patient join page.
//
// Media is strictly peer-to-peer: the server-side WebSocket at
// /resupply-api/video/signal only relays the SDP/ICE envelopes this
// hook emits. Camera frames never leave the two browsers (the same
// posture as the mask fitter: no image bytes to the backend).
//
// Negotiation follows the W3C "perfect negotiation" pattern — both
// sides attach tracks and let onnegotiationneeded fire; offer
// collisions are resolved by the polite/impolite roles (patient is
// polite, staff is impolite) so refreshes and re-joins self-heal.

import { useCallback, useEffect, useRef, useState } from "react";

export type CallPhase =
  | "requesting-media"
  | "media-error"
  | "connecting"
  | "waiting" // signaling up, no peer in the room yet
  | "in-call"
  | "ended"
  | "error";

export interface VideoCallOptions {
  /** Full ws(s):// URL including the signed token query param. */
  wsUrl: string;
  iceServers: RTCIceServer[];
  /** Perfect-negotiation role. Patient=true, staff=false. */
  polite: boolean;
}

export interface VideoCallState {
  phase: CallPhase;
  errorMessage: string | null;
  peerPresent: boolean;
  micOn: boolean;
  cameraOn: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  toggleMic: () => void;
  toggleCamera: () => void;
  /** Hang up: notifies the server ("end") and tears everything down. */
  endCall: () => void;
}

interface SignalEnvelope {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

export function useVideoCall(options: VideoCallOptions): VideoCallState {
  const { wsUrl, iceServers, polite } = options;

  const [phase, setPhase] = useState<CallPhase>("requesting-media");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [peerPresent, setPeerPresent] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Perfect-negotiation bookkeeping.
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const closedRef = useRef(false);

  const sendSignal = useCallback((data: SignalEnvelope) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", data }));
    }
  }, []);

  const teardownPeer = useCallback(() => {
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* already closed */
      }
    }
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    setRemoteStream(null);
  }, []);

  const shutdown = useCallback(
    (finalPhase: CallPhase, message?: string) => {
      if (closedRef.current) return;
      closedRef.current = true;
      teardownPeer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
      const stream = localStreamRef.current;
      localStreamRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
      setPeerPresent(false);
      setPhase(finalPhase);
      if (message) setErrorMessage(message);
    },
    [teardownPeer],
  );

  const endCall = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "end" }));
      } catch {
        /* best effort */
      }
    }
    shutdown("ended");
  }, [shutdown]);

  useEffect(() => {
    closedRef.current = false;
    let cancelled = false;

    const setupPeer = () => {
      if (pcRef.current || closedRef.current) return;
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.onnegotiationneeded = () => {
        void (async () => {
          try {
            makingOfferRef.current = true;
            await pc.setLocalDescription();
            if (pc.localDescription) {
              sendSignal({ description: pc.localDescription });
            }
          } catch {
            /* superseded by a newer negotiation */
          } finally {
            makingOfferRef.current = false;
          }
        })();
      };

      pc.onicecandidate = (e) => {
        sendSignal({ candidate: e.candidate ? e.candidate.toJSON() : null });
      };

      pc.ontrack = (e) => {
        const incoming = e.streams[0];
        if (incoming) {
          setRemoteStream(incoming);
          setPhase("in-call");
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setPhase("in-call");
        } else if (pc.connectionState === "failed") {
          // One automatic recovery attempt; a second failure surfaces
          // to the user (they can refresh to fully restart).
          try {
            pc.restartIce();
          } catch {
            /* unsupported */
          }
        }
      };
    };

    const handleSignal = async (data: SignalEnvelope) => {
      const pc = pcRef.current;
      if (!pc) return;
      if (data.description) {
        const description = data.description;
        const offerCollision =
          description.type === "offer" &&
          (makingOfferRef.current || pc.signalingState !== "stable");
        ignoreOfferRef.current = !polite && offerCollision;
        if (ignoreOfferRef.current) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            sendSignal({ description: pc.localDescription });
          }
        }
        return;
      }
      if (data.candidate !== undefined) {
        try {
          await pc.addIceCandidate(data.candidate ?? undefined);
        } catch (err) {
          if (!ignoreOfferRef.current) throw err;
        }
      }
    };

    const openSocket = () => {
      if (cancelled) return;
      setPhase("connecting");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        let msg: {
          type?: string;
          peerPresent?: boolean;
          data?: SignalEnvelope;
        };
        try {
          msg = JSON.parse(String(event.data)) as typeof msg;
        } catch {
          return;
        }
        switch (msg.type) {
          case "joined":
            if (msg.peerPresent) {
              setPeerPresent(true);
              setupPeer();
            } else {
              setPhase("waiting");
            }
            break;
          case "peer-joined":
            setPeerPresent(true);
            setupPeer();
            break;
          case "peer-left":
            setPeerPresent(false);
            teardownPeer();
            setPhase("waiting");
            break;
          case "signal":
            void handleSignal(msg.data ?? {}).catch(() => {
              /* a torn-down pc mid-message is expected during teardown */
            });
            break;
          case "ended":
            shutdown("ended");
            break;
          default:
            break;
        }
      };

      ws.onclose = (event) => {
        if (closedRef.current || cancelled) return;
        // 4401/4403/4409: visit unavailable / feature off / superseded
        // by a newer tab — all terminal, no retry.
        if (event.code >= 4400) {
          shutdown(
            "error",
            event.code === 4409
              ? "This visit was opened in another tab or window."
              : "This visit is no longer available.",
          );
        } else {
          shutdown("error", "Connection to the visit was lost.");
        }
      };
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        openSocket();
      } catch {
        if (!cancelled) {
          setPhase("media-error");
          setErrorMessage(
            "We couldn't access your camera or microphone. Please allow access in your browser and try again.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      shutdown("ended");
    };
    // A call is bound to one wsUrl for its lifetime; re-running this
    // effect on every render would drop the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !stream.getAudioTracks().some((t) => t.enabled);
    stream.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !stream.getVideoTracks().some((t) => t.enabled);
    stream.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    setCameraOn(next);
  }, []);

  return {
    phase,
    errorMessage,
    peerPresent,
    micOn,
    cameraOn,
    localStream,
    remoteStream,
    toggleMic,
    toggleCamera,
    endCall,
  };
}
