import { describe, it, expect } from "vitest";

import { createAndSendPatientPacket } from "./send";

describe("createAndSendPatientPacket", () => {
  it("rejects invalid document keys before touching the database", async () => {
    // Invalid keys are validated up front, so no Supabase client is
    // needed — passing an object that would throw if used proves it.
    const res = await createAndSendPatientPacket({
      supabase: {} as never,
      patientId: "11111111-1111-1111-1111-111111111111",
      documentKeys: ["assignment_of_benefits", "not_a_real_doc"],
    });
    expect(res).toEqual({
      ok: false,
      code: "invalid_document_keys",
      invalidKeys: ["not_a_real_doc"],
    });
  });
});
