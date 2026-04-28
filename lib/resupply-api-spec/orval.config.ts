import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const liveSrc = path.resolve(root, "lib", "resupply-api-client", "src");

// When the codegen drift check runs (scripts/check-codegen.sh), it sets
// CODEGEN_OUT_RESUPPLY_CLIENT to a temp directory so orval writes its
// generated output OUTSIDE the live source tree. This is essential
// because the dashboard's vite dev server watches the live tree —
// briefly deleting/replacing the generated files (as orval does with
// `clean: true`) blows up Vite's pre-transform and leaves the
// dashboard rendering blank until it's restarted. The mutator path
// (custom-fetch.ts) always stays pointed at the live source: orval
// only reads from it, so it never gets touched by the temp run.
const apiClientReactSrc = process.env.CODEGEN_OUT_RESUPPLY_CLIENT
  ? path.resolve(process.env.CODEGEN_OUT_RESUPPLY_CLIENT)
  : liveSrc;

// Our exports make assumptions about the title of the API being "Api"
// (i.e. generated output is `api.ts`). Mirror what lib/api-spec does so
// the two pipelines stay structurally identical.
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "resupply-api-client": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/resupply-api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          // The mutator path must follow the workspace redirect so
          // orval's generated import resolves to "../custom-fetch"
          // (relative to "<workspace>/generated/") in BOTH the live
          // and temp-output cases. If we hard-coded this to liveSrc
          // while the workspace was redirected to a temp dir, orval
          // would emit a long absolute-ish relative path like
          // "../../../../home/runner/workspace/lib/..." and the
          // drift check would always fail with a false positive.
          //
          // The drift checker (scripts/check-codegen.sh) copies the
          // real custom-fetch.ts into the temp workspace before
          // running orval so this path always resolves to a real
          // file on disk.
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
});
