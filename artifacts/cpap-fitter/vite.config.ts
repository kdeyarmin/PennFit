import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { packageNameFromModulePath } from "../shared/vite/manual-chunks";
import { fitterChunkForPackage } from "../shared/vite/chunk-groups";

const isBuild = process.argv.includes("build");

const rawPort = process.env.PORT;
if (!isBuild && !rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}
const port = rawPort ? Number(rawPort) : 3000;
if (!isBuild && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;
if (!isBuild && !basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

// Forward API requests to the resupply-api process. The SPA fetches
// `/api/*` and `/resupply-api/*` against its own origin (see
// `lib/api-client-react/src/storefront/custom-fetch.ts`); when the
// SPA is served by a different process than the API (dev: vite dev
// server on 5173 vs. API on 3000; production: separate Railway
// services), there has to be a proxy hop or those calls land on the
// SPA host and get back the index.html shell — which is what
// produced the empty `/masks` page after the Replit→Railway move.
//
// Dev default targets the README's documented local API port. In
// production set API_PROXY_TARGET to the resupply-api service URL
// (on Railway, use the internal hostname, e.g.
// `http://resupply-api.railway.internal:${PORT}`).
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";
const apiProxyConfig = {
  "/api": {
    target: apiProxyTarget,
    changeOrigin: true,
  },
  "/resupply-api": {
    target: apiProxyTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  base: basePath ?? "/",
  plugins: [
    react(),
    // optimize:false prevents lightningcss from reordering @layer imports
    // in production builds. We previously needed this to keep third-party
    // @layer-using widgets intact; we keep it on as cheap insurance
    // against any future @layer-using third-party widget.
    tailwindcss({ optimize: false }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "attached_assets",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Warn when any chunk crosses 400 kB (uncompressed). The existing
    // manualChunks function already splits big vendor groups (react,
    // recharts, framer-motion, lucide, …) into separate chunks, so a
    // breach typically means a page module or feature bundle grew past
    // the budget without splitting. Default is 500; we tighten to 400
    // so the warning fires before main-thread parse cost gets noticeable
    // on 3G / older Android.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      onwarn(warning, warn) {
        if (
          warning.code === "SOURCEMAP_ERROR" &&
          warning.message.includes("Can't resolve original location of error")
        ) {
          return;
        }
        warn(warning);
      },
      output: {
        manualChunks(id) {
          const packageName = packageNameFromModulePath(id);
          if (!packageName) return;
          return fitterChunkForPackage(packageName);
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: apiProxyConfig,
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxyConfig,
  },
});
