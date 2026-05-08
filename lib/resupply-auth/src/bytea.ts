// Buffer ↔ Postgres bytea hex-string round-trip.
//
// The Supabase JS client passes bytea values through as JSON strings.
// Postgres's default `bytea_output = 'hex'` setting (the default since
// 9.0) emits `\x<hex>` on SELECT and accepts the same shape on INSERT.
// We round-trip Buffer values through that hex form.
//
// The string `bufferToHexBytea(Buffer.from('hello'))` returns the
// 12-character JS string  `\x68656c6c6f` — a literal backslash, the
// letter `x`, and the hex digits. Sending that string in a PostgREST
// JSON body produces the same 5-byte value back; the test in
// `bytea.test.ts` exercises the round-trip end-to-end.

export function bufferToHexBytea(buf: Buffer): string {
  return "\\x" + buf.toString("hex");
}

export function hexByteaToBuffer(s: string): Buffer {
  if (s.length < 2 || s[0] !== "\\" || s[1] !== "x") {
    throw new Error(
      `hexByteaToBuffer: expected '\\\\x' prefix, got ${JSON.stringify(s.slice(0, 4))}…`,
    );
  }
  return Buffer.from(s.slice(2), "hex");
}

/** Tolerate optional null. Returns null for nullable bytea columns. */
export function bufferToHexByteaOrNull(buf: Buffer | null): string | null {
  return buf ? bufferToHexBytea(buf) : null;
}

export function hexByteaToBufferOrNull(s: string | null): Buffer | null {
  return s ? hexByteaToBuffer(s) : null;
}
