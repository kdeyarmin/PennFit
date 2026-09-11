import { z } from "zod";
import { createHash } from "node:crypto";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

const HUB_ORIGIN = "https://xgauehtwksmnoqhgqegm.supabase.co";
const HUB_APP_AUTHORIZE =
  "https://support-hub-web-production.up.railway.app/api/internal/admin/breathe/authorize";
const SOURCE = "application_database" as const;
const staffRoles = ["admin", "agent"] as const;
const subscriptionStatuses = [
  "active",
  "trialing",
  "past_due",
  "canceled",
] as const;
const operations = [
  "capabilities",
  "overview",
  "organizations.list",
  "users.list",
  "billing.overview",
  "billing.subscriptions.list",
  "support.identity.resolve",
] as const;
const uuid = z.string().uuid();
// In-house auth IDs are TEXT, including legacy IDs. Preserve native case.
const nativeUserId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const search = z
  .string()
  .max(100)
  .refine(
    (value) =>
      !Array.from(value).some(
        (character) =>
          character === "*" ||
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127,
      ),
  )
  .transform((value) => value.trim());
const page = {
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
};
const operationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("support.identity.resolve"),
      sourceUserId: nativeUserId,
      sourceAccountId: uuid,
    })
    .strict(),
  z.object({ operation: z.literal("capabilities") }).strict(),
  z.object({ operation: z.literal("overview") }).strict(),
  z.object({ operation: z.literal("billing.overview") }).strict(),
  z
    .object({
      operation: z.literal("organizations.list"),
      ...page,
      search: search.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("users.list"),
      ...page,
      search: search.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("billing.subscriptions.list"),
      ...page,
      search: search.optional(),
      organizationId: uuid.optional(),
    })
    .strict(),
]);

type RawClient = ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>;
interface Config {
  enabled: boolean;
  hubKey?: string;
  identities?: Map<string, string>;
  sourceRevision?: string | null;
}
export interface CentralAdminOptions {
  getEnv?: (name: string) => string | undefined;
  getClient?: () => Promise<RawClient>;
  fetcher?: typeof fetch;
  now?: () => Date;
}

class CentralAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** An explicit deployment grant, never an email-derived role or a native session mint. */
export function readCentralAdminConfig(
  getEnv: (name: string) => string | undefined = (name) => process.env[name],
): Config {
  const enabled = getEnv("CAREMETRIC_ADMIN_ENABLED");
  if (!enabled || enabled === "false") return { enabled: false };
  if (enabled !== "true") throw new CentralAdminError(503, "unconfigured");
  const hubKey = getEnv("HUB_SUPABASE_PUBLISHABLE_KEY") ?? "";
  if (!hubKey.startsWith("sb_publishable_"))
    throw new CentralAdminError(503, "unconfigured");
  let mapping: unknown;
  try {
    mapping = JSON.parse(getEnv("CAREMETRIC_ADMIN_IDENTITY_MAP_JSON") ?? "");
  } catch {
    throw new CentralAdminError(503, "unconfigured");
  }
  const validated = z.record(z.string(), nativeUserId).safeParse(mapping);
  if (!validated.success) throw new CentralAdminError(503, "unconfigured");
  const entries = Object.entries(validated.data);
  if (
    entries.length < 1 ||
    entries.length > 100 ||
    entries.some(([key]) => !uuid.safeParse(key).success)
  )
    throw new CentralAdminError(503, "unconfigured");
  const identities = new Map(
    entries.map(([hubId, nativeId]) => [hubId.toLowerCase(), nativeId]),
  );
  if (
    identities.size !== entries.length ||
    new Set(identities.values()).size !== entries.length
  )
    throw new CentralAdminError(503, "unconfigured");
  const revision = getEnv("RAILWAY_GIT_COMMIT_SHA") ?? getEnv("GIT_COMMIT_SHA");
  return {
    enabled: true,
    hubKey,
    identities,
    sourceRevision:
      revision && /^[a-f0-9]{40}$/i.test(revision)
        ? revision.toLowerCase()
        : null,
  };
}

async function nativeClient(): Promise<RawClient> {
  // These directories are global by design. Acquire the native client through
  // the same scoped chokepoint used by existing platform administration routes.
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) throw new CentralAdminError(503, "upstream");
  return getOrgScopedClient(seedOrgId).raw();
}

async function untilAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw new CentralAdminError(503, "upstream");
  }
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new CentralAdminError(503, "upstream"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function boundedJson(
  source: Request | Response,
  max: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!source.body) throw new CentralAdminError(400, "invalid_request");
  const reader = source.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > max) {
        cancel();
        throw new Error("Response limit");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function exactCount(result: { error: unknown; count: number | null }): number {
  if (result.error || !count.safeParse(result.count).success)
    throw new CentralAdminError(503, "upstream");
  return result.count as number;
}

const text = (max: number) => z.string().max(max);
const organizationRow = z.object({
  id: uuid,
  name: text(1000).nullable(),
  slug: text(200),
  status: text(100),
  created_at: text(100),
});
const userRow = z.object({
  id: nativeUserId,
  email_lower: text(500),
  display_name: text(1000).nullable(),
  role: z.enum(staffRoles),
  status: z.enum(["active", "invited", "locked", "revoked"]),
  created_at: text(100),
});
const subscriptionRow = z.object({
  id: uuid,
  org_id: uuid,
  status: z.enum(subscriptionStatuses),
  stripe_status: text(100).nullable(),
  stripe_customer_id: text(200).nullable(),
  stripe_subscription_id: text(200).nullable(),
  current_period_end: text(100).nullable(),
  updated_at: text(100).nullable(),
  organizations: z.object({ name: text(1000).nullable() }).nullable(),
  billing_plans: z.object({ code: text(200), name: text(1000) }).nullable(),
});

function rows<T>(
  schema: z.ZodType<T>,
  result: { data: unknown; error: unknown },
  limit: number,
): T[] {
  if (result.error) throw new CentralAdminError(503, "upstream");
  const parsed = z.array(schema).max(limit).safeParse(result.data);
  if (!parsed.success) throw new CentralAdminError(503, "upstream");
  return parsed.data;
}

const contains = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

/** Read-only issuer-to-native adapter. Native customer/clinical tables are never queried. */
export function createCentralAdminHandler({
  getEnv,
  getClient = nativeClient,
  fetcher = fetch,
  now = () => new Date(),
}: CentralAdminOptions = {}) {
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  return async (request: Request): Promise<Response> => {
    try {
      const config = readCentralAdminConfig(getEnv);
      if (!config.enabled) throw new CentralAdminError(503, "unconfigured");
      if (request.method !== "POST")
        throw new CentralAdminError(405, "method_not_allowed");
      if (request.headers.has("origin") || request.headers.has("cookie"))
        throw new CentralAdminError(403, "forbidden");
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        throw new CentralAdminError(415, "unsupported_content_type");
      const authorization = request.headers.get("authorization") ?? "";
      const appSms = /^Bearer cmh_[A-Za-z0-9_-]{43}$/.test(authorization);
      if (
        (!appSms &&
          !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
            authorization,
          )) ||
        authorization.length > 8192
      )
        throw new CentralAdminError(401, "unauthenticated");
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(12000),
      ]);
      let operation: z.infer<typeof operationSchema>;
      try {
        operation = operationSchema.parse(
          await boundedJson(request, 2048, signal),
        );
      } catch {
        throw new CentralAdminError(400, "invalid_request");
      }
      const authResponse = await fetcher(
        appSms
          ? HUB_APP_AUTHORIZE
          : `${HUB_ORIGIN}/rest/v1/rpc/authorize_platform_admin`,
        {
          method: "POST",
          headers: {
            ...(appSms
              ? {}
              : { apikey: config.hubKey!, "Content-Profile": "hub" }),
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: "{}",
          redirect: "error",
          signal,
        },
      );
      if (!authResponse.ok)
        throw new CentralAdminError(
          authResponse.status === 401
            ? 401
            : authResponse.status === 403
              ? 403
              : 503,
          authResponse.status === 401
            ? "unauthenticated"
            : authResponse.status === 403
              ? "forbidden"
              : "upstream",
        );
      const rawActor = await boundedJson(authResponse, 4096, signal);
      const actor = z
        .object({
          user_id: uuid,
          role: z.literal("platform_admin"),
        })
        .safeParse(rawActor);
      if (!actor.success) throw new CentralAdminError(403, "forbidden");
      if (appSms) {
        const proof = z
          .object({ method: z.literal("sms"), operation: operationSchema })
          .safeParse(rawActor);
        if (
          !proof.success ||
          JSON.stringify(proof.data.operation) !== JSON.stringify(operation)
        )
          throw new CentralAdminError(403, "forbidden");
      } else if (
        !z.object({ aal: z.literal("aal2") }).safeParse(rawActor).success
      ) {
        throw new CentralAdminError(403, "forbidden");
      }
      const nativeId = config.identities!.get(actor.data.user_id.toLowerCase());
      if (!nativeId) throw new CentralAdminError(403, "forbidden");
      const raw = await untilAbort(getClient(), signal);
      const [user, membership] = await Promise.all([
        raw
          .schema("resupply_auth")
          .from("users")
          .select("id,role,status,email_verified_at")
          .eq("id", nativeId)
          .limit(1)
          .abortSignal(signal)
          .maybeSingle(),
        raw
          .schema("resupply")
          .from("platform_admins")
          .select("auth_user_id")
          .eq("auth_user_id", nativeId)
          .limit(1)
          .abortSignal(signal)
          .maybeSingle(),
      ]);
      if (user.error || membership.error)
        throw new CentralAdminError(503, "upstream");
      const verifiedUser = z
        .object({
          id: z.literal(nativeId),
          role: z.literal("admin"),
          status: z.literal("active"),
          email_verified_at: z
            .string()
            .refine((value) => Number.isFinite(Date.parse(value))),
        })
        .safeParse(user.data);
      if (!verifiedUser.success || membership.data?.auth_user_id !== nativeId)
        throw new CentralAdminError(403, "forbidden");

      let data: unknown;
      if (operation.operation === "capabilities") {
        data = {
          apiVersion: 1,
          operations,
          sourceRevision: config.sourceRevision,
        };
      } else if (operation.operation === "support.identity.resolve") {
        if (!appSms) throw new CentralAdminError(401, "unauthenticated");
        const { sourceUserId, sourceAccountId } = operation;
        const [target, link, account] = await Promise.all([
          raw
            .schema("resupply_auth")
            .from("users")
            .select("id,role,status,email_verified_at,updated_at")
            .eq("id", sourceUserId)
            .limit(2)
            .abortSignal(signal),
          raw
            .schema("resupply")
            .from("admin_users")
            .select("id,auth_user_id,org_id,role,status,revoked_at,updated_at")
            .eq("auth_user_id", sourceUserId)
            .eq("org_id", sourceAccountId)
            .limit(2)
            .abortSignal(signal),
          raw
            .schema("resupply")
            .from("organizations")
            .select("id,status,updated_at")
            .eq("id", sourceAccountId)
            .limit(2)
            .abortSignal(signal),
        ]);
        if (target.error || link.error || account.error)
          throw new CentralAdminError(503, "upstream");
        const date = z
          .string()
          .refine((value) => Number.isFinite(Date.parse(value)));
        const targetProof = z
          .array(
            z.object({
              id: z.literal(sourceUserId),
              role: z.enum(staffRoles),
              status: z.literal("active"),
              email_verified_at: date,
              updated_at: date,
            }),
          )
          .length(1)
          .safeParse(target.data);
        const linkProof = z
          .array(
            z.object({
              id: uuid,
              auth_user_id: z.literal(sourceUserId),
              org_id: z.literal(sourceAccountId),
              role: z.enum([
                "admin",
                "supervisor",
                "csr",
                "fitter",
                "fulfillment",
                "compliance_officer",
                "agent",
                "rt",
                "biller",
              ]),
              status: z.literal("active"),
              revoked_at: z.null(),
              updated_at: date,
            }),
          )
          .length(1)
          .safeParse(link.data);
        const accountProof = z
          .array(
            z.object({
              id: z.literal(sourceAccountId),
              status: z.literal("active"),
              updated_at: date,
            }),
          )
          .length(1)
          .safeParse(account.data);
        if (!targetProof.success || !linkProof.success || !accountProof.success)
          throw new CentralAdminError(403, "forbidden");
        const revision = createHash("sha256")
          .update(
            JSON.stringify([
              "breathe",
              targetProof.data[0],
              linkProof.data[0],
              accountProof.data[0],
            ]),
          )
          .digest("hex");
        data = {
          product: "breathe",
          sourceUserId,
          sourceAccountId,
          accountKind: "organization",
          relationship: "organization_member",
          revision,
        };
      } else if (operation.operation === "overview") {
        const [orgs, users, subs] = await Promise.all([
          raw
            .schema("resupply")
            .from("organizations")
            .select("id", { count: "exact", head: true })
            .abortSignal(signal),
          raw
            .schema("resupply_auth")
            .from("users")
            .select("id", { count: "exact", head: true })
            .in("role", [...staffRoles])
            .eq("status", "active")
            .abortSignal(signal),
          raw
            .schema("resupply")
            .from("tenant_billing_subscriptions")
            .select("id", { count: "exact", head: true })
            .abortSignal(signal),
        ]);
        data = {
          organizationCount: exactCount(orgs),
          activeUserCount: exactCount(users),
          subscriptionCount: exactCount(subs),
        };
      } else if (operation.operation === "organizations.list") {
        let query = raw
          .schema("resupply")
          .from("organizations")
          .select("id,name,slug,status,created_at", { count: "exact" });
        if (operation.search)
          query = query.ilike("name", contains(operation.search));
        const result = await query
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(operation.offset, operation.offset + operation.limit - 1)
          .abortSignal(signal);
        data = {
          items: rows(organizationRow, result, operation.limit).map((row) => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            status: row.status,
            createdAt: row.created_at,
          })),
          total: exactCount(result),
          limit: operation.limit,
          offset: operation.offset,
        };
      } else if (operation.operation === "users.list") {
        let query = raw
          .schema("resupply_auth")
          .from("users")
          .select("id,email_lower,display_name,role,status,created_at", {
            count: "exact",
          })
          .in("role", [...staffRoles]);
        if (operation.search)
          query = query.ilike("email_lower", contains(operation.search));
        const result = await query
          .order("email_lower", { ascending: true })
          .order("id", { ascending: true })
          .range(operation.offset, operation.offset + operation.limit - 1)
          .abortSignal(signal);
        data = {
          items: rows(userRow, result, operation.limit).map((row) => ({
            id: row.id,
            email: row.email_lower,
            displayName: row.display_name,
            role: row.role,
            status: row.status,
            createdAt: row.created_at,
          })),
          total: exactCount(result),
          limit: operation.limit,
          offset: operation.offset,
        };
      } else if (operation.operation === "billing.overview") {
        const [totalResult, results] = await Promise.all([
          raw
            .schema("resupply")
            .from("tenant_billing_subscriptions")
            .select("id", { count: "exact", head: true })
            .abortSignal(signal),
          Promise.all(
            subscriptionStatuses.map(async (status) => {
              const result = await raw
                .schema("resupply")
                .from("tenant_billing_subscriptions")
                .select("id", { count: "exact", head: true })
                .eq("status", status)
                .abortSignal(signal);
              return { status, count: exactCount(result) };
            }),
          ),
        ]);
        // Independent exact total detects new status values and inconsistent
        // reads. These requests are not a transactional snapshot; fail closed
        // when concurrent changes make their totals disagree.
        const subscriptionCount = exactCount(totalResult);
        if (
          results.reduce((sum, row) => sum + row.count, 0) !== subscriptionCount
        )
          throw new CentralAdminError(503, "upstream");
        data = { source: SOURCE, subscriptionCount, statusCounts: results };
      } else {
        let query = raw
          .schema("resupply")
          .from("tenant_billing_subscriptions")
          .select(
            "id,org_id,status,stripe_status,stripe_customer_id,stripe_subscription_id,current_period_end,updated_at,organizations(name),billing_plans(code,name)",
            { count: "exact" },
          );
        if (operation.organizationId)
          query = query.eq("org_id", operation.organizationId);
        if (operation.search)
          query = query.ilike(
            "stripe_subscription_id",
            contains(operation.search),
          );
        const result = await query
          .order("updated_at", { ascending: false })
          .order("id", { ascending: true })
          .range(operation.offset, operation.offset + operation.limit - 1)
          .abortSignal(signal);
        data = {
          source: SOURCE,
          items: rows(subscriptionRow, result, operation.limit).map((row) => ({
            id: row.id,
            organizationId: row.org_id,
            organizationName: row.organizations?.name ?? null,
            planCode: row.billing_plans?.code ?? null,
            planName: row.billing_plans?.name ?? null,
            status: row.status,
            providerStatus: row.stripe_status,
            providerCustomerId: row.stripe_customer_id,
            providerSubscriptionId: row.stripe_subscription_id,
            currentPeriodEnd: row.current_period_end,
            updatedAt: row.updated_at,
          })),
          total: exactCount(result),
          limit: operation.limit,
          offset: operation.offset,
        };
      }
      const body = {
        contractVersion: 1,
        product: "breathe",
        operation: operation.operation,
        generatedAt: now().toISOString(),
        data,
      };
      if (Buffer.byteLength(JSON.stringify(body)) > 512000)
        throw new CentralAdminError(503, "upstream");
      return json(body);
    } catch (error) {
      // No token, native identity, row payload, or upstream error is logged or returned.
      return json(
        {
          error: {
            code: error instanceof CentralAdminError ? error.code : "upstream",
          },
        },
        error instanceof CentralAdminError ? error.status : 503,
      );
    }
  };
}
