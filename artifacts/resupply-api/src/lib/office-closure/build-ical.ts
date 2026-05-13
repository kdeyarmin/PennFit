// Build an iCalendar (RFC 5545) feed of office closures so admins
// can subscribe their personal calendars to "is the office open
// today?" The output is intentionally minimal — VEVENT per row
// with UID, DTSTART, DTEND, SUMMARY, DESCRIPTION.

export interface ICalClosure {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
}

/** Format a Date as YYYYMMDDTHHMMSSZ (UTC, no separators). */
function icsDate(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Per RFC 5545 §3.3.11 — escape commas, semicolons, backslashes,
 *  and newlines in TEXT values. */
function escText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

/** Fold long lines per RFC 5545 §3.1 (max 75 octets). Keep this
 *  simple — a 75-char hard wrap is sufficient for our use. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + 73);
    out.push(i === 0 ? chunk : ` ${chunk}`);
    i += 73;
  }
  return out.join("\r\n");
}

export function buildClosuresIcal(opts: {
  practiceName: string;
  closures: ICalClosure[];
  now?: Date;
}): string {
  const now = (opts.now ?? new Date()).toISOString();
  const dtstamp = icsDate(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//PennFit//Office Closures//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`X-WR-CALNAME:${escText(opts.practiceName)} office closures`),
  ];
  for (const c of opts.closures) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${c.id}@pennfit.app`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${icsDate(c.startsAt)}`,
      `DTEND:${icsDate(c.endsAt)}`,
      fold(`SUMMARY:${escText(c.label)}`),
      fold(`DESCRIPTION:${escText(c.autoReplyMessage)}`),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 mandates CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
