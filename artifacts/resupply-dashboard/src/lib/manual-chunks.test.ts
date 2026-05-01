import { describe, expect, it } from "vitest";
import { packageNameFromModulePath } from "../../../shared/vite/manual-chunks";

describe("packageNameFromModulePath", () => {
  it("returns null for non-node_modules paths", () => {
    expect(packageNameFromModulePath("/workspace/app/src/main.ts")).toBeNull();
  });

  it("parses unscoped packages", () => {
    expect(
      packageNameFromModulePath("/workspace/node_modules/react/index.js"),
    ).toBe("react");
  });

  it("parses scoped packages", () => {
    expect(
      packageNameFromModulePath(
        "/workspace/node_modules/@tanstack/react-query/build/modern/index.js",
      ),
    ).toBe("@tanstack/react-query");
  });

  it("parses pnpm virtual store paths", () => {
    expect(
      packageNameFromModulePath(
        "/workspace/node_modules/.pnpm/@radix-ui+react-dialog@1.1.7/node_modules/@radix-ui/react-dialog/dist/index.mjs",
      ),
    ).toBe("@radix-ui/react-dialog");
  });

  it("parses windows-style paths", () => {
    expect(
      packageNameFromModulePath(
        "C:\\workspace\\node_modules\\@tanstack\\react-query\\build\\modern\\index.js",
      ),
    ).toBe("@tanstack/react-query");
  });
});
