// ICE server configuration handed to both video-call peers.
//
// Default posture is public STUN only — enough for the common case
// (both peers behind ordinary NATs). For symmetric-NAT / strict-
// firewall callers, an operator can stand up a TURN relay and point
// these env vars at it; nothing else changes:
//
//   RESUPPLY_TURN_URLS        comma-separated turn:/turns: URLs
//   RESUPPLY_TURN_USERNAME    long-term-credential username
//   RESUPPLY_TURN_CREDENTIAL  long-term-credential password
//
// PHI note: a TURN relay forwards encrypted SRTP packets it cannot
// decrypt (DTLS keys never leave the browsers), so adding one does not
// change the "media never touches our server in the clear" posture.

export interface IceServerEntry {
  urls: string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

export function getIceServers(): IceServerEntry[] {
  const servers: IceServerEntry[] = [{ urls: DEFAULT_STUN_URLS }];

  const turnUrls = (process.env.RESUPPLY_TURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    const entry: IceServerEntry = { urls: turnUrls };
    const username = process.env.RESUPPLY_TURN_USERNAME;
    const credential = process.env.RESUPPLY_TURN_CREDENTIAL;
    if (username) entry.username = username;
    if (credential) entry.credential = credential;
    servers.push(entry);
  }

  return servers;
}
