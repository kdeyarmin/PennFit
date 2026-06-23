import { describe, expect, it } from "vitest";

import { serverUnavailableMessage } from "./error-message";

describe("serverUnavailableMessage", () => {
  it("points users at the platform status page", () => {
    expect(
      serverUnavailableMessage({
        action: "sign you in",
        subject: "email or password",
      }),
    ).toContain("status.cmbreathe.com");
  });
});
