// Pure renderers for the patient-facing video-visit invitation.
//
// Extracted from `routes/admin/video-visits.ts` so the copy has ONE home
// that can be imported without pulling a route's Express/DB/Twilio
// dependency tree along with it. The route still owns scheduling and
// delivery; this module owns only what the patient reads.
//
// The message-preview catalog (`lib/message-previews/catalog.ts`) renders
// the invite by calling these same functions, so the preview staff see is
// byte-for-byte the email that goes out — it cannot drift.

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatWhen(scheduledAt: string | null): string | null {
  if (!scheduledAt) return null;
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function renderInviteEmailHtml(
  greeting: string,
  practiceName: string,
  when: string | null,
  link: string,
): string {
  const whenLine = when
    ? `<p style="margin:0 0 12px"><strong>When:</strong> ${escapeHtml(when)}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p>Your care team at <strong>${escapeHtml(practiceName)}</strong> has set up a
  secure video visit to help you with your equipment. You can join from your
  phone, tablet, or computer — no app to install, just a camera and microphone.</p>
  ${whenLine}
  <p style="margin:24px 0">
    <a href="${escapeHtml(link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Join your video visit</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Your browser will ask permission to
  use your camera and microphone when you join. The call is encrypted
  end-to-end and is never recorded.</p>
  <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy and
  paste this link:<br>${escapeHtml(link)}</p>
  <p>— The ${escapeHtml(practiceName)} team</p>
  </body></html>`;
}

export function renderInviteEmailText(
  greeting: string,
  practiceName: string,
  when: string | null,
  link: string,
): string {
  return [
    `Hi ${greeting},`,
    "",
    `Your care team at ${practiceName} has set up a secure video visit to help`,
    "you with your equipment. You can join from your phone, tablet, or",
    "computer — no app to install, just a camera and microphone.",
    ...(when ? ["", `When: ${when}`] : []),
    "",
    `Join your video visit: ${link}`,
    "",
    "Your browser will ask permission to use your camera and microphone when",
    "you join. The call is encrypted end-to-end and is never recorded.",
    "",
    `— The ${practiceName} team`,
  ].join("\n");
}
