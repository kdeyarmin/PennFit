// Turn bare `/admin/...` paths mentioned in prose into link segments.
//
// Two surfaces render staff-facing prose that names console pages: the
// in-app admin assistant (streaming model output) and the Help Center
// under /admin/resources (hand-written content). Both want the same
// behavior — the path becomes a one-click link, and trailing punctuation
// stays outside it — so the segmenting lives here rather than in either
// component.

// Matches an in-app admin path: `/admin`, optionally followed by
// `/segment` parts. Stops before trailing punctuation like `)`, `.` or
// `,` so a path in prose / parentheses links cleanly. The `:` is allowed
// so a route param placeholder (e.g. `/admin/patients/:id`) still
// highlights, even though it isn't directly navigable.
const ADMIN_PATH_RE = /\/admin(?:\/[A-Za-z0-9_:-]+)*/g;

export interface MessageSegment {
  type: "text" | "link";
  value: string;
}

/**
 * Split prose into plain-text and admin-path segments so the UI can
 * render each `/admin/...` path as a one-click link. Pure + exported for
 * unit testing. A path containing a `:` route placeholder is treated as
 * plain text (not a real destination).
 */
export function splitAdminPaths(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  ADMIN_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ADMIN_PATH_RE.exec(text)) !== null) {
    const path = match[0];
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        value: text.slice(lastIndex, match.index),
      });
    }
    // A `:param` placeholder isn't a concrete destination — keep it as text.
    segments.push({ type: path.includes(":") ? "text" : "link", value: path });
    lastIndex = match.index + path.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}
