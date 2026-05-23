/**
 * Setup script: vendor MediaPipe assets locally.
 *
 * The PennPaps app advertises "100% private — your face never leaves your
 * device." That promise is undermined if the WASM runtime + face landmark
 * model are fetched from third-party CDNs at runtime (every visit pings
 * jsdelivr.net and storage.googleapis.com). This script:
 *
 *   1. Copies the MediaPipe Tasks Vision WASM bundle from node_modules
 *      into public/mediapipe/wasm/ so Vite serves it from our own origin.
 *   2. Downloads the face_landmarker.task model into public/mediapipe/models/
 *      once and caches it (skipped on re-runs).
 *
 * Output is gitignored — the script runs as a `predev` and `prebuild` hook.
 * No need to commit large binaries.
 */
import { mkdir, copyFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const PUBLIC_DIR = resolve(PROJECT_ROOT, "public", "mediapipe");
const WASM_DEST = resolve(PUBLIC_DIR, "wasm");
const MODELS_DEST = resolve(PUBLIC_DIR, "models");

// face_landmarker.task — Google's published face landmark model (v1, float16).
// Pinned to a specific path so a silent CDN-side change can't swap the model
// out from under us.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_DEST = resolve(MODELS_DEST, "face_landmarker.task");
const MIN_MODEL_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export async function downloadModelWithRetry(attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(MODEL_URL, { signal: controller.signal }).finally(
        () => {
          clearTimeout(timeout);
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_MODEL_BYTES) {
        throw new Error(`Downloaded file is too small (${buf.length} bytes)`);
      }
      return buf;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(
          `[setup-mediapipe] Download attempt ${attempt}/${attempts} failed; retrying ...`,
        );
      }
    }
  }

  throw lastError ?? new Error("Unknown download error");
}

export async function main() {
  await mkdir(WASM_DEST, { recursive: true });
  await mkdir(MODELS_DEST, { recursive: true });

  // 1) Locate the WASM bundle inside node_modules. The package's `exports`
  //    field doesn't expose the wasm/ directory, so require.resolve fails;
  //    we walk a few known candidate paths instead. The first one that
  //    contains the expected WASM file wins.
  const candidates = [
    // pnpm hoisted location (most common in this monorepo)
    resolve(
      PROJECT_ROOT,
      "..",
      "..",
      "node_modules",
      "@mediapipe",
      "tasks-vision",
      "wasm",
    ),
    // Local artifact node_modules (fallback)
    resolve(PROJECT_ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm"),
  ];
  let wasmSrc = "";
  for (const c of candidates) {
    if (existsSync(resolve(c, "vision_wasm_internal.wasm"))) {
      wasmSrc = c;
      break;
    }
  }
  if (!wasmSrc) {
    throw new Error(
      `Could not find @mediapipe/tasks-vision/wasm in any of:\n  ${candidates.join("\n  ")}\nDid you run \`pnpm install\`?`,
    );
  }
  const files = await readdir(wasmSrc);
  for (const f of files) {
    await copyFile(resolve(wasmSrc, f), resolve(WASM_DEST, f));
  }
  console.log(
    `[setup-mediapipe] Copied ${files.length} WASM files → public/mediapipe/wasm/`,
  );

  // 2) Download the face landmark model if it's not already cached. Models
  //    are large (~3.5 MB) and immutable, so we never re-download.
  let needsDownload = true;
  try {
    const s = await stat(MODEL_DEST);
    if (s.size > MIN_MODEL_BYTES) {
      needsDownload = false;
    }
  } catch {
    /* missing — will download */
  }

  if (!needsDownload) {
    console.log("[setup-mediapipe] face_landmarker.task already cached");
    return;
  }

  // Escape hatch for sandboxed environments (agent runners, offline
  // builds, network-restricted CI) where storage.googleapis.com is not
  // reachable. Setting SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1 lets `pnpm build`
  // complete; the face-capture feature will be unavailable until the
  // model is provided out-of-band, but every other page builds fine.
  // Real production CI must leave this unset so strict mode catches a
  // genuinely missing model.
  if (process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD === "1") {
    console.warn(
      "[setup-mediapipe] SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1 set; skipping face_landmarker.task download.",
    );
    return;
  }

  console.log("[setup-mediapipe] Downloading face_landmarker.task ...");
  const buf = await downloadModelWithRetry();
  await writeFile(MODEL_DEST, buf);
  console.log(
    `[setup-mediapipe] Downloaded face_landmarker.task (${(buf.length / 1024 / 1024).toFixed(2)} MB)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.warn("[setup-mediapipe] WARN:", e.message);
    const hasCachedModel = (() => {
      try {
        return statSync(MODEL_DEST).size > MIN_MODEL_BYTES;
      } catch {
        return false;
      }
    })();
    const strictMode =
      process.env.CI === "true" || process.env.NODE_ENV === "production";
    if (strictMode && !hasCachedModel) {
      console.error(
        "[setup-mediapipe] ERROR: No usable face_landmarker.task available in strict mode.",
      );
      process.exit(1);
    }
    // Non-fatal: dev server still starts, face-capture feature will be
    // unavailable but all other pages (home, masks, questionnaire, results,
    // shop) work without WASM assets.
    process.exit(0);
  });
}
