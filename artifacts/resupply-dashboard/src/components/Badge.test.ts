import { describe, it, expect } from "vitest";
import { humanizeAction, humanizeStatus } from "./Badge";

describe("humanizeAction", () => {
  it("returns em-dash for empty / nullish input", () => {
    expect(humanizeAction(null)).toBe("—");
    expect(humanizeAction(undefined)).toBe("—");
    expect(humanizeAction("")).toBe("—");
    expect(humanizeAction("   ")).toBe("—");
  });

  it("title-cases dotted action codes", () => {
    expect(humanizeAction("voice.call.placed")).toBe("Voice Call Placed");
    expect(humanizeAction("messaging.handoff.escalated")).toBe(
      "Messaging Handoff Escalated",
    );
    expect(humanizeAction("system.heartbeat")).toBe("System Heartbeat");
  });

  it("title-cases mixed dotted + snake_case codes", () => {
    expect(humanizeAction("patient.prescription.status_changed")).toBe(
      "Patient Prescription Status Changed",
    );
    expect(humanizeAction("messaging.intent.parsed")).toBe(
      "Messaging Intent Parsed",
    );
  });

  it("preserves known acronyms", () => {
    expect(humanizeAction("audit.export.csv")).toBe("Audit Export CSV");
    expect(humanizeAction("messaging.sms.failed")).toBe("Messaging SMS Failed");
    expect(humanizeAction("api.json.response")).toBe("API JSON Response");
  });

  it("splits camelCase metadata keys with acronym preservation", () => {
    expect(humanizeAction("messageSid")).toBe("Message SID");
    expect(humanizeAction("callSid")).toBe("Call SID");
    expect(humanizeAction("patientId")).toBe("Patient ID");
    expect(humanizeAction("episodeId")).toBe("Episode ID");
    expect(humanizeAction("messageCount")).toBe("Message Count");
    expect(humanizeAction("deliveryStatus")).toBe("Delivery Status");
    expect(humanizeAction("templateName")).toBe("Template Name");
    expect(humanizeAction("errorCode")).toBe("Error Code");
  });

  it("handles ACR→Word camel boundaries", () => {
    expect(humanizeAction("HTTPRequest")).toBe("HTTP Request");
    expect(humanizeAction("APIError")).toBe("API Error");
  });

  it("strips trailing key=value args used by admin_audit_log", () => {
    expect(humanizeAction("team.role_change to=admin user=foo@bar.com")).toBe(
      "Team Role Change",
    );
    expect(humanizeAction("team.invite role=admin email=x@y.z")).toBe(
      "Team Invite",
    );
  });

  it("title-cases plain table names", () => {
    expect(humanizeAction("patients")).toBe("Patients");
    expect(humanizeAction("admin_audit_log")).toBe("Admin Audit Log");
  });
});

describe("humanizeStatus", () => {
  it("returns em-dash for nullish input", () => {
    expect(humanizeStatus(null)).toBe("—");
    expect(humanizeStatus(undefined)).toBe("—");
  });

  it("title-cases snake_case enum values", () => {
    expect(humanizeStatus("awaiting_response")).toBe("Awaiting Response");
    expect(humanizeStatus("in_fulfillment")).toBe("In Fulfillment");
    expect(humanizeStatus("active")).toBe("Active");
  });
});
