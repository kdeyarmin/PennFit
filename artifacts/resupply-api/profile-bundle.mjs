#!/usr/bin/env node
// Profile the resupply-api esbuild bundle: emit a metafile, then
// print a top-N breakdown of the largest contributors. Used as a
// diagnostic for the 11.3 MB single-file bundle (see AUDIT_REPORT.md
// follow-up #4). Not part of the production build pipeline; run
// manually from this artifact's directory:
//
//   node profile-bundle.mjs

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { build as esbuild, analyzeMetafile } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const apiRoot = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(apiRoot, "dist-profile");

const result = await esbuild({
  entryPoints: [path.join(apiRoot, "src/index.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  metafile: true,
  // Match production externals (kept in sync with build.mjs).
  external: [
    "*.node",
    "twilio",
    "stripe",
    "sharp",
    "better-sqlite3",
    "sqlite3",
    "canvas",
    "bcrypt",
    "argon2",
    "fsevents",
    "re2",
    "farmhash",
    "xxhash-addon",
    "bufferutil",
    "utf-8-validate",
    "ssh2",
    "cpu-features",
    "dtrace-provider",
    "isolated-vm",
    "lightningcss",
    "pg-native",
    "oracledb",
    "mongodb-client-encryption",
    "nodemailer",
    "handlebars",
    "knex",
    "typeorm",
    "protobufjs",
    "onnxruntime-node",
    "@tensorflow/*",
    "@prisma/client",
    "@mikro-orm/*",
    "@grpc/*",
    "@swc/*",
    "@aws-sdk/*",
    "@azure/*",
    "@opentelemetry/*",
    "@google-cloud/*",
    "@google/*",
    "googleapis",
    "firebase-admin",
    "@parcel/watcher",
    "@sentry/profiling-node",
    "@tree-sitter/*",
    "aws-sdk",
    "classic-level",
    "dd-trace",
    "ffi-napi",
    "grpc",
    "hiredis",
    "kerberos",
    "leveldown",
    "miniflare",
    "mysql2",
    "newrelic",
    "odbc",
    "piscina",
    "realm",
    "ref-napi",
    "rocksdb",
    "sass-embedded",
    "sequelize",
    "serialport",
    "snappy",
    "tinypool",
    "usb",
    "workerd",
    "wrangler",
    "zeromq",
    "zeromq-prebuilt",
    "playwright",
    "puppeteer",
    "puppeteer-core",
    "electron",
  ],
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
  },
});

await writeFile(
  path.join(outDir, "meta.json"),
  JSON.stringify(result.metafile),
);

const analysis = await analyzeMetafile(result.metafile, { verbose: false });
console.log(analysis);

// Roll up by node_modules package and print the top 25.
// pnpm's layout is `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...`
// for transitive deps; top-level deps still use plain `node_modules/<pkg>`.
/** @type {Map<string, number>} */
const byPackage = new Map();
for (const [file, info] of Object.entries(result.metafile.inputs)) {
  let pkg = "<src>";
  const pnpmMatch = file.match(
    /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/,
  );
  if (pnpmMatch) {
    pkg = pnpmMatch[1];
  } else {
    const plainMatch = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (plainMatch) pkg = plainMatch[1];
  }
  byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + info.bytes);
}
const ranked = [...byPackage.entries()].sort((a, b) => b[1] - a[1]);
console.log("\nTop 25 packages by bundled bytes:");
for (const [pkg, bytes] of ranked.slice(0, 25)) {
  console.log(`  ${(bytes / 1024).toFixed(1).padStart(8)} kB   ${pkg}`);
}

const totalBundled = ranked.reduce((acc, [, b]) => acc + b, 0);
console.log(
  `\nTotal bundled input: ${(totalBundled / 1024 / 1024).toFixed(2)} MB across ${ranked.length} packages`,
);
