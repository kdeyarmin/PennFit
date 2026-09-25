import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Operator-managed secrets, never returned to a browser or persisted in tenant
// settings. Staging a connection does not move a number or enable traffic.
const connectionSchema = z
  .object({
    orgId: z.string().uuid(),
    businessName: z.string().trim().min(1).max(200),
    accountSid: z.string().regex(/^AC[0-9a-f]{32}$/i),
    parentAccountSid: z.string().regex(/^AC[0-9a-f]{32}$/i),
    apiKeySid: z.string().regex(/^SK[0-9a-f]{32}$/i),
    apiKeySecret: z.string().min(32).max(256),
    authToken: z.string().min(32).max(256),
    numbers: z
      .array(z.string().regex(/^\+[1-9][0-9]{7,14}$/))
      .min(1)
      .max(100),
    messagingServiceSids: z
      .array(z.string().regex(/^MG[0-9a-f]{32}$/i))
      .max(100),
    state: z.enum(["staged", "active"]),
    smsApproved: z.boolean(),
  })
  .strict();
export type TenantTwilioAccount = z.infer<typeof connectionSchema>;
type Env = Record<string, string | undefined>;

export function readTenantTwilioAccounts(
  env: Env = process.env,
): TenantTwilioAccount[] {
  const raw = env.TWILIO_TENANT_ACCOUNTS_JSON?.trim();
  if (!raw) return [];
  try {
    const accounts = z.array(connectionSchema).max(1000).parse(JSON.parse(raw));
    const ids = new Set<string>(),
      orgs = new Set<string>(),
      resources = new Set<string>();
    for (const account of accounts) {
      if (
        ids.has(account.accountSid) ||
        orgs.has(account.orgId) ||
        account.accountSid === env.TWILIO_ACCOUNT_SID ||
        account.parentAccountSid !== env.TWILIO_ACCOUNT_SID
      )
        throw new Error();
      ids.add(account.accountSid);
      orgs.add(account.orgId);
      for (const resource of new Set([
        ...account.numbers,
        ...account.messagingServiceSids,
      ])) {
        if (resources.has(resource) || resource === "+18775212890")
          throw new Error();
        resources.add(resource);
      }
      if (
        account.state === "active" &&
        (env.TWILIO_TENANT_CALLBACK_KEY?.length ?? 0) < 32
      )
        throw new Error();
    }
    return accounts;
  } catch {
    // Zod / JSON errors can include credential values. Never propagate them.
    throw new Error(
      "Tenant Twilio configuration is invalid; contact the platform administrator.",
    );
  }
}

export function tenantTwilioAccountForOrg(
  orgId: string,
  env: Env = process.env,
) {
  return readTenantTwilioAccounts(env).find(
    (account) => account.orgId === orgId,
  );
}

export function tenantTwilioAccountForSender(
  from?: string,
  service?: string,
  env: Env = process.env,
) {
  const accounts = readTenantTwilioAccounts(env);
  const fromAccount = accounts.find(
    (account) => !!from && account.numbers.includes(from),
  );
  const serviceAccount = accounts.find(
    (account) => !!service && account.messagingServiceSids.includes(service),
  );
  if (
    (fromAccount && service && fromAccount !== serviceAccount) ||
    (serviceAccount && from && fromAccount !== serviceAccount)
  ) {
    throw new Error(
      "Twilio sender and messaging service belong to different accounts.",
    );
  }
  return serviceAccount ?? fromAccount;
}

export function assertTenantTwilioReady(
  account: TenantTwilioAccount,
  channel: "voice" | "sms",
) {
  if (
    account.state !== "active" ||
    (channel === "sms" && !account.smsApproved)
  ) {
    throw new Error(
      "Tenant phone connection is awaiting activation or texting approval.",
    );
  }
}

export function tenantTwilioAccountSummary(orgId: string) {
  const account = tenantTwilioAccountForOrg(orgId);
  return account
    ? {
        mode: "subaccount" as const,
        businessName: account.businessName,
        accountSid: account.accountSid,
        parentAccountSid: account.parentAccountSid,
        state: account.state,
        smsApproved: account.smsApproved,
      }
    : { mode: "shared" as const, state: "legacy" as const, smsApproved: false };
}

// A subaccount holder can sign arbitrary requests with their own auth token.
// Bind outbound callback URLs (including record IDs) to the platform's secret,
// so they cannot forge a callback referring to another tenant's records.
const ACCOUNT_PARAM = "cmAccount";
const SIGNATURE_PARAM = "cmProof";
function proof(url: string, env: Env) {
  const key = env.TWILIO_TENANT_CALLBACK_KEY;
  if (!key || key.length < 32)
    throw new Error("Tenant callback signing is not configured.");
  return createHmac("sha256", key).update(url).digest("hex");
}
export function signTenantTwilioCallback(
  url: string,
  account: TenantTwilioAccount,
  env: Env = process.env,
) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password)
    throw new Error("Tenant callback requires HTTPS.");
  target.searchParams.delete(SIGNATURE_PARAM);
  target.searchParams.set(ACCOUNT_PARAM, account.accountSid);
  const signature = proof(target.toString(), env);
  target.searchParams.set(SIGNATURE_PARAM, signature);
  return target.toString();
}
export function verifyTenantTwilioCallback(
  url: string,
  account: TenantTwilioAccount,
  env: Env = process.env,
) {
  try {
    const target = new URL(url);
    if (
      target.searchParams.getAll(ACCOUNT_PARAM).length !== 1 ||
      target.searchParams.get(ACCOUNT_PARAM) !== account.accountSid ||
      target.searchParams.getAll(SIGNATURE_PARAM).length !== 1
    )
      return false;
    const signature = target.searchParams.get(SIGNATURE_PARAM) ?? "";
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    target.searchParams.delete(SIGNATURE_PARAM);
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(proof(target.toString(), env)),
    );
  } catch {
    return false;
  }
}
