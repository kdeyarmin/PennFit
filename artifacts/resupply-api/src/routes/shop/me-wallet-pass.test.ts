// Route tests for GET /shop/me/wallet-pass.pkpass.
//
// Coverage:
//   * 401 without sign-in
//   * 404 when shop_customers row doesn't exist
//   * 503 with wallet_not_configured when Apple Wallet env unset
//   * 502 on PKCS#7 sign error
//   * 200 with .pkpass content-type when build succeeds

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const { buildPkpassMock, NotConfigured, SignError } = vi.hoisted(() => {
  class NotConfigured extends Error {
    constructor(msg = "not configured") {
      super(msg);
      this.name = "AppleWalletNotConfiguredError";
    }
  }
  class SignError extends Error {
    constructor(msg = "sign failed") {
      super(msg);
      this.name = "AppleWalletSignError";
    }
  }
  return {
    buildPkpassMock: vi.fn(async () => Buffer.from("fake-pkpass")),
    NotConfigured,
    SignError,
  };
});
vi.mock("../../lib/apple-wallet/pkpass", () => ({
  buildPkpass: buildPkpassMock,
  AppleWalletNotConfiguredError: NotConfigured,
  AppleWalletSignError: SignError,
}));
vi.mock("../../lib/apple-wallet/assets", () => ({
  defaultIconPng: () => Buffer.from("icon"),
  defaultLogoPng: () => Buffer.from("logo"),
}));

import walletRouter from "./me-wallet-pass";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(walletRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  buildPkpassMock.mockReset();
  buildPkpassMock.mockResolvedValue(Buffer.from("fake-pkpass"));
  supabaseMock.reset();
});

describe("GET /shop/me/wallet-pass.pkpass", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/wallet-pass.pkpass");
    expect(res.status).toBe(401);
  });

  it("404s when no shop_customers row exists", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp()).get("/shop/me/wallet-pass.pkpass");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_customer_row");
  });

  it("503s wallet_not_configured when build throws NotConfigured", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "cust_1",
        email_lower: "a@a.test",
        display_name: "Alice",
      },
    });
    buildPkpassMock.mockRejectedValueOnce(new NotConfigured());
    const res = await request(makeApp()).get("/shop/me/wallet-pass.pkpass");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("wallet_not_configured");
  });

  it("502s on PKCS#7 sign error", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "cust_1",
        email_lower: "a@a.test",
        display_name: "Alice",
      },
    });
    buildPkpassMock.mockRejectedValueOnce(new SignError());
    const res = await request(makeApp()).get("/shop/me/wallet-pass.pkpass");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("wallet_sign_failed");
  });

  it("200s with .pkpass content type and attachment header on success", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "cust_1abcde",
        email_lower: "a@a.test",
        display_name: "Alice",
      },
    });
    const res = await request(makeApp()).get("/shop/me/wallet-pass.pkpass");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.apple.pkpass",
    );
    expect(res.headers["content-disposition"]).toContain(".pkpass");
    expect(buildPkpassMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice",
        logoText: "PennPaps",
      }),
    );
  });
});
