// Apple Wallet .pkpass generator for PennPaps.
//
// What this builds
// ----------------
// A signed .pkpass file the customer adds to Apple Wallet — a small
// always-on-the-lock-screen card with their PennPaps customer id,
// support phone, and a "Buy again" deep link. Demographic that
// keeps a CPAP supplier card in their wallet is exactly the cohort
// for whom one less round of menu-diving makes the difference
// between "reordered" and "didn't."
//
// PKPass structure (per Apple PassKit Programming Guide):
//   pass.json        — manifest of pass content (already JSON)
//   icon.png         — 29×29 / 58×58 / 87×87 — REQUIRED
//   logo.png         — top-left logo on the pass face — REQUIRED
//   manifest.json    — SHA-1 hashes of all files
//   signature        — PKCS#7 detached signature of manifest.json
//
// All five are zipped into a `.pkpass` bundle.
//
// Environment requirements
// ------------------------
// Production needs THREE env vars to sign the manifest:
//
//   APPLE_WALLET_PASS_TYPE_ID    — e.g. "pass.com.pennpaps.customer"
//   APPLE_WALLET_TEAM_ID         — Apple Developer team identifier
//   APPLE_WALLET_SIGNER_KEY_PEM  — Pass Type ID private key, PEM
//   APPLE_WALLET_SIGNER_CERT_PEM — Pass Type ID certificate, PEM
//   APPLE_WALLET_WWDR_CERT_PEM   — Apple WWDR intermediate cert, PEM
//
// Plus the `openssl` binary on PATH (every Linux/macOS image has it).
//
// When any of the above is missing, the build function throws
// AppleWalletNotConfiguredError and the route surfaces 503. We
// deliberately do NOT silently emit an unsigned .pkpass — Wallet
// would reject it anyway, and "Add to Wallet" failing in the
// customer's hand is worse than the explicit 503.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class AppleWalletNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleWalletNotConfiguredError";
  }
}

export class AppleWalletSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleWalletSignError";
  }
}

export interface AppleWalletConfig {
  passTypeId: string;
  teamId: string;
  signerKeyPem: string;
  signerCertPem: string;
  wwdrCertPem: string;
}

export function readAppleWalletConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): AppleWalletConfig | null {
  const passTypeId = env.APPLE_WALLET_PASS_TYPE_ID;
  const teamId = env.APPLE_WALLET_TEAM_ID;
  const signerKeyPem = env.APPLE_WALLET_SIGNER_KEY_PEM;
  const signerCertPem = env.APPLE_WALLET_SIGNER_CERT_PEM;
  const wwdrCertPem = env.APPLE_WALLET_WWDR_CERT_PEM;
  if (
    !passTypeId ||
    !teamId ||
    !signerKeyPem ||
    !signerCertPem ||
    !wwdrCertPem
  ) {
    return null;
  }
  return {
    passTypeId,
    teamId,
    signerKeyPem,
    signerCertPem,
    wwdrCertPem,
  };
}

export interface PassContent {
  /** Stable per-customer identifier; goes in pass.json. */
  serialNumber: string;
  /** Display name for the "Member" field. */
  memberName: string;
  /** Logo bar text (typically "PennPaps"). */
  logoText: string;
  /** Support phone in display format. */
  supportPhone: string;
  /** Support email. */
  supportEmail: string;
  /** Deep link to /shop for the "Buy again" tap target. */
  buyAgainUrl: string;
  /** PNG bytes for icon.png. Required by PassKit. */
  iconPng: Buffer;
  /** PNG bytes for logo.png. Required by PassKit. */
  logoPng: Buffer;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Build the JSON for pass.json from PassContent + config.
 *
 * We use the storeCard style — it's the closest match to a
 * "membership card" identity surface and renders cleanly on both
 * the lock screen and Wallet's full pass view.
 */
function buildPassJson(
  content: PassContent,
  config: AppleWalletConfig,
): string {
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeId,
    teamIdentifier: config.teamId,
    serialNumber: content.serialNumber,
    organizationName: "PennPaps",
    description: "PennPaps Member Card",
    logoText: content.logoText,
    foregroundColor: "rgb(255, 255, 255)",
    backgroundColor: "rgb(15, 29, 58)",
    labelColor: "rgb(204, 184, 121)",
    storeCard: {
      primaryFields: [
        {
          key: "member",
          label: "Member",
          value: content.memberName,
        },
      ],
      secondaryFields: [
        {
          key: "id",
          label: "Customer ID",
          value: content.serialNumber.slice(0, 8),
        },
      ],
      auxiliaryFields: [
        {
          key: "phone",
          label: "Support",
          value: content.supportPhone,
        },
      ],
      backFields: [
        {
          key: "email",
          label: "Email support",
          value: content.supportEmail,
        },
        {
          key: "buyAgain",
          label: "Reorder supplies",
          value: content.buyAgainUrl,
          attributedValue: `<a href="${content.buyAgainUrl}">Tap to reorder</a>`,
        },
      ],
    },
  };
  return JSON.stringify(pass);
}

function sha1Hex(buf: Buffer): string {
  // SHA-1 is mandated by Apple's PKPass specification for the manifest integrity
  // checksum (PassKit Programming Guide, manifest.json). Security comes from the
  // PKCS#7 detached signature, not the hash.
  return createHash("sha1").update(buf).digest("hex");
}

function buildManifestJson(entries: ZipEntry[]): string {
  const manifest: Record<string, string> = {};
  for (const e of entries) {
    manifest[e.name] = sha1Hex(e.data);
  }
  return JSON.stringify(manifest);
}

/**
 * Produce a PKCS#7 detached signature of `manifestBytes` using the
 * Pass Type ID cert + WWDR intermediate chain. Shells out to the
 * system openssl binary, which every Linux/macOS production image
 * has. Returns the DER-encoded signature.
 *
 * The temp-file dance is unavoidable: openssl smime accepts file
 * inputs for cert + key + signer chain, and passing them via fd
 * is more error-prone than writing to /tmp for the duration of
 * the call.
 */
async function signManifestPkcs7(
  manifestBytes: Buffer,
  config: AppleWalletConfig,
): Promise<Buffer> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "pkpass-"));
  try {
    const manifestPath = join(dir, "manifest.json");
    const keyPath = join(dir, "signer.key.pem");
    const certPath = join(dir, "signer.cert.pem");
    const chainPath = join(dir, "wwdr.cert.pem");
    const sigPath = join(dir, "signature");

    await Promise.all([
      writeFile(manifestPath, manifestBytes),
      writeFile(keyPath, config.signerKeyPem),
      writeFile(certPath, config.signerCertPem),
      writeFile(chainPath, config.wwdrCertPem),
    ]);

    try {
      await execFileAsync("openssl", [
        "smime",
        "-binary",
        "-sign",
        "-signer",
        certPath,
        "-inkey",
        keyPath,
        "-certfile",
        chainPath,
        "-in",
        manifestPath,
        "-out",
        sigPath,
        "-outform",
        "DER",
      ]);
    } catch (err) {
      throw new AppleWalletSignError(
        `openssl smime sign failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const { readFile } = await import("node:fs/promises");
    return await readFile(sigPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Minimal "stored" ZIP writer. PKPass spec doesn't require
 * compression — Wallet accepts uncompressed entries — and writing
 * stored entries is a few dozen lines vs. pulling in a zip
 * library. Per pkzip APPNOTE 4.6.1.
 *
 * The file count is fixed at 5 (pass.json, icon.png, logo.png,
 * manifest.json, signature). Bounded enough to keep this code
 * tractable.
 */
function buildStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // ── Local file header ───────────────────────────────────────
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general purpose flag
    local.writeUInt16LE(0, 8); // compression method (0 = stored)
    local.writeUInt16LE(0, 10); // last mod time
    local.writeUInt16LE(0, 12); // last mod date
    local.writeUInt32LE(crc, 14); // crc-32
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // file name length
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, entry.data);

    // ── Central directory header ────────────────────────────────
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central file signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // general purpose flag
    central.writeUInt16LE(0, 10); // compression method
    central.writeUInt16LE(0, 12); // last mod time
    central.writeUInt16LE(0, 14); // last mod date
    central.writeUInt32LE(crc, 16); // crc-32
    central.writeUInt32LE(size, 20); // compressed size
    central.writeUInt32LE(size, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28); // file name length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // file comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((a, b) => a + b.length, 0);

  // ── End of central directory record ───────────────────────────
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir start
  eocd.writeUInt16LE(entries.length, 8); // disk entries
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * CRC-32 (IEEE 802.3 / PKZIP / RFC 1952). Pure-JS implementation
 * because the env doesn't ship zlib's exposed CRC routine.
 */
const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a fully-signed .pkpass for the supplied content.
 *
 * @throws AppleWalletNotConfiguredError when any required env var
 *   is missing. The HTTP route returns 503 to the customer in this
 *   case rather than a 500.
 * @throws AppleWalletSignError when openssl fails (missing binary,
 *   malformed cert, expired pass type ID). The route returns 502.
 */
export async function buildPkpass(
  content: PassContent,
  config: AppleWalletConfig | null = readAppleWalletConfigOrNull(),
): Promise<Buffer> {
  if (!config) {
    throw new AppleWalletNotConfiguredError(
      "Apple Wallet env vars not configured.",
    );
  }

  const passJson = Buffer.from(buildPassJson(content, config), "utf8");

  // The four payload files. Manifest covers these; signature covers
  // the manifest. Order in the bundle is not significant for Wallet
  // but we keep it deterministic for hash-stability in tests.
  const payload: ZipEntry[] = [
    { name: "pass.json", data: passJson },
    { name: "icon.png", data: content.iconPng },
    { name: "logo.png", data: content.logoPng },
  ];

  const manifestJson = Buffer.from(buildManifestJson(payload), "utf8");
  const signature = await signManifestPkcs7(manifestJson, config);

  return buildStoredZip([
    ...payload,
    { name: "manifest.json", data: manifestJson },
    { name: "signature", data: signature },
  ]);
}
