// Sanitizer for `audit_log.metadata`. Three guarantees:
//
//   1. The metadata object contains no PHI-shaped keys at any depth.
//      We fail CLOSED (throw `AuditMetadataPhiError`) rather than
//      silently strip the offending key — silent stripping would
//      make an audit-row PHI bug invisible. The check is recursive
//      so a `{ filters: { email: ... } }` nest is still rejected.
//
//      Keys are NORMALIZED before lookup:
//        * NFKC normalize (collapses unicode confusables like the
//          fullwidth `ｅ` into ASCII `e`)
//        * tokenized on camelCase, snake_case, kebab-case, dots and
//          digits (so `patientEmail`, `email_address`, `email-1`
//          all share the token `email`)
//      The strong-token denylist fires on ANY token match; that's
//      what catches `patientEmail` and `email_address`. The
//      whole-key denylist holds generic terms (`name`, `state`,
//      `notes`) that only fire when the entire normalized key
//      equals the entry — so `previousState`, `displayName`, and
//      `releaseNotes` pass while a literal `state`/`name`/`notes`
//      key is rejected.
//
//   2. Only plain JSON-shaped objects are accepted. We reject:
//        * arrays at the top level (must be a plain object root)
//        * objects whose prototype isn't `Object.prototype` or `null`
//          (class instances, Maps, Sets, Dates, Buffers, …)
//        * objects with an own `toJSON` method
//        * objects with symbol-keyed properties
//      The `toJSON` rejection is what closes the bypass where the
//      key check passes but `JSON.stringify` rewrites the payload
//      from a custom serializer. Without this gate a payload like
//      `{ id: 1, toJSON() { return { email: "…" } } }` would pass
//      the recursive key check (its own keys are `id`/`toJSON`) but
//      write `{"email":"…"}` to the database. We refuse that shape
//      outright instead of trying to "see through" it.
//
//   3. The serialized JSON is bounded. Multi-megabyte audit rows
//      destroy log readability and pad backups. The cap (8 KiB) is
//      far above any legitimate operator-action payload — request
//      ids, before/after deltas of NON-PHI fields, filter shapes —
//      and far below "someone is dumping a query result here".
//
// Why a denylist (not allowlist):
//   We need free-form metadata for filters and request envelopes.
//   An allowlist would either be too permissive (defeating its
//   purpose) or force a schema change for every new audit verb.
//   The denylist plus the architecture-rule ban on direct
//   `db.insert(auditLog)` (Rule 8 in
//   `scripts/check-resupply-architecture.sh`) gives us a meaningful
//   guardrail without that friction. When in doubt, GROW the
//   denylist; do not narrow it.

// Strong tokens fire on ANY token match in the normalized key.
// These terms have ~no benign meaning in audit metadata —
// `phoneVendorId` *is* suspicious in an audit row and should be
// flagged so the developer can rename or refactor.
const PHI_STRONG_TOKENS: ReadonlySet<string> = new Set([
  // Identity (high-confidence PHI tokens).
  "email",
  "phone",
  "mobile",
  "ssn",
  "mrn",
  "dob",
  // Clinical (free-form bodies that almost always contain PHI).
  "diagnosis",
  "transcript",
]);

// Joined-form denylist fires when the FULL normalized key (NFKC,
// lowercase, alphanumeric only, no separators) equals the entry.
// Used for multi-word concatenations: `addressLine1` → joined
// "addressline1" → match. Compound keys with a strong token are
// already caught by `PHI_STRONG_TOKENS` — this set covers the
// remaining concatenations whose individual tokens (`address`,
// `member`, `id`, `body`) are too generic to put in the strong set.
const PHI_JOINED_DENYLIST: ReadonlySet<string> = new Set([
  "emailaddress",
  "primaryemail",
  "phonenumber",
  "dateofbirth",
  "birthdate",
  "firstname",
  "lastname",
  "fullname",
  "patientname",
  "patientnotes",
  "clinicalnotes",
  "address",
  "addressline1",
  "addressline2",
  "street",
  "city",
  "zip",
  "zipcode",
  "postalcode",
  "memberid",
  "messagebody",
  "smsbody",
  "emailbody",
  "freetext",
]);

// Whole-key-only denylist fires only when the entire normalized
// key is exactly this entry (single token). Generic words that
// have legitimate non-PHI uses in compound keys (`previousState`,
// `displayName`, `releaseNotes`) but are PHI-shaped when used as
// the whole key (`state`, `name`, `notes`).
const PHI_WHOLE_KEY_DENYLIST: ReadonlySet<string> = new Set([
  "name",
  "state",
  "notes",
  "dx",
  "condition",
]);

// Top-of-package limits — keep generous enough to never inconvenience
// a legitimate audit row, strict enough to catch accidental dumps.
export const AUDIT_METADATA_MAX_BYTES = 8 * 1024;
export const AUDIT_METADATA_MAX_DEPTH = 6;

export class AuditMetadataPhiError extends Error {
  constructor(
    public readonly path: string,
    public readonly key: string,
  ) {
    // Path includes a JSON-pointer-ish breadcrumb so a developer can
    // find the offending caller fast. The error message intentionally
    // does NOT echo the offending VALUE — that value is presumed to
    // be PHI, and an exception serialized into a log line must not
    // re-leak it.
    super(
      `audit metadata: forbidden PHI-shaped key "${key}" at ${path}. ` +
        `Move PHI into the row it describes; never embed it in metadata.`,
    );
    this.name = "AuditMetadataPhiError";
  }
}

export class AuditMetadataSizeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(
      `audit metadata: serialized size ${bytes} bytes exceeds limit ${limit} bytes`,
    );
    this.name = "AuditMetadataSizeError";
  }
}

export class AuditMetadataDepthError extends Error {
  constructor(
    public readonly depth: number,
    public readonly limit: number,
  ) {
    super(
      `audit metadata: nesting depth ${depth} exceeds limit ${limit}`,
    );
    this.name = "AuditMetadataDepthError";
  }
}

export class AuditMetadataShapeError extends Error {
  constructor(message: string) {
    super(`audit metadata: ${message}`);
    this.name = "AuditMetadataShapeError";
  }
}

/**
 * Tokenize a key for denylist comparison.
 *
 * Pipeline:
 *   1. NFKC normalize so unicode confusables (fullwidth `ｅ`,
 *      ligatures, etc.) collapse into their canonical ASCII form
 *      before the lowercase step.
 *   2. Insert a space at every camelCase boundary
 *      (`addressLine1` → `address Line1`).
 *   3. Lowercase.
 *   4. Split on every non-letter run (handles snake_case,
 *      kebab-case, dot.case, digits, and arbitrary punctuation).
 *
 * Returns the array of tokens plus the joined alphanumeric form.
 * The joined form catches denylist entries that span multiple
 * tokens (`addressLine1` → tokens `[address, line]`, joined
 * `addressline`, but `addressline1` is in the denylist as the
 * digits-included form so we also produce a digit-preserving
 * variant).
 */
function tokenizeKey(rawKey: string): {
  tokens: string[];
  joinedAlpha: string;
  joinedAlphaNum: string;
} {
  const nfkc = rawKey.normalize("NFKC");
  // Camel split first (preserves case-boundary information). We
  // also split between letters and digits so `addressLine1` →
  // `address Line 1` (separating the digit from the word).
  const camelSplit = nfkc
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
  const lowered = camelSplit.toLowerCase();
  // Letter-only token list (for the strong-token check).
  const tokens = lowered
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
  // Joined alpha form (for whole-key matches that ignore digits,
  // e.g. `name` vs `name2`).
  const joinedAlpha = tokens.join("");
  // Joined alphanumeric form (for joined denylist entries that
  // include digits, e.g. `addressline1`, `addressline2`).
  const joinedAlphaNum = lowered.replace(/[^a-z0-9]+/g, "");
  return { tokens, joinedAlpha, joinedAlphaNum };
}

function isPhiKey(rawKey: string): boolean {
  const { tokens, joinedAlpha, joinedAlphaNum } = tokenizeKey(rawKey);
  // 1. Strong tokens fire on ANY token match.
  for (const t of tokens) {
    if (PHI_STRONG_TOKENS.has(t)) return true;
  }
  // 2. Joined denylist: try both the digit-preserving and
  //    alpha-only joins so `addressline1` AND `addressLine` match.
  if (PHI_JOINED_DENYLIST.has(joinedAlphaNum)) return true;
  if (PHI_JOINED_DENYLIST.has(joinedAlpha)) return true;
  // 3. Whole-key generic terms only fire when the key normalizes
  //    to a single token equal to the entry (`name` yes, but
  //    `displayName` no).
  if (tokens.length === 1 && PHI_WHOLE_KEY_DENYLIST.has(tokens[0])) {
    return true;
  }
  return false;
}

/**
 * Refuse anything that isn't a plain JSON-shaped object. Closes the
 * `toJSON` bypass and rejects class instances / Maps / Buffers / etc.
 */
function assertPlainObject(value: object, path: string): void {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new AuditMetadataShapeError(
      `non-plain object at ${path} (got ${
        proto?.constructor?.name ?? "unknown"
      } instance) — only plain JSON-shaped objects are permitted`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) {
    // A toJSON method runs DURING `JSON.stringify`, after our key
    // walk completes. We can't trust the post-toJSON shape without
    // re-walking, and re-walking the toJSON output (instead of the
    // input) would be a footgun. Refuse the shape instead.
    throw new AuditMetadataShapeError(
      `object at ${path} defines toJSON — refusing to serialize an ` +
        `object with a custom serializer (the key check would not ` +
        `cover the post-serialization output)`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AuditMetadataShapeError(
      `object at ${path} has symbol-keyed properties — refusing ` +
        `(symbol keys are dropped by JSON.stringify and bypass key checks)`,
    );
  }
}

/**
 * Walk the input ONCE, validating every key and producing a deep
 * plain-data clone. The clone is what the caller writes to the DB.
 *
 * Why clone instead of returning the input?
 *   * **TOCTOU defence.** A Proxy or accessor on the input can
 *     return one shape during validation and a DIFFERENT shape
 *     during the subsequent `JSON.stringify`. Walking once and
 *     freezing values into a plain-data clone collapses that
 *     window — the `JSON.stringify` we eventually run is on data
 *     we already inspected, not on the live proxy.
 *   * **`Object.entries` is invoked exactly once per object** and
 *     its results captured into a local snapshot. We never re-read
 *     keys or values from the source object after this point.
 *   * The clone is built from `Object.create(null)`-style plain
 *     records and primitive copies, so no foreign prototypes,
 *     getters, or `toJSON` survive into the writer.
 *
 * Throws on any rule violation. Skipped/ignored values (functions,
 * symbols, undefined inside an object) match `JSON.stringify`'s
 * own behaviour: they're dropped from the clone. This keeps the
 * function transparent — the clone serialises to the same JSON the
 * caller would have got from `JSON.stringify(input)` if the input
 * were already plain.
 */
function validateAndClone(
  value: unknown,
  path: string,
  depth: number,
): unknown {
  if (depth > AUDIT_METADATA_MAX_DEPTH) {
    throw new AuditMetadataDepthError(depth, AUDIT_METADATA_MAX_DEPTH);
  }
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  // function / symbol / undefined / bigint behave like JSON.stringify:
  //   * undefined / function / symbol → dropped (caller sees a key
  //     missing from the clone)
  //   * bigint → JSON.stringify would throw; we throw earlier with a
  //     clearer message tied to the metadata path.
  if (typeof value === "bigint") {
    throw new AuditMetadataShapeError(
      `${path} is a bigint — refusing (bigint is not JSON-serialisable)`,
    );
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value !== "object") {
    // Defensive: should be unreachable given the typeof checks above.
    throw new AuditMetadataShapeError(
      `${path} has unsupported value type ${typeof value}`,
    );
  }
  if (Array.isArray(value)) {
    // Snapshot length once; do not re-read after.
    const length = value.length;
    const out: unknown[] = new Array(length);
    for (let i = 0; i < length; i += 1) {
      // Reading value[i] still goes through any Proxy get-trap, but
      // we read it ONCE and freeze the result into `out`.
      const cloned = validateAndClone(value[i], `${path}[${i}]`, depth + 1);
      out[i] = cloned === undefined ? null : cloned;
    }
    return out;
  }
  // Anything that isn't an array but IS typeof "object" must be a
  // plain object. Class instances, Maps, Sets, Dates, Buffers, and
  // proxies-of-non-Object-prototype are rejected here — they
  // serialize in surprising ways and can smuggle PHI past the key
  // walk.
  assertPlainObject(value as object, path);
  // Capture the entries snapshot atomically — one call to
  // Object.entries means one call to the proxy's ownKeys/get traps.
  // Subsequent recursion only reads from this local array.
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (isPhiKey(k)) {
      throw new AuditMetadataPhiError(`${path}.${k}`, k);
    }
    const cloned = validateAndClone(v, `${path}.${k}`, depth + 1);
    if (cloned !== undefined) {
      // Mirror JSON.stringify: drop undefined values from objects.
      out[k] = cloned;
    }
  }
  return out;
}

/**
 * Validate a metadata payload before it's written to `audit_log`.
 *
 * Returns a deep plain-data clone of the input on success; throws
 * on any rule violation. The clone (not the input) is what callers
 * should serialise — see `validateAndClone` for the TOCTOU
 * rationale. Treat a thrown error as a PROGRAMMER error: surface
 * as 500, do not silently swallow. The point of this gate is to
 * make a "PHI in audit metadata" bug LOUD, not absorb it.
 */
export function sanitizeMetadata(
  metadata: unknown,
): Record<string, unknown> {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AuditMetadataShapeError(
      "must be a plain object (got " +
        (Array.isArray(metadata) ? "array" : typeof metadata) +
        ")",
    );
  }

  const cloned = validateAndClone(metadata, "$", 1) as Record<string, unknown>;

  // Size check uses the CLONE's serialisation, not the input's, so
  // it's measuring exactly what will be written to the DB. A Proxy
  // that inflated under repeated stringify calls would show its
  // post-clone size here, not its first-pass size.
  const json = JSON.stringify(cloned);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > AUDIT_METADATA_MAX_BYTES) {
    throw new AuditMetadataSizeError(bytes, AUDIT_METADATA_MAX_BYTES);
  }

  return cloned;
}
