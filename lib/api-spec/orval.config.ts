import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const liveApiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const liveApiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// When the codegen drift check runs (scripts/check-codegen.sh), it
// sets these env vars to temp directories so orval writes its output
// OUTSIDE the live source tree. This is essential because the
// cpap-fitter dev server watches the live tree — briefly deleting/
// replacing the generated files (as orval does with `clean: true`)
// blows up Vite's pre-transform and leaves the app rendering blank
// until it's restarted. The mutator path (custom-fetch.ts) always
// stays pointed at the live source: orval only reads from it, so it
// never gets touched by the temp run.
const apiClientReactSrc = process.env.CODEGEN_OUT_PENN_FIT_CLIENT
  ? path.resolve(process.env.CODEGEN_OUT_PENN_FIT_CLIENT)
  : liveApiClientReactSrc;
const apiZodSrc = process.env.CODEGEN_OUT_PENN_FIT_ZOD
  ? path.resolve(process.env.CODEGEN_OUT_PENN_FIT_ZOD)
  : liveApiZodSrc;

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
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
      baseUrl: "/api",
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
          // and temp-output cases. The drift checker copies the real
          // custom-fetch.ts into the temp workspace before running
          // orval so this path always resolves to a real file.
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
